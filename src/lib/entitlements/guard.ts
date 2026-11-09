/**
 * Entitlement enforcement wiring — Bug 2 fix (owner-approved
 * 2026-11-09; audit: public-readiness-audit.md Bug 2).
 *
 * The Phase 13 entitlement service (./service.ts) always COMPUTED
 * plan-limit decisions, but no mutation path consumed them, so plan
 * limits were display-only. This module is the bridge the mutation
 * routes call:
 *
 *   evaluateEntitlementGate(db, { dimension, resolveContext })
 *
 * Behaviour contract:
 *  - ENTITLEMENTS_ENFORCED off (the default): the gate is a pure
 *    pass-through. resolveContext is NEVER invoked and no database
 *    read happens, so routes behave byte-for-byte as they did before
 *    this wiring existed (the service's log-only mode).
 *  - Flag on: resolveContext supplies the workspace + CURRENT usage
 *    counts (server-side, counted by the caller at the mutation
 *    point); the gate loads the workspace's subscription row, reduces
 *    it to its EFFECTIVE state — trial lapse (billing/trial.ts) and
 *    period lapse (billing/lifecycle.ts, the Bug 1 fix) both applied,
 *    exactly as the billing status route reads it — and runs
 *    checkEntitlement. `blocked` is true only when the service's
 *    `effectiveAllowed` is false.
 *  - Errors from the subscription/usage reads PROPAGATE: an
 *    infrastructure failure surfaces through the calling route's
 *    normal error path instead of silently allowing an over-limit
 *    mutation (fail-closed, the codebase's authz posture).
 *
 * Safety floor (Phase 11 §4, unchanged): gates are only ever placed
 * on creating MORE — new Instagram account bindings, automation
 * creates, inactive→active transitions. Trial/workspace farming
 * fix (2026-11-09): the same gate now also covers workspace
 * CREATION (the `workspaces` dimension, usage = owned workspaces)
 * and adding a team member (invitation create + invitation accept,
 * the `teamSeats` dimension, usage = current members) — without it,
 * fresh workspaces were a free route around every plan limit.
 * Disconnects, deactivations, deletions and edits that consume no
 * new slot are never gated.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';
import { readSaasFlags } from '../billing/flags';
import { getPlan } from '../billing/catalogue';
import { getWorkspaceSubscription } from '../billing/persistence';
import { applyTrialLapse } from '../billing/trial';
import {
  checkEntitlement,
  type EntitlementCheckResult,
  type EntitlementDimension,
  type UsageSnapshot,
  type WorkspaceSubscription,
} from './service';

const logger = createLogger('entitlements:guard');

export interface EntitlementGate {
  /** True only when enforcement is ON and the service denies the mutation. */
  blocked: boolean;
  /** The computed check (null when the gate was not evaluated — flag off). */
  check: EntitlementCheckResult | null;
  /** Customer-readable refusal, set only when blocked. */
  message: string | null;
}

const PASS: EntitlementGate = { blocked: false, check: null, message: null };

const DIMENSION_LABELS: Partial<Record<EntitlementDimension, { singular: string; plural: string }>> = {
  instagramAccounts: { singular: 'Instagram account', plural: 'Instagram accounts' },
  activeAutomations: { singular: 'active automation', plural: 'active automations' },
  workspaces: { singular: 'workspace', plural: 'workspaces' },
  teamSeats: { singular: 'team seat', plural: 'team seats' },
};

/**
 * Evaluate one plan limit for a pending mutation. See the header for
 * the flag contract. `resolveContext` is a thunk so the (flag-off)
 * default path performs zero database work.
 */
