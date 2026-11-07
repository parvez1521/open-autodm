/**
 * Phase B / Programme 16 — server-side workspace-resolution and
 * authorization layer.
 *
 * This is the FIRST product code that resolves tenancy. Its contract
 * mirrors the fail-closed posture of src/lib/owner.ts and
 * src/lib/signupProtection.ts:
 *
 *   - A workspace context exists ONLY when a workspace_memberships row
 *     proves it. A client-supplied workspaceId is never trusted on its
 *     own — it is a lookup key, not evidence of access.
 *   - There is NO default workspace. A missing/blank workspaceId throws
 *     `workspace-context-required`; callers must fail closed, never fall
 *     back to a global/single-tenant view.
 *   - Authorization derives ONLY from the membership row's role (the
 *     database is the source of truth, per migration …000024) — never
 *     from user-editable metadata.
 *   - Instagram-account → workspace resolution reads the trusted
 *     server-side binding (instagram_accounts.workspace_id, migration
 *     …000026). An unbound account resolves to null, which callers MUST
 *     treat as fail-closed (no global fallback).
 *
 * Role capability table (Programme 16):
 *   role    read  write (canWrite)  manage members  manage billing
 *   owner   ✓     ✓                 ✓               ✓
 *   admin   ✓     ✓                 ✓               ✗
 *   member  ✓     ✓                 ✗               ✗
 *   viewer  ✓     ✗ (read-only)     ✗               ✗
 *
 * The `db` parameter is a Supabase-like client (the real
 * @supabase/supabase-js client in product code; the FakeSupabase harness
 * in tests). Only the `from().select().eq().maybeSingle()` surface is
 * used, matching the rest of the codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer'];

export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export type WorkspaceAccessErrorCode =
  | 'workspace-context-required'
  | 'not-a-member'
  | 'insufficient-role'
  // Phase C (scoped data access, src/lib/tenancy/scopedDb.ts): a row was
  // presented to a workspace-scoped path that does not belong to it.
  | 'cross-workspace-row'
  | 'unbound-row'
  // Programme 28 (§1b): a card-image storage write in workspace mode
  // was refused with an authentication/session error (classifier class
  // 'session-expired' in src/lib/storage/cardImages.ts); the save is
  // aborted WITHOUT any membership/role claim.
  | 'session-expired';

/** Authorization failure. `code` is stable for callers to branch on. */
export class WorkspaceAccessError extends Error {
  readonly code: WorkspaceAccessErrorCode;

  constructor(code: WorkspaceAccessErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceAccessError';
    this.code = code;
  }
}

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

interface MembershipRow {
  workspace_id?: unknown;
  user_id?: unknown;
  role?: unknown;
}

interface InstagramAccountRow {
  workspace_id?: unknown;
}

/**
 * Resolve the caller's workspace context from their membership row.
 *
 * @throws {WorkspaceAccessError} code 'workspace-context-required' when
 *   workspaceId is missing/blank (fail closed — no default workspace).
 * @throws {WorkspaceAccessError} code 'not-a-member' when no membership
 *   row exists for (workspaceId, userId), the row's role is unrecognized,
 *   or the lookup itself fails (fail closed on any doubt).
 */
export async function resolveWorkspaceContext(
  db: SupabaseClient,
  userId: string,
  workspaceId: string | null | undefined,
): Promise<WorkspaceContext> {
  if (!workspaceId || workspaceId.trim().length === 0) {
    throw new WorkspaceAccessError(
      'workspace-context-required',
      'A workspace context is required: no workspace was specified.',
    );
  }
  if (!userId || userId.trim().length === 0) {
    throw new WorkspaceAccessError('not-a-member', 'No authenticated user identity was supplied.');
  }

  const { data, error } = await db
    .from('workspace_memberships')
    .select('workspace_id, user_id, role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle<MembershipRow>();

  if (error || !data || !isWorkspaceRole(data.role)) {
    throw new WorkspaceAccessError('not-a-member', 'The user is not a member of this workspace.');
  }

  return {
    workspaceId: typeof data.workspace_id === 'string' ? data.workspace_id : workspaceId,
    userId,
    role: data.role,
  };
}

export interface UserWorkspaceMembership {
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * List the workspaces a user belongs to (Programme 18, Phase C —
 * selector-UI data for routeContext.listUserWorkspaces).
 *
 * This lives in context.ts deliberately: the memberships-table reader
 * inventory is pinned by tests/tenancy-security-matrix.test.ts §5, and
 * context.ts is one of its two enumerated readers — membership reads
 * stay centralised here rather than spreading to new files.
 *
 * Returns ONLY the given user's membership rows (the query is filtered
 * by user_id, so it can never enumerate other workspaces), with
 * unrecognized roles dropped. Fail-closed: any lookup failure —
 * including a raw transport throw — returns an empty list.
 */
export async function listMembershipsForUser(
  db: SupabaseClient,
  userId: string,
): Promise<UserWorkspaceMembership[]> {
  if (!userId || userId.trim().length === 0) return [];
  try {
    const { data, error } = await db
      .from('workspace_memberships')
      .select('workspace_id, role')
      .eq('user_id', userId);

    if (error || !Array.isArray(data)) return [];
    const out: UserWorkspaceMembership[] = [];
    for (const row of data as MembershipRow[]) {
      if (
        typeof row.workspace_id === 'string' &&
        row.workspace_id.length > 0 &&
        isWorkspaceRole(row.role)
      ) {
        out.push({ workspaceId: row.workspace_id, role: row.role });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Gate an operation on the context's role.
 *
 * @throws {WorkspaceAccessError} code 'insufficient-role' when ctx.role
 *   is not in `allowed`.
 */
export function requireWorkspaceRole(ctx: WorkspaceContext, allowed: readonly WorkspaceRole[]): void {
  if (!allowed.includes(ctx.role)) {
    throw new WorkspaceAccessError(
      'insufficient-role',
      `Role '${ctx.role}' is not permitted here; requires one of: ${allowed.join(', ')}.`,
    );
  }
}

/** Write access (create/update tenant content). Viewers are read-only. */
export function canWrite(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

/** Invite / role-change / remove members. */
export function canManageMembers(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Billing administration is owner-only. */
export function canManageBilling(role: WorkspaceRole): boolean {
  return role === 'owner';
}

/**
 * Resolve the workspace that owns an Instagram account, from the trusted
 * server-side binding (instagram_accounts.workspace_id).
 *
 * Returns null when the account does not exist, the lookup fails, or the
 * account is not bound to any workspace. Null is FAIL-CLOSED: callers
 * must refuse the operation, never fall back to a global context.
 * (Wiring this resolver into the automation paths is a later phase.)
 */
export async function resolveWorkspaceForAccount(
  db: SupabaseClient,
  instagramAccountId: string | null | undefined,
): Promise<string | null> {
  if (!instagramAccountId || instagramAccountId.trim().length === 0) return null;

  const { data, error } = await db
    .from('instagram_accounts')
    .select('workspace_id')
    .eq('id', instagramAccountId)
    .maybeSingle<InstagramAccountRow>();

  if (error || !data) return null;
  return typeof data.workspace_id === 'string' && data.workspace_id.length > 0
    ? data.workspace_id
    : null;
}
