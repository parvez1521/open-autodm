/**
 * Programme 18 / Phase C — the ONE server-side workspace-context
 * resolution pattern for routes in workspace mode.
 *
 * Every workspace-mode route resolves its context through
 * `resolveRouteWorkspaceContext` — never by calling
 * resolveWorkspaceContext ad hoc, never by trusting a client-supplied
 * workspace id, and never by caching a context across requests.
 *
 * Contract (fail-closed throughout):
 *
 *   - FRESH RESOLUTION PER REQUEST. There is no caching across
 *     requests — no module-level memo, no cookie-carried role, no
 *     session-carried context. Every request re-resolves against
 *     workspace_memberships, so a revocation or role change is
 *     effective on the NEXT request BECAUSE every request re-resolves.
 *     (P17 verified the underlying resolver has no caching either:
 *     revocation is effective at the next resolve.)
 *   - CLIENT ID IS A SELECTOR, NEVER PROOF. The requested workspace id
 *     only selects WHICH membership row to look up. Access exists only
 *     when that row exists (see context.ts). A well-formed id for a
 *     workspace the caller does not belong to fails exactly like a
 *     garbage id.
 *   - NO DEFAULT WORKSPACE. A missing/blank selector in workspace mode
 *     is a FAILURE result (code 'workspace-context-required'), never a
 *     fallback to a first/only/default workspace — even when the user
 *     belongs to exactly one workspace. Routes that want a default must
 *     obtain it explicitly via listUserWorkspaces and re-resolve.
 *   - ANY ERROR ⇒ NO CONTEXT. resolveWorkspaceContext signals expected
 *     failures with WorkspaceAccessError, but a transport-level database
 *     throw propagates RAW out of it (P17-verified). This wrapper is the
 *     boundary that normalises BOTH into the same fail-closed result
 *     type: `{ ok: false, status, code }`. It never throws for a
 *     resolution failure and never returns a context on error.
 *
 * Result shape mirrors the codebase's existing gate helpers
 * (assertBillingRouteEnabled / assertWorkspaceRouteEnabled return
 * `{ ok: true } | { ok: false, status, reason }` discriminated unions)
 * and the status posture of the Instagram connect/callback routes,
 * which treat every workspace-authorization failure as closed
 * with no partial success: here `code` carries the stable
 * WorkspaceAccessError code so JSON routes can branch on it.
 *
 * Status mapping:
 *   workspace-context-required → 400 (the request named no workspace)
 *   not-a-member               → 403
 *   insufficient-role          → 403
 *   cross-workspace-row        → 403
 *   unbound-row                → 403
 *   anything else (incl. raw transport throws)
 *                              → 500, code 'workspace-resolution-failed'
 *
 * Capability mapping for requireCapability (P18 contract):
 *   'write'         → canWrite         (owner / admin / member)
 *   'manageMembers' → canManageMembers (owner / admin)
 *   'manageBilling' → canManageBilling (owner)
 *   'accountAdmin'  → owner / admin — the ELEVATED role required for
 *                     Instagram account administration (connect,
 *                     reconnect, disconnect, rebind). This is the same
 *                     owner/admin gate the connect/callback routes
 *                     already enforce via
 *                     requireWorkspaceRole(ctx, ['owner', 'admin']);
 *                     'accountAdmin' names that gate so account routes
 *                     do not each re-derive the role list.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveWorkspaceContext,
  listMembershipsForUser,
  WorkspaceAccessError,
  canWrite,
  canManageMembers,
  canManageBilling,
  type WorkspaceContext,
  type WorkspaceRole,
  type UserWorkspaceMembership,
} from './context';

export type { WorkspaceContext, WorkspaceRole, UserWorkspaceMembership };

/** Discriminated result of a route workspace resolution. */
export type RouteWorkspaceResult =
  | { ok: true; ctx: WorkspaceContext }
  | { ok: false; status: number; code: string; message: string };

export type RouteCapability = 'write' | 'manageMembers' | 'manageBilling' | 'accountAdmin';

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  'workspace-context-required': 400,
  'not-a-member': 403,
  'insufficient-role': 403,
  'cross-workspace-row': 403,
  'unbound-row': 403,
};

