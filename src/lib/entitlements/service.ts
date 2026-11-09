/**
 * Phase 13 — central SERVER-SIDE entitlement service.
 *
 * Location decision: `src/lib/entitlements/` (the alternative
 * `src/lib/tenancy/` holds the customer-journey state machine instead).
 *
 * Contract:
 *  - A workspace's plan is resolved from the billing catalogue
 *    (src/lib/billing/catalogue.ts) + its subscription state, using the
 *    Phase 12 lifecycle rule: ONLY `active` / `trialing` grant the paid
 *    plan's entitlements (lifecycle.ts `grantsEntitlement`).
 *  - Period lapse (Bug 1 fix, owner-approved 2026-11-09): a granting
 *    subscription whose recorded `currentPeriodEnd` is in the past
 *    resolves to Free with resolution 'free-default-period-ended'.
 *    Payments are one-time orders (no autopay), so the period end on
 *    the row IS the entitlement end; a renewal payment writes a later
 *    period end and the same row grants again. A missing/unparseable
 *    period end never strips a plan (no evidence of lapse ⇒ the
 *    stored status rules, exactly as before this fix).
 *  - Missing / unknown / unconfigured plan, and cancelled / expired /
 *    past_due / paused / incomplete subscriptions, all resolve to the
 *    **Free** plan — the limited default. Exactly ONE dimension is
 *    unlimited, by owner decision (2026-11-09): `dmsPerMonth` is
 *    `null` in the catalogue on EVERY plan (Free included), and a
 *    null limit always allows — DM volume never blocks a workspace.
 *    Every other dimension stays a plain numeric cap.
 *  - Every limit is read from catalogue.ts at call time, so changing a
 *    number in the catalogue changes enforcement with no code change.
 *  - Enforcement: `checkEntitlement` ALWAYS computes the decision
 *    ({ allowed, reason, limit, used, … }). When ENTITLEMENTS_ENFORCED
 *    is off (the default) the result is log-only: `enforced: false` and
 *    `effectiveAllowed: true` (pass-through) — but the computed
 *    `allowed` is still returned so callers/tests can see exactly what
 *    WOULD happen when the flag flips. When the flag is on,
 *    `effectiveAllowed === allowed`.
 *  - This is a server-side service. UI may DISPLAY its output; UI-only
 *    enforcement is prohibited by design (Phase 13 spec).
 *
 * Safety floor (Phase 11 §4): entitlement checks may only gate creating /
 * sending MORE. Callers must never gate opt-outs, data deletion, webhook
 * verification, or moderation on this service.
 */
import { getPlan, PLANS, type Plan, type PlanId, type SupportLevel } from '../billing/catalogue';
import { grantsEntitlement, isPeriodLapsed, type SubscriptionStatus } from '../billing/lifecycle';
import { readSaasFlags, type SaasFlags } from '../billing/flags';

/** Subscription state the service needs — mirrors the Phase 12/13 `subscriptions` row shape. */
export interface WorkspaceSubscription {
  workspaceId: string;
  /** Catalogue plan id. Unknown/missing values resolve to Free. */
  planId: string | null | undefined;
  status: SubscriptionStatus | null | undefined;
  /**
   * Recorded end of the current paid period (ISO string), when the
   * caller has it. A granting status past this instant resolves to
   * Free (period lapse — see the header). Omitted/null ⇒ no lapse
   * evidence, the stored status rules (pre-fix behaviour).
   */
  currentPeriodEnd?: string | null;
}

/** Every limit dimension the service can check. */
export type EntitlementDimension =
  | 'instagramAccounts'
  | 'activeAutomations'
  | 'dmsPerMonth'
  | 'aiDrafting'
  | 'scriptWriter'
  | 'teamSeats'
  | 'followUpsPerMonth'
  | 'contactsPerMonth'
  | 'workspaces';

