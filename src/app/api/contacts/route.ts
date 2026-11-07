/**
 * GET /api/contacts - the automation-captured audience list.
 * Contacts are scoped to the authenticated user's connected accounts.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:contacts');

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18ListContacts(request, user);
  }

  const db = createServiceClient();

  // Resolve the user's accounts first, then fetch their contacts.
  const { data: accounts, error: accountsError } = await db
    .from('instagram_accounts')
    .select('id, username')
    .eq('user_id', user.id);

  if (accountsError) {
    logger.error({ err: accountsError, userId: user.id }, 'Failed to fetch accounts for contacts');
    return Response.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }

  const accountIds = (accounts ?? []).map((a) => a.id as string);
  if (accountIds.length === 0) {
    return Response.json({ contacts: [] });
  }

  // Optional per-account scoping. SECURITY: the requested id must be one of
  // the authenticated user's own accounts - anything else is a 404.
  const requestedAccountId = new URL(request.url).searchParams.get('accountId');
  let scopedIds = accountIds;
  if (requestedAccountId) {
    if (!accountIds.includes(requestedAccountId)) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
    scopedIds = [requestedAccountId];
  }

  const { data, error } = await db
    .from('contacts')
    .select(`
      id, instagram_account_id, audience_ig_user_id, username, follows_business,
      first_interaction_at, last_interaction_at, last_trigger_type, total_triggers,
      automations ( id, name )
    `)
    .in('instagram_account_id', scopedIds)
    .order('last_interaction_at', { ascending: false })
    .limit(500);

  if (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to fetch contacts');
    return Response.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }

  return Response.json({ contacts: data ?? [] });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Reads go through the tenant
// repository (contacts is a tenant table), so only rows stamped with
// ctx.workspaceId can surface. This route performs no RPC calls; where
// contact writes happen elsewhere (recordContactInteraction and friends,
// owned by the lib workstream), only server-derived values may be passed
// — a client workspace claim is never forwarded from here.
async function p18ListContacts(
  request: Request,
  user: { id: string },
): Promise<Response> {
  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0
      ? header
      : new URL(request.url).searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  const repo = createTenantRepository(db, resolved.ctx, 'read');

  const requestedAccountId = new URL(request.url).searchParams.get('accountId');
  if (requestedAccountId) {
    // The account must be bound to THIS workspace; foreign/unbound ⇒ 404.
    let account: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
    try {
      account = await repo.instagramAccounts.getByIdInWorkspace(requestedAccountId);
    } catch {
      account = null;
    }
    if (!account) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
  }

  try {
    const rows = await repo.contacts.list(
      requestedAccountId ? { instagram_account_id: requestedAccountId } : {},
    );
    const contacts = [...rows]
      .sort((a, b) =>
        String(b['last_interaction_at'] ?? '').localeCompare(String(a['last_interaction_at'] ?? '')),
      )
      .slice(0, 500);
    return Response.json({ contacts });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Failed to fetch contacts (workspace mode)');
    return Response.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }
}
