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
import { withTransientQueryRetry } from '@/lib/supabase/queryRetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:contacts');

export async function GET(request: Request): Promise<Response> {
  // Per-leg timing (flakiness fix, 2026-11-08, investigation
  // fix-plan item 6): auth / accounts / query durations in the logs.
  const requestStartedAt = Date.now();
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const authMs = Date.now() - requestStartedAt;
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18ListContacts(request, user, authMs);
  }

  const db = createServiceClient();

  // Resolve the user's accounts first, then fetch their contacts.
  // Flakiness fix (2026-11-08): each data leg carries ONE bounded
  // retry on transient PostgREST errors (lib/supabase/queryRetry);
  // builders are constructed fresh inside the thunks per attempt.
  const accountsStartedAt = Date.now();
  let accounts: { id: string }[] | null;
  try {
    accounts = await withTransientQueryRetry('api:contacts:accounts', async () => {
      const { data, error } = await db
        .from('instagram_accounts')
        .select('id, username')
        .eq('user_id', user.id);
      if (error) throw error;
      return data;
    });
  } catch (accountsError) {
    logger.error(
      { err: accountsError, userId: user.id, authMs, accountsMs: Date.now() - accountsStartedAt },
      'Failed to fetch accounts for contacts',
    );
    return Response.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }
  const accountsMs = Date.now() - accountsStartedAt;

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

  const queryStartedAt = Date.now();
  let data: unknown[] | null;
  try {
    data = await withTransientQueryRetry('api:contacts:list', async () => {
      const { data: rows, error } = await db
        .from('contacts')
        .select(`
          id, instagram_account_id, audience_ig_user_id, username, follows_business,
          first_interaction_at, last_interaction_at, last_trigger_type, total_triggers,
          automations ( id, name )
        `)
        .in('instagram_account_id', scopedIds)
        .order('last_interaction_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return rows;
    });
  } catch (error) {
    logger.error(
      { err: error, userId: user.id, authMs, accountsMs, queryMs: Date.now() - queryStartedAt },
      'Failed to fetch contacts',
    );
    return Response.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }
  logger.debug(
    { userId: user.id, authMs, accountsMs, queryMs: Date.now() - queryStartedAt },
    'Listed contacts',
  );

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
  authMs: number,
): Promise<Response> {
  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0
      ? header
      : new URL(request.url).searchParams.get('workspace');
  const resolveStartedAt = Date.now();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  const resolveMs = Date.now() - resolveStartedAt;
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

  // The bounded transient retry for this leg lives inside the
  // tenant repository's list (fix-plan item 6); timing is added here.
  const queryStartedAt = Date.now();
  try {
    const rows = await repo.contacts.list(
      requestedAccountId ? { instagram_account_id: requestedAccountId } : {},
    );
    const queryMs = Date.now() - queryStartedAt;
    const contacts = [...rows]
      .sort((a, b) =>
        String(b['last_interaction_at'] ?? '').localeCompare(String(a['last_interaction_at'] ?? '')),
      )
      .slice(0, 500);
    logger.debug(
      { userId: user.id, authMs, resolveMs, queryMs },
      'Listed contacts (workspace mode)',
    );
    return Response.json({ contacts });
  } catch (err) {
    logger.error(
      { err, userId: user.id, authMs, resolveMs, queryMs: Date.now() - queryStartedAt },
      'Failed to fetch contacts (workspace mode)',
    );
    return Response.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }
}
