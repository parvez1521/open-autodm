/**
 * POST /api/instagram/refresh/:accountId - silent long-lived token refresh.
 * Only works while the token is still valid; expired tokens require a full
 * OAuth reconnect.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { refreshLongLivedToken } from '@/lib/instagram/oauth';
import { decrypt, encrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { computeTokenStatus } from '@/lib/api/schemas';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:refresh');

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Refresh(request, user, context);
  }

  const { accountId } = await context.params;
  const db = createServiceClient();

  const { data: account, error: fetchError } = await db
    .from('instagram_accounts')
    .select('id, user_id, username, access_token_encrypted, token_expires_at')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single();

  if (fetchError || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  const { status } = computeTokenStatus(account.token_expires_at as string | null);
  if (status === 'expired') {
    return Response.json(
      { error: 'token_expired', message: 'Token has expired. Please reconnect your Instagram account.' },
      { status: 400 }
    );
  }

  const env = getEnv();
  let currentToken: string;
  try {
    currentToken = decrypt(account.access_token_encrypted as string, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    return Response.json({ error: 'Failed to refresh token' }, { status: 500 });
  }

  const result = await refreshLongLivedToken(currentToken);
  if ('error' in result) {
    logger.error({ accountId, status: result.status }, 'Token refresh API failed');
    if (result.error === 'invalid') {
      return Response.json(
        { error: 'token_invalid', message: 'Token is no longer valid. Please reconnect your Instagram account.' },
        { status: 400 }
      );
    }
    return Response.json({ error: 'Failed to refresh token' }, { status: 500 });
  }

  const newExpiresAt = new Date(Date.now() + result.expires_in * 1000);
  const { error: updateError } = await db
    .from('instagram_accounts')
    .update({
      access_token_encrypted: encrypt(result.access_token, env.TOKEN_ENCRYPTION_KEY),
      token_expires_at: newExpiresAt.toISOString(),
    })
    .eq('id', accountId)
    .eq('user_id', user.id);

  if (updateError) {
    logger.error({ err: updateError, accountId }, 'Failed to save refreshed token');
    return Response.json({ error: 'Failed to save refreshed token' }, { status: 500 });
  }

  return Response.json({
    success: true,
    token_expires_at: newExpiresAt.toISOString(),
    token_days_remaining: Math.floor(result.expires_in / 86400),
    token_status: 'ok',
  });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Token refresh is ACCOUNT
// ADMINISTRATION: 'accountAdmin' capability (owner/admin) AND the
// account bound to the ctx workspace (repository getByIdInWorkspace;
// foreign/unbound/inactive ⇒ 404, and the token is never decrypted for
// such an account). The refreshed token is saved through the
// repository's scoped updateById.
async function p18Refresh(
  request: Request,
  user: { id: string },
  context: RouteContext,
): Promise<Response> {
  const { accountId } = await context.params;
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
  if (!account || account['is_active'] === false) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  const { status } = computeTokenStatus(account['token_expires_at'] as string | null);
  if (status === 'expired') {
    return Response.json(
      { error: 'token_expired', message: 'Token has expired. Please reconnect your Instagram account.' },
      { status: 400 }
    );
  }

  const env = getEnv();
  let currentToken: string;
  try {
    currentToken = decrypt(account['access_token_encrypted'] as string, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    return Response.json({ error: 'Failed to refresh token' }, { status: 500 });
  }

  const result = await refreshLongLivedToken(currentToken);
  if ('error' in result) {
    logger.error({ accountId, status: result.status }, 'Token refresh API failed (workspace mode)');
    if (result.error === 'invalid') {
      return Response.json(
        { error: 'token_invalid', message: 'Token is no longer valid. Please reconnect your Instagram account.' },
        { status: 400 }
      );
    }
    return Response.json({ error: 'Failed to refresh token' }, { status: 500 });
  }

  const newExpiresAt = new Date(Date.now() + result.expires_in * 1000);
  try {
    const updated = await repo.instagramAccounts.updateById(accountId, {
      access_token_encrypted: encrypt(result.access_token, env.TOKEN_ENCRYPTION_KEY),
      token_expires_at: newExpiresAt.toISOString(),
    });
    if (!updated) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
  } catch (err) {
    logger.error({ err, accountId }, 'Failed to save refreshed token (workspace mode)');
    return Response.json({ error: 'Failed to save refreshed token' }, { status: 500 });
  }

  return Response.json({
    success: true,
    token_expires_at: newExpiresAt.toISOString(),
    token_days_remaining: Math.floor(result.expires_in / 86400),
    token_status: 'ok',
  });
}
