/**
 * DELETE /api/instagram/disconnect/:accountId - disconnect a connected account.
 *
 * Preserve-on-disconnect (owner decision 2026-11-15): disconnecting must
 * NOT delete the account's automations. The account row is kept and
 * soft-disconnected (is_active=false, disconnected_at set) and its ACTIVE
 * automations are auto-paused with paused_by_disconnect=true — the engine
 * already skips inactive accounts/automations, so nothing can fire while
 * the account is gone. Reconnecting the SAME Instagram account (matched
 * by instagram_user_id) reactivates exactly those automations (see the
 * OAuth callback). The old behaviour deleted the row and the FK
 * ON DELETE CASCADE wiped automations, jobs, logs and sessions.
 *
 * Deleting is still available per-automation from the automations list,
 * and a full data wipe stays with the data-deletion-request flow.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError, listMembershipsForUser } from '@/lib/tenancy/context';
import { pauseAutomationsForDisconnect } from '@/lib/automation/disconnectPreservation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:disconnect');

type RouteContext = { params: Promise<{ accountId: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Disconnect(request, user, context);
  }

  const { accountId } = await context.params;
  const db = createServiceClient();

  const { data: account, error: fetchError } = await db
    .from('instagram_accounts')
    .select('id, user_id, username, is_active')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .single();

  if (fetchError || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  // Idempotent: already soft-disconnected — the row stays and the
  // automations were already paused by the first disconnect. A second
  // call (e.g. a double-click) is a no-op, not an error.
  if (account.is_active === false) {
    return Response.json({ success: true, pausedAutomations: 0 });
  }

  // Pause the account's automations FIRST (only the ones currently
  // active — manually-paused ones keep their own state). If this fails
  // nothing is mutated: the account stays connected.
  let pausedIds: string[];
  try {
    pausedIds = await pauseAutomationsForDisconnect(db, accountId, { userId: user.id });
  } catch (err) {
    logger.error({ err, accountId }, 'Failed to pause automations for disconnect');
    return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }

  // Soft-disconnect: keep the row (FKs + automations survive) so a
  // reconnect of the same Instagram account can restore it in place.
  const { error: updateError } = await db
    .from('instagram_accounts')
    .update({ is_active: false, disconnected_at: new Date().toISOString() })
    .eq('id', accountId)
    .eq('user_id', user.id);

  if (updateError) {
    logger.error({ err: updateError, accountId }, 'Failed to disconnect account');
    return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }

  logger.info(
    { userId: user.id, username: account.username, pausedAutomations: pausedIds.length },
    'Instagram account disconnected - automations paused, not deleted',
  );
  return Response.json({ success: true, pausedAutomations: pausedIds.length });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Disconnect is ACCOUNT ADMINISTRATION:
// it requires the 'accountAdmin' capability (owner/admin — a member or
// viewer is denied with 403) AND the account bound to the ctx workspace
// (verified through the repository's getByIdInWorkspace; foreign or
// unbound ⇒ 404, zero mutation). The soft-disconnect itself goes through
// the repository's scoped updateById (is_active=false) after the
// account's automations are auto-paused — the row is never deleted, or
// the FK cascade would wipe the automations (preserve-on-disconnect,
// 2026-11-15).
//
// Bare-call default (2026-11-12, mirrors the connect route's fix): the
// Settings page's Disconnect button calls this route with NO selector,
// which used to fail closed with 'workspace-context-required' — the
// button could never work. When no selector is supplied, resolve the
// caller's default the documented routeContext way: list memberships,
// and only when there is exactly ONE, re-resolve it in full through
// resolveRouteWorkspaceContext (the membership + capability checks all
// still run). Zero or several memberships keep the fail-closed 400.
async function p18Disconnect(
  request: Request,
  user: { id: string },
  context: RouteContext,
): Promise<Response> {
  const { accountId } = await context.params;
  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  let selector =
    header && header.trim().length > 0
      ? header
      : new URL(request.url).searchParams.get('workspace');
  if (!selector) {
    // listMembershipsForUser fails closed to [] on any lookup error, so
    // a failed list lands on the same closed 400 as zero memberships.
    const memberships = await listMembershipsForUser(db, user.id);
    if (memberships.length === 1) {
      selector = memberships[0]!.workspaceId;
    }
  }
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  try {
    requireCapability(resolved.ctx, 'accountAdmin');
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return Response.json({ error: err.message, code: err.code }, { status: 403 });
    }
    return Response.json({ error: 'Workspace authorization failed' }, { status: 500 });
  }
  const repo = createTenantRepository(db, resolved.ctx, 'write');

  let account: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  try {
    account = await repo.instagramAccounts.getByIdInWorkspace(accountId);
  } catch {
    account = null;
  }
  if (!account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  try {
    // Preserve-on-disconnect (2026-11-15): pause the account's ACTIVE
    // automations first (the helper scopes by the globally-unique
    // account id, already verified in-workspace above), then
    // soft-disconnect the row through the repository — never delete it,
    // or the FK cascade would wipe the automations. A pause failure
    // leaves everything untouched.
    let pausedIds: string[];
    try {
      pausedIds = await pauseAutomationsForDisconnect(db, accountId);
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to pause automations for disconnect (workspace mode)');
      return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
    }
    const updated = await repo.instagramAccounts.updateById(accountId, {
      is_active: false,
      disconnected_at: new Date().toISOString(),
    });
    if (!updated) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
    logger.info(
      { userId: user.id, username: account['username'], pausedAutomations: pausedIds.length },
      'Instagram account disconnected (workspace mode) - automations paused, not deleted',
    );
    return Response.json({ success: true, pausedAutomations: pausedIds.length });
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return Response.json({ error: err.message, code: err.code }, { status: 403 });
    }
    logger.error({ err, accountId }, 'Failed to disconnect account (workspace mode)');
    return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }
}
