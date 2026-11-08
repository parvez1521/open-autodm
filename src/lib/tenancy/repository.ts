/**
 * Programme 18 / Phase E — typed tenant repository over the service role.
 *
 * DECISION (see saas/PHASE_18_SERVICE_ROLE_GUARD_MATRIX.md for the full
 * justification): KEEP scopedDb's primitives, but do not ask every call
 * site to compose them by hand. scopedDb (Programme 16) provides the
 * correct atoms — tenantFilter / stampWorkspace / applyTenantScope /
 * assertRowInWorkspace — yet P17 verified it is imported by ZERO product
 * files: hand-composed primitives are forgettable, and a forgotten
 * `.eq('workspace_id', …)` on a service-role query is a silent
 * cross-tenant leak because the service role BYPASSES RLS. This module
 * wraps those exact primitives in a typed repository that makes misuse
 * structurally hard:
 *
 *   - The repository is BOUND to one WorkspaceContext at construction.
 *     There is no method that takes a workspace id, so a caller cannot
 *     widen scope by passing a different id.
 *   - Reads ALWAYS apply workspace scope (applyTenantScope). There is
 *     no unscoped list/query escape hatch on this object.
 *   - Single-row access exists ONLY as `getByIdInWorkspace`: it fetches
 *     by id and then runs assertRowInWorkspace BEFORE returning the
 *     row. A bare-id load-and-mutate without the assertion is not
 *     exposed — update/delete internally go through the same assertion
 *     before touching the row, and then STILL scope the mutation by
 *     (id AND workspace_id) as defence in depth.
 *   - Inserts ALWAYS merge stampWorkspace(ctx). A payload that tries
 *     to set a different workspace_id (including null — an unbind
 *     attempt) is REJECTED with 'cross-workspace-row' before any write.
 *     Updates reject a foreign workspace_id the same way, so a row can
 *     never be moved out of its workspace through this layer.
 *   - Writes are capability-gated: the repository is constructed with
 *     a capability ('read' | 'write'). Write methods on a read
 *     repository throw WorkspaceAccessError('insufficient-role').
 *     Viewer contexts can never obtain a write repository — a 'write'
 *     request for a viewer is downgraded to 'read' at construction
 *     (fail closed), mirroring canWrite in context.ts.
 *   - Only tables that actually carry workspace_id are reachable, via
 *     the TENANT_TABLES allowlist (migration …000032 + the
 *     instagram_accounts binding in …000026 + the mapping table in
 *     …000026). Platform tables (app_settings, profiles,
 *     data_deletion_requests, platform_config, and the per-workspace
 *     settings table from …000025) are NOT in the allowlist and
 *     `table()` throws for them.
 *
 * PLATFORM EXCEPTIONS STAY OUT. This repository is ONLY for
 * workspace-mode, user-facing paths (a resolved ctx exists). The
 * following keep their own guards and must NOT be routed through here:
 * Meta webhook/callback paths (HMAC / signed-state guarded, workspace
 * resolved from the account binding), cron paths (cron-secret
 * guarded), job/webhook processors (pair-validation guards in the
 * processing layer), platform-admin and billing-admin paths, setup,
 * and the GATED settings paths (app_settings / platform_config /
 * the per-workspace settings table — untouched by Programme 18).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  WorkspaceAccessError,
  canWrite,
  type WorkspaceContext,
} from './context';
import {
  tenantFilter,
  stampWorkspace,
  applyTenantScope,
  assertRowInWorkspace,
} from './scopedDb';
import { withTransientQueryRetry } from '../supabase/queryRetry';

// The repository is built ON scopedDb: re-export its primitives so
// callers of this layer see one surface, and so the usage pin can
// verify the layering.
export { tenantFilter, stampWorkspace, applyTenantScope, assertRowInWorkspace } from './scopedDb';

export type TenantCapability = 'read' | 'write';

/**
 * Tables reachable through the repository — every entry carries a
 * workspace_id column:
 *   - instagram_accounts: …000026 (nullable binding column)
 *   - workspace_instagram_accounts: …000026 (workspace_id is part of PK)
 *   - the remaining fourteen: …000032 §A
 * Deliberately EXCLUDED from …000032: debug_events, job_queue,
 * inbound_webhook_events, dm_rate_events — service-role-only system
 * tables with no user-facing workspace path (see matrix doc).
 */