/** Current usage for numeric checks, supplied by the caller (server-side counts). */
export interface UsageSnapshot {
  instagramAccounts?: number;
  activeAutomations?: number;
  dmsThisMonth?: number;
  aiDraftingThisMonth?: number;
  scriptWriterThisMonth?: number;
  teamSeatsUsed?: number;
  followUpsThisMonth?: number;
  contactsThisMonth?: number;
  workspacesOwned?: number;
}

export interface ResolvedEntitlement {
  plan: Plan;
  /** True when the subscription state actually grants this plan (active/trialing, or Free). */
  entitled: boolean;
  /** Why the plan resolved as it did — for logs/support, never secret. */
  resolution: 'active-subscription' | 'trialing-subscription' | 'free-default-no-subscription' | 'free-default-inactive-subscription' | 'free-default-unknown-plan' | 'free-default-period-ended';
  dataRetentionDays: number;
  supportLevel: SupportLevel;
}

export interface EntitlementCheckResult {
  dimension: EntitlementDimension;
  /** The computed decision — what enforcement WOULD do. */
  allowed: boolean;
  reason: 'within-limit' | 'at-limit' | 'over-limit';
  /** The plan's cap for this dimension — `null` when unlimited (DMs only). */
  limit: number | null;
  used: number;
  /** Plan the decision was computed against. */
  planId: PlanId;
  /** False in log-only mode (ENTITLEMENTS_ENFORCED off). */
  enforced: boolean;
  /**
   * What the caller must actually do: in log-only mode this is always
   * true (pass-through) even when `allowed` is false; when enforced it
   * equals `allowed`.
   */
  effectiveAllowed: boolean;
}

const FREE_PLAN: Plan = getPlan('free');

function isKnownPlanId(id: string | null | undefined): id is PlanId {
  return typeof id === 'string' && PLANS.some((p) => p.id === id);
}

/**
 * Resolve a workspace's effective plan. Pure and synchronous: pass the
 * subscription row (or null) and get the plan + qualitative tiers.
 * `now` is injectable for tests; production callers omit it.
 */
export function resolveEntitlement(
  sub: WorkspaceSubscription | null | undefined,
  now: Date = new Date(),
): ResolvedEntitlement {
  if (!sub || sub.planId == null || sub.status == null) {
    return { plan: FREE_PLAN, entitled: true, resolution: 'free-default-no-subscription', dataRetentionDays: FREE_PLAN.dataRetentionDays, supportLevel: FREE_PLAN.supportLevel };
  }
  if (!isKnownPlanId(sub.planId)) {
    return { plan: FREE_PLAN, entitled: true, resolution: 'free-default-unknown-plan', dataRetentionDays: FREE_PLAN.dataRetentionDays, supportLevel: FREE_PLAN.supportLevel };
  }
  const plan = getPlan(sub.planId);
  if (plan.id === 'free') {
    return { plan, entitled: true, resolution: 'active-subscription', dataRetentionDays: plan.dataRetentionDays, supportLevel: plan.supportLevel };
  }
  if (!grantsEntitlement(sub.status)) {
    // cancelled / expired / past_due / paused / incomplete ⇒ Free default.
    return { plan: FREE_PLAN, entitled: true, resolution: 'free-default-inactive-subscription', dataRetentionDays: FREE_PLAN.dataRetentionDays, supportLevel: FREE_PLAN.supportLevel };
  }
  if (isPeriodLapsed({ status: sub.status, currentPeriodEnd: sub.currentPeriodEnd ?? null }, now)) {
    // Bug 1 fix (2026-11-09): the paid period recorded on the row has
    // ended and no renewal has extended it ⇒ Free, however fresh the
    // stored `active` status looks.
    return { plan: FREE_PLAN, entitled: true, resolution: 'free-default-period-ended', dataRetentionDays: FREE_PLAN.dataRetentionDays, supportLevel: FREE_PLAN.supportLevel };
  }
  return {
    plan,
    entitled: true,
    resolution: sub.status === 'trialing' ? 'trialing-subscription' : 'active-subscription',
    dataRetentionDays: plan.dataRetentionDays,
    supportLevel: plan.supportLevel,
  };
}

