/**
 * Phase C / Programme 16 — workspace-scoped data-access layer.
 *
 * The TS companion to migration …000032 (tenant data isolation). RLS is
 * the database boundary, but the application's dominant data path is the
 * service role, which BYPASSES RLS — so tenant scoping must also exist
 * in code. This module is that code-level contract for tenant paths:
 *
 *   - `tenantFilter(ctx)` / `stampWorkspace(ctx)` — the canonical
 *     `{ workspace_id }` fragment for reads and inserts.
 *   - `applyTenantScope(query, ctx)` — adds `.eq('workspace_id', …)` to
 *     any Supabase-like query builder (the real PostgREST builder in
 *     product code; the FakeSupabase builder in tests). Every tenant
 *     read/write on a scoped path goes through this, never a hand-typed
 *     filter that can drift or be forgotten on one branch.
 *   - `assertRowInWorkspace(row, ctx)` — fail-closed post-fetch guard
 *     for single rows (e.g. a row loaded by id before mutation):
 *       · row.workspace_id set and ≠ ctx.workspaceId
 *           → WorkspaceAccessError('cross-workspace-row')
 *       · row.workspace_id null/missing (or no row at all)
 *           → WorkspaceAccessError('unbound-row')
 *     An unbound row is NOT silently adopted into the caller's
 *     workspace: during the …000032 transition window, NULL-workspace
 *     rows belong to the legacy user_id paths, which do not use this
 *     layer. Tenant paths refuse them.
 *
 * Wiring this layer into the 33 createServiceClient call sites is
 * Phase D; the per-site guard each category needs is audited in
 * saas/PHASE_16_TENANT_ISOLATION_MATRIX.md. This file changes no
 * existing call site's behaviour.
 */

import { WorkspaceAccessError, type WorkspaceContext } from './context';

/**
 * The minimal query-builder surface this layer needs (`.eq` only).
 * The return type is deliberately `unknown`, not a generic self-type:
 * checking the real PostgREST builder's self-referential generics
 * against `eq(...): Q` trips TS2589 (excessively deep instantiation)
 * at call sites. Builders mutate and return themselves, so discarding
 * the return value here loses nothing.
 */
export interface EqQuery {
  eq(column: string, value: unknown): unknown;
}

/** Canonical read filter for a workspace context. */
export function tenantFilter(ctx: WorkspaceContext): { workspace_id: string } {
  return { workspace_id: ctx.workspaceId };
}

/** Canonical insert fragment: stamp new tenant rows with their workspace. */
export function stampWorkspace(ctx: WorkspaceContext): { workspace_id: string } {
  return { workspace_id: ctx.workspaceId };
}

/**
 * Scope a query builder to the context's workspace. Returns the builder
 * (builders are chainable/mutable in both the real client and the fake),
 * so callers can keep chaining: `applyTenantScope(db.from(t).select(), ctx).eq(...)`.
 */
export function applyTenantScope<Q>(query: Q, ctx: WorkspaceContext): Q {
  // Unconstrained generic on purpose: constraining Q to EqQuery makes
  // the compiler structurally instantiate the real PostgREST builder's
  // self-referential generics at every call site (TS2589). The runtime
  // contract is just `.eq(...)`; it is cast for internally.
  (query as EqQuery).eq('workspace_id', ctx.workspaceId);
  return query;
}

/**
 * Fail-closed ownership assertion for a single fetched row.
 *
 * @throws {WorkspaceAccessError} code 'cross-workspace-row' when the row
 *   carries a different workspace_id; code 'unbound-row' when the row is
 *   missing or its workspace_id is null/absent.
 */
export function assertRowInWorkspace(
  row: { workspace_id?: unknown } | null | undefined,
  ctx: WorkspaceContext,
): void {
  const workspaceId = row?.workspace_id;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new WorkspaceAccessError(
      'unbound-row',
      'Row is not bound to any workspace; tenant paths fail closed on unbound rows.',
    );
  }
  if (workspaceId !== ctx.workspaceId) {
    throw new WorkspaceAccessError(
      'cross-workspace-row',
      'Row belongs to a different workspace than the active context.',
    );
  }
}