export async function evaluateEntitlementGate(
  db: SupabaseClient,
  args: {
    dimension: EntitlementDimension;
    resolveContext: () => Promise<{ workspaceId: string | null; usage: UsageSnapshot }>;
    requested?: number;
    env?: Record<string, string | undefined>;
    now?: Date;
  },
): Promise<EntitlementGate> {
  const flags = readSaasFlags(args.env ?? process.env);
  if (!flags.entitlementsEnforced) return PASS;

  const { workspaceId, usage } = await args.resolveContext();
  const now = args.now ?? new Date();

  let sub: WorkspaceSubscription | null = null;
  if (workspaceId) {
    const row = await getWorkspaceSubscription(db, workspaceId);
    if (row) {
      // Effective state, read exactly as the billing status route
      // reads it: trial lapse applied here; the PERIOD lapse (Bug 1)
      // is left to the entitlement service itself, which receives the
      // row's period end and applies it at resolution.
      const view = applyTrialLapse(
        {
          planId: row.planId,
          status: row.status,
          trialEndsAt: row.trialEndsAt,
          currentPeriodEnd: row.currentPeriodEnd,
        },
        now,
      );
      sub = {
        workspaceId,
        planId: view?.planId ?? row.planId,
        // The table's 'free' default is not a lifecycle state; the
        // entitlement service reads null as "no granting state".
        status: view && view.status !== 'free' ? view.status : null,
        currentPeriodEnd: view?.currentPeriodEnd ?? row.currentPeriodEnd,
      };
    }
  }

  const check = checkEntitlement(sub, args.dimension, usage, {
    requested: args.requested ?? 1,
    flags,
    now,
  });
  if (check.effectiveAllowed) return { blocked: false, check, message: null };

  const labels = DIMENSION_LABELS[args.dimension];
  const label = labels ? (check.limit === 1 ? labels.singular : labels.plural) : args.dimension;
  const message =
    `Your ${getPlan(check.planId).name} plan includes up to ${check.limit} ${label}. ` +
    'Upgrade your plan to add more.';
  logger.info(
    { workspaceId, dimension: args.dimension, planId: check.planId, limit: check.limit, used: check.used },
    'Plan limit blocked a mutation (ENTITLEMENTS_ENFORCED on)',
  );
  return { blocked: true, check, message };
}

/** The JSON refusal for route handlers, in the billing family's { error, code } shape. */
export function planLimitResponse(gate: EntitlementGate): Response {
  return Response.json(
    {
      error: gate.message,
      code: 'PLAN_LIMIT_REACHED',
      dimension: gate.check?.dimension,
      planId: gate.check?.planId,
      limit: gate.check?.limit,
      used: gate.check?.used,
    },
    { status: 403 },
  );
}

// ── Usage counters (server-side counts at the mutation point) ───────
// Counts select only the id column; plan-scale data keeps them
// small. `is_active` matches how the product itself counts connected
// accounts / running automations everywhere else (list endpoints
// filter on it identically).

async function countActive(
  db: SupabaseClient,
  table: 'instagram_accounts' | 'automations',
  column: 'workspace_id' | 'user_id',
  value: string,
): Promise<number> {
  const { data, error } = await db
    .from(table)
    .select('id')
    .eq(column, value)
    .eq('is_active', true);
  if (error) throw new Error(`Failed to count ${table}: ${error.message}`);
  return (data ?? []).length;
}

export function countWorkspaceInstagramAccounts(db: SupabaseClient, workspaceId: string): Promise<number> {
  return countActive(db, 'instagram_accounts', 'workspace_id', workspaceId);
}
export function countUserInstagramAccounts(db: SupabaseClient, userId: string): Promise<number> {
  return countActive(db, 'instagram_accounts', 'user_id', userId);
}
export function countWorkspaceActiveAutomations(db: SupabaseClient, workspaceId: string): Promise<number> {
  return countActive(db, 'automations', 'workspace_id', workspaceId);
}

/**
 * Workspaces the user OWNS (role 'owner' memberships) — the usage
 * figure for the `workspaces` dimension when creating one more, and
 * the list the creation gate resolves its governing plan from.
 */
export async function listOwnedWorkspaceIds(db: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await db
    .from('workspace_memberships')
    .select('workspace_id')
    .eq('user_id', userId)
    .eq('role', 'owner');
  if (error) throw new Error(`Failed to list owned workspaces: ${error.message}`);
  return (data ?? [])
    .map((r) => (r as { workspace_id?: unknown }).workspace_id)
    .filter((v): v is string => typeof v === 'string');
}

/** Current members of a workspace — the usage figure for `teamSeats`. */
export async function countWorkspaceMembers(db: SupabaseClient, workspaceId: string): Promise<number> {
  const { data, error } = await db
    .from('workspace_memberships')
    .select('user_id')
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`Failed to count workspace members: ${error.message}`);
  return (data ?? []).length;
}
export function countUserActiveAutomations(db: SupabaseClient, userId: string): Promise<number> {
  return countActive(db, 'automations', 'user_id', userId);
}