function failureFromError(err: unknown): RouteWorkspaceResult {
  if (err instanceof WorkspaceAccessError) {
    return {
      ok: false,
      status: STATUS_BY_CODE[err.code] ?? 403,
      code: err.code,
      message: err.message,
    };
  }
  // Raw transport throws (and anything unexpected) still fail closed.
  // The original message is deliberately NOT leaked to the caller-facing
  // result beyond a generic description; no context is ever issued.
  return {
    ok: false,
    status: 500,
    code: 'workspace-resolution-failed',
    message: 'Workspace resolution failed; no workspace context was issued.',
  };
}

function userIdOf(user: string | { id: string } | null | undefined): string {
  if (typeof user === 'string') return user;
  if (user && typeof user.id === 'string') return user.id;
  return '';
}

/**
 * Resolve the workspace context for one route request.
 *
 * @param db       Service-role (memberships-capable) Supabase client.
 * @param user     The ALREADY-authenticated user — either their id
 *                 string or the `{ id }` user object the auth layer
 *                 returned. Authentication itself is the caller's job
 *                 (routes keep returning 401 before calling this);
 *                 this function only proves workspace membership.
 * @param requestedWorkspaceId  Client-supplied SELECTOR (query param,
 *                 header, or body field). Never proof on its own.
 *
 * Never throws for a resolution failure; never returns a context on
 * error; never selects a default workspace when the selector is
 * missing.
 */
export async function resolveRouteWorkspaceContext(
  db: SupabaseClient,
  user: string | { id: string },
  requestedWorkspaceId: string | null | undefined,
): Promise<RouteWorkspaceResult> {
  try {
    const ctx = await resolveWorkspaceContext(db, userIdOf(user), requestedWorkspaceId);
    return { ok: true, ctx };
  } catch (err) {
    return failureFromError(err);
  }
}

/**
 * List the workspaces the user actually belongs to (selector UI data).
 *
 * Returns membership rows ONLY for this user — it queries
 * workspace_memberships filtered by user_id and can therefore never
 * enumerate workspaces the user is not a member of. Rows with an
 * unrecognized role are dropped (fail closed, mirroring
 * resolveWorkspaceContext). Any lookup failure — including a raw
 * transport throw — returns an empty list rather than partial or
 * guessed data.
 */
export async function listUserWorkspaces(
  db: SupabaseClient,
  userId: string,
): Promise<UserWorkspaceMembership[]> {
  // Delegates to context.ts listMembershipsForUser: membership-table
  // reads stay centralised in the module the §5 security pin already
  // enumerates as a reader, rather than spreading to new files.
  return listMembershipsForUser(db, userId);
}

/**
 * Gate an operation on a named capability of the resolved context.
 *
 * @throws {WorkspaceAccessError} code 'insufficient-role' when the
 *   context's role does not carry the capability. (Unlike
 *   resolveRouteWorkspaceContext this THROWS, matching
 *   requireWorkspaceRole in context.ts: capability checks happen after
 *   a context exists, inside the route's own try/catch posture.)
 */
export function requireCapability(ctx: WorkspaceContext, capability: RouteCapability): void {
  const allowed =
    capability === 'write'
      ? canWrite(ctx.role)
      : capability === 'manageMembers'
        ? canManageMembers(ctx.role)
        : capability === 'manageBilling'
          ? canManageBilling(ctx.role)
          : // 'accountAdmin' — owner/admin (see header mapping).
            ctx.role === 'owner' || ctx.role === 'admin';
  if (!allowed) {
    throw new WorkspaceAccessError(
      'insufficient-role',
      `Role '${ctx.role}' does not carry the '${capability}' capability.`,
    );
  }
}

/** Non-throwing companion to requireCapability. */
export function hasCapability(ctx: WorkspaceContext, capability: RouteCapability): boolean {
  try {
    requireCapability(ctx, capability);
    return true;
  } catch {
    return false;
  }
}
