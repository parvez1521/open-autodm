/**
 * DELETE /api/instagram/disconnect/:accountId - remove a connected account.
 * Cascades to automations, jobs, logs, and sessions via FK ON DELETE CASCADE.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError, listMembershipsForUser } from '@/lib/tenancy/context';

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
    .select('id, user_id, username')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .single();

  if (fetchError || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  const { error: deleteError } = await db
    .from('instagram_accounts')
    .delete()
    .eq('id', accountId)
    .eq('user_id', user.id);

  if (deleteError) {
    logger.error({ err: deleteError, accountId }, 'Failed to disconnect account');
    return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }

  logger.info({ userId: user.id, username: account.username }, 'Instagram account disconnected');
  return Response.json({ success: true });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Disconnect is ACCOUNT ADMINISTRATION:
// it requires the 'accountAdmin' capability (owner/admin — a member or
// viewer is denied with 403) AND the account bound to the ctx workspace
// (verified through the repository's getByIdInWorkspace; foreign or
// unbound ⇒ 404, zero mutation). The delete itself goes through the
// repository's scoped deleteById.
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
    const deleted = await repo.instagramAccounts.deleteById(accountId);
    if (!deleted) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return Response.json({ error: err.message, code: err.code }, { status: 403 });
    }
    logger.error({ err, accountId }, 'Failed to disconnect account (workspace mode)');
    return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }

  logger.info({ userId: user.id, username: account['username'] }, 'Instagram account disconnected (workspace mode)');
  return Response.json({ success: true });
}
