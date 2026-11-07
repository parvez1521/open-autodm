/**
 * GET /api/instagram/accounts - connected accounts with token + pause status.
 * The token itself is never returned.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { computeTokenStatus } from '@/lib/api/schemas';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:accounts');

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18ListAccounts(request, user);
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('instagram_accounts')
    .select('id, instagram_user_id, username, name, profile_picture_url, is_active, token_expires_at, paused_until, pause_reason, created_at')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to fetch Instagram accounts');
    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }

  const accounts = (data ?? []).map((account) => {
    const { status, daysRemaining } = computeTokenStatus(account.token_expires_at as string | null);
    const pausedUntil = account.paused_until as string | null;
    const isPaused = !!pausedUntil && new Date(pausedUntil).getTime() > Date.now();
    return {
      ...account,
      token_status: status,
      token_days_remaining: daysRemaining,
      is_paused: isPaused,
      paused_until: isPaused ? pausedUntil : null,
      pause_reason: isPaused ? (account.pause_reason as string | null) : null,
    };
  });

  return Response.json({ accounts });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Read: any workspace member incl.
// viewer. Lists ONLY the selected workspace's accounts, via the tenant
// repository's scoped instagramAccounts list. The response shape mirrors
// the legacy handler (connecting-user fields preserved as stored) and
// the access token is NEVER included — the repository row's token column
// is stripped before the response is built.
async function p18ListAccounts(
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

  let rows: Awaited<ReturnType<typeof repo.instagramAccounts.list>>;
  try {
    rows = await repo.instagramAccounts.list();
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Failed to fetch Instagram accounts (workspace mode)');
    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }

  const accounts = rows
    .filter((account) => account['is_active'] !== false)
    .sort((a, b) => String(b['created_at'] ?? '').localeCompare(String(a['created_at'] ?? '')))
    .map((account) => {
      const { status, daysRemaining } = computeTokenStatus(account['token_expires_at'] as string | null);
      const pausedUntil = account['paused_until'] as string | null;
      const isPaused = !!pausedUntil && new Date(pausedUntil).getTime() > Date.now();
      return {
        id: account['id'],
        instagram_user_id: account['instagram_user_id'],
        username: account['username'],
        name: account['name'],
        profile_picture_url: account['profile_picture_url'],
        is_active: account['is_active'],
        token_expires_at: account['token_expires_at'],
        paused_until: isPaused ? pausedUntil : null,
        pause_reason: isPaused ? (account['pause_reason'] as string | null) : null,
        created_at: account['created_at'],
        // Connecting-user fields, preserved as-is from the stored row.
        user_id: account['user_id'],
        connected_by_user_id: account['connected_by_user_id'],
        workspace_id: account['workspace_id'],
        token_status: status,
        token_days_remaining: daysRemaining,
        is_paused: isPaused,
      };
    });

  return Response.json({ accounts });
}