export const TENANT_TABLES = [
  'automations',
  'contacts',
  'instagram_accounts',
  'workspace_instagram_accounts',
  'automation_sessions',
  'dm_logs',
  'dm_jobs',
  'dm_sent_log',
  'automation_follow_ups',
  'recipient_opt_outs',
  'ai_usage_log',
  'comment_traffic_events',
  'comment_traffic_incidents',
  'traffic_guard_notifications',
  'comment_private_reply_reservations',
  'comment_public_reply_reservations',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

export type TenantRow = Record<string, unknown> & {
  id?: string;
  workspace_id?: string | null;
};

export interface TenantTableAccessor {
  readonly table: TenantTable;
  /** All rows in the context workspace (optionally narrowed by eq filters). Never unscoped. */
  list(filters?: Record<string, unknown>): Promise<TenantRow[]>;
  /**
   * The ONLY single-row load: fetch by id + assertRowInWorkspace.
   * Returns null when no row with that id exists at all; throws
   * 'cross-workspace-row' for another workspace's row and
   * 'unbound-row' for a NULL-workspace row.
   */
  getByIdInWorkspace(id: string): Promise<TenantRow | null>;
  /** Insert with stampWorkspace(ctx) always merged. Rejects a foreign workspace_id in the payload. Write capability only. */
  insert(payload: TenantRow): Promise<TenantRow>;
  /** Assert-then-scoped update by (id AND workspace_id). Returns the fresh row, or null when the id does not exist. Write capability only. */
  updateById(id: string, patch: TenantRow): Promise<TenantRow | null>;
  /** Assert-then-scoped delete by (id AND workspace_id). Returns false when the id does not exist. Write capability only. */
  deleteById(id: string): Promise<boolean>;
}

export interface TenantRepository {
  readonly ctx: WorkspaceContext;
  readonly workspaceId: string;
  readonly capability: TenantCapability;
  table(name: TenantTable): TenantTableAccessor;
  readonly automations: TenantTableAccessor;
  readonly contacts: TenantTableAccessor;
  readonly instagramAccounts: TenantTableAccessor;
  readonly automationSessions: TenantTableAccessor;
  readonly dmLogs: TenantTableAccessor;
  readonly dmJobs: TenantTableAccessor;
  readonly dmSentLog: TenantTableAccessor;
  readonly automationFollowUps: TenantTableAccessor;
  readonly recipientOptOuts: TenantTableAccessor;
  readonly aiUsageLog: TenantTableAccessor;
  readonly commentTrafficIncidents: TenantTableAccessor;
  readonly trafficGuardNotifications: TenantTableAccessor;
}

function isTenantTable(name: string): name is TenantTable {
  return (TENANT_TABLES as readonly string[]).includes(name);
}

/** The capability a context may hold: viewers are read-only, always. */
export function capabilityForContext(ctx: WorkspaceContext): TenantCapability {
  return canWrite(ctx.role) ? 'write' : 'read';
}

function rejectForeignWorkspace(
  payload: TenantRow,
  ctx: WorkspaceContext,
): void {
  if (!('workspace_id' in payload) || payload.workspace_id === undefined) return;
  if (payload.workspace_id !== ctx.workspaceId) {
    throw new WorkspaceAccessError(
      'cross-workspace-row',
      'Payload workspace_id does not match the active workspace context; the write was rejected.',
    );
  }
}

export function createTenantRepository(
  db: SupabaseClient,
  ctx: WorkspaceContext,
  capability?: TenantCapability,
): TenantRepository {
  // Fail-closed capability resolution: an explicit 'read' always wins;
  // an explicit 'write' is honoured only when the role can write.
  const effectiveCapability: TenantCapability =
    capability === undefined
      ? capabilityForContext(ctx)
      : capability === 'write' && canWrite(ctx.role)
        ? 'write'
        : 'read';

  // Internal client view: the builder chains are used through `any`
  // for the same TS2589 reason documented in scopedDb.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = db as unknown as { from(table: string): any };

  function assertWrite(): void {
    if (effectiveCapability !== 'write') {
      throw new WorkspaceAccessError(
        'insufficient-role',
        `Role '${ctx.role}' holds a read-only tenant repository; writes are not permitted.`,
      );
    }
  }

  function makeAccessor(table: TenantTable): TenantTableAccessor {
    const accessor: TenantTableAccessor = {
      table,

      async list(filters: Record<string, unknown> = {}): Promise<TenantRow[]> {
        // Flakiness fix (2026-11-08, investigation fix-plan item 6):
        // ONE bounded retry on transient PostgREST errors. The
        // scoped selects behind the workspace list routes are
        // trivial; on free-tier staging an individual leg
        // intermittently returns a connection-class error under the
        // page-mount burst, and that single blip used to become the
        // route's 500. The query is rebuilt inside the thunk (a
        // supabase-js builder must never be awaited twice), and the
        // scope/filters are re-applied identically per attempt —
        // a retry can never widen or narrow the tenant scope.
        // Non-transient errors (auth, validation, integrity) are
        // never retried and propagate exactly as before.
        return withTransientQueryRetry(`tenant-repository:${table}:list`, async () => {
          let query = client.from(table).select('*');
          query = applyTenantScope(query, ctx);
          for (const [column, value] of Object.entries(filters)) {
            if (column === 'workspace_id') continue; // scope already applied; never re-filtered by callers
            query = query.eq(column, value);
          }
          const { data, error } = await query;
          if (error) throw error;
          return (data ?? []) as TenantRow[];
        });
      },

      async getByIdInWorkspace(id: string): Promise<TenantRow | null> {
        if (!id || id.trim().length === 0) {
          throw new WorkspaceAccessError(
            'unbound-row',
            'A row id is required for a workspace-scoped single-row load.',
          );
        }
        const { data, error } = await client
          .from(table)
          .select('*')
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        assertRowInWorkspace(data as TenantRow, ctx);
        return data as TenantRow;
      },

      async insert(payload: TenantRow): Promise<TenantRow> {
        assertWrite();
        rejectForeignWorkspace(payload, ctx);
        const stamped: TenantRow = { ...payload, ...stampWorkspace(ctx) };
        const { data, error } = await client.from(table).insert(stamped);
        if (error) throw error;
        return (data ?? stamped) as TenantRow;
      },

      async updateById(id: string, patch: TenantRow): Promise<TenantRow | null> {
        assertWrite();
        rejectForeignWorkspace(patch, ctx);
        // Assertion BEFORE mutation: a foreign/unbound row is never touched.
        const existing = await accessor.getByIdInWorkspace(id);
        if (!existing) return null;
        const clean: TenantRow = { ...patch };
        delete clean['id'];
        delete clean['workspace_id'];
        let query = client.from(table).update(clean);
        query = query.eq('id', id);
        query = applyTenantScope(query, ctx);
        const { error } = await query;
        if (error) throw error;
        return accessor.getByIdInWorkspace(id);
      },

      async deleteById(id: string): Promise<boolean> {
        assertWrite();
        // Assertion BEFORE mutation: a foreign/unbound row is never touched.
        const existing = await accessor.getByIdInWorkspace(id);
        if (!existing) return false;
        let query = client.from(table).delete();
        query = query.eq('id', id);
        query = applyTenantScope(query, ctx);
        const { error } = await query;
        if (error) throw error;
        return true;
      },
    };
    return accessor;
  }

  const accessors = new Map<TenantTable, TenantTableAccessor>();
  function table(name: TenantTable): TenantTableAccessor {
    if (!isTenantTable(name)) {
      throw new Error(
        `Table '${String(name)}' is not a tenant table and is not reachable through the tenant repository.`,
      );
    }
    let accessor = accessors.get(name);
    if (!accessor) {
      accessor = makeAccessor(name);
      accessors.set(name, accessor);
    }
    return accessor;
  }

  return {
    ctx,
    workspaceId: ctx.workspaceId,
    capability: effectiveCapability,
    table,
    automations: table('automations'),
    contacts: table('contacts'),
    instagramAccounts: table('instagram_accounts'),
    automationSessions: table('automation_sessions'),
    dmLogs: table('dm_logs'),
    dmJobs: table('dm_jobs'),
    dmSentLog: table('dm_sent_log'),
    automationFollowUps: table('automation_follow_ups'),
    recipientOptOuts: table('recipient_opt_outs'),
    aiUsageLog: table('ai_usage_log'),
    commentTrafficIncidents: table('comment_traffic_incidents'),
    trafficGuardNotifications: table('traffic_guard_notifications'),
  };
}