function limitFor(plan: Plan, dimension: EntitlementDimension): number | null {
  switch (dimension) {
    case 'instagramAccounts': return plan.limits.instagramAccounts;
    case 'activeAutomations': return plan.limits.activeAutomations;
    case 'dmsPerMonth': return plan.limits.dmsPerMonth;
    case 'aiDrafting': return plan.limits.aiDraftingGenerationsPerMonth;
    case 'scriptWriter': return plan.limits.scriptWriterGenerationsPerMonth;
    case 'teamSeats': return plan.limits.teamSeats;
    case 'followUpsPerMonth': return plan.limits.followUpsPerMonth;
    case 'contactsPerMonth': return plan.limits.contactsPerMonth;
    case 'workspaces': return plan.limits.workspaces;
  }
}

function usedFor(usage: UsageSnapshot, dimension: EntitlementDimension): number {
  switch (dimension) {
    case 'instagramAccounts': return usage.instagramAccounts ?? 0;
    case 'activeAutomations': return usage.activeAutomations ?? 0;
    case 'dmsPerMonth': return usage.dmsThisMonth ?? 0;
    case 'aiDrafting': return usage.aiDraftingThisMonth ?? 0;
    case 'scriptWriter': return usage.scriptWriterThisMonth ?? 0;
    case 'teamSeats': return usage.teamSeatsUsed ?? 0;
    case 'followUpsPerMonth': return usage.followUpsThisMonth ?? 0;
    case 'contactsPerMonth': return usage.contactsThisMonth ?? 0;
    case 'workspaces': return usage.workspacesOwned ?? 0;
  }
}

/**
 * Check one dimension. `requested` is how many MORE units the caller wants
 * (default 1 — e.g. connecting one more IG account). Allowed when
 * used + requested <= limit. At exactly the limit with requested >= 1 the
 * reason is 'at-limit'; beyond it, 'over-limit'. A null limit (DMs) is
 * always allowed, whatever the usage.
 */
export function checkEntitlement(
  sub: WorkspaceSubscription | null | undefined,
  dimension: EntitlementDimension,
  usage: UsageSnapshot,
  opts: { requested?: number; flags?: SaasFlags; env?: Record<string, string | undefined>; now?: Date } = {},
): EntitlementCheckResult {
  const flags = opts.flags ?? readSaasFlags(opts.env ?? (typeof process !== 'undefined' ? process.env : {}));
  const resolved = resolveEntitlement(sub, opts.now);
  const limit = limitFor(resolved.plan, dimension);
  const used = usedFor(usage, dimension);
  const requested = opts.requested ?? 1;
  // Unlimited dimension (dmsPerMonth — null on every plan since the
  // owner's 2026-11-09 decision): no usage volume can block.
  const allowed = limit === null ? true : used + requested <= limit;
  const reason: EntitlementCheckResult['reason'] = allowed ? 'within-limit' : used >= (limit ?? 0) ? 'at-limit' : 'over-limit';
  const enforced = flags.entitlementsEnforced;
  return {
    dimension,
    allowed,
    reason,
    limit,
    used,
    planId: resolved.plan.id,
    enforced,
    effectiveAllowed: enforced ? allowed : true,
  };
}

/** Convenience: resolve + check every dimension at once (billing dashboard stub reads this). */
export function evaluateAllEntitlements(
  sub: WorkspaceSubscription | null | undefined,
  usage: UsageSnapshot,
  opts: { flags?: SaasFlags; env?: Record<string, string | undefined>; now?: Date } = {},
): { resolved: ResolvedEntitlement; checks: EntitlementCheckResult[] } {
  const dimensions: EntitlementDimension[] = [
    'instagramAccounts', 'activeAutomations', 'dmsPerMonth', 'aiDrafting',
    'scriptWriter', 'teamSeats', 'followUpsPerMonth', 'contactsPerMonth', 'workspaces',
  ];
  return {
    resolved: resolveEntitlement(sub, opts.now),
    checks: dimensions.map((d) => checkEntitlement(sub, d, usage, opts)),
  };
}
