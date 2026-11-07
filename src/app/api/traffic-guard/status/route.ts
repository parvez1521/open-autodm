import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { getAccountTrafficGuardStatus } from '@/lib/trafficGuard/tracker';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Status(request, user);
  }

  const url = new URL(request.url);
  const accountId = url.searchParams.get('accountId');

  if (!accountId) {
    return Response.json({ error: 'accountId query param is required' }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: account, error } = await db
    .from('instagram_accounts')
    .select('id, user_id')
    .eq('id', accountId)
    .single();

  if (error || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  if (account.user_id !== user.id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const status = await getAccountTrafficGuardStatus(accountId);
  if (!status) {
    return Response.json({ error: 'Failed to retrieve traffic guard status' }, { status: 500 });
  }

  return Response.json(status);
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Status is a READ: any workspace
// member incl. viewer. BOTH checks run before any status is read:
// (1) workspace membership (the resolution itself) and (2) account
// ownership in workspace terms — the account must be bound to the ctx
// workspace, verified through the repository's getByIdInWorkspace
// (foreign/unbound ⇒ 404).
async function p18Status(
  request: Request,
  user: { id: string },
): Promise<Response> {
  const url = new URL(request.url);
  const accountId = url.searchParams.get('accountId');
  if (!accountId) {
    return Response.json({ error: 'accountId query param is required' }, { status: 400 });
  }

  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0 ? header : url.searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  const repo = createTenantRepository(db, resolved.ctx, 'read');

  let account: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  try {
    account = await repo.instagramAccounts.getByIdInWorkspace(accountId);
  } catch {
    account = null;
  }
  if (!account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  const status = await getAccountTrafficGuardStatus(accountId);
  if (!status) {
    return Response.json({ error: 'Failed to retrieve traffic guard status' }, { status: 500 });
  }
  return Response.json(status);
}
