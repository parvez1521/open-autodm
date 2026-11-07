/**
 * GET /api/instagram/subscription-status/:accountId - which webhook fields
 * Meta currently has subscribed for this account ("Check Status" button).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { getSubscribedFields } from '@/lib/instagram/api';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ accountId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18SubscriptionStatus(request, user, context);
  }

  const { accountId } = await context.params;
  const db = createServiceClient();

  const { data: account, error: fetchError } = await db
    .from('instagram_accounts')
    .select('id, user_id, instagram_user_id, access_token_encrypted')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single();

  if (fetchError || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(account.access_token_encrypted as string, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    return Response.json({ error: 'Failed to decrypt token' }, { status: 500 });
  }

  const result = await getSubscribedFields(account.instagram_user_id as string, accessToken);
  if (!result.ok) {
    return Response.json({ error: 'meta_api_error', message: result.raw.slice(0, 300) }, { status: 502 });
  }

  return Response.json({
    subscribedFields: result.fields,
    hasComments: result.fields.includes('comments'),
    hasMessages: result.fields.includes('messages'),
    raw: result.raw,
  });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// PD-3 (read/management split): the Phase B matrix grouped this status
// READ with subscription management (admin+). Phase D implements the
// conservative split recorded under PD-3: this read requires only
// workspace membership ('read' — any member incl. viewer) plus the
// account bound to the ctx workspace, while the management actions
// (disconnect / refresh / resubscribe) stay 'accountAdmin'. The account
// is verified through the repository's getByIdInWorkspace;
// foreign/unbound/inactive ⇒ 404 and the token is never decrypted for
// such an account.
async function p18SubscriptionStatus(
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
  const repo = createTenantRepository(db, resolved.ctx, 'read');

  let account: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  try {
    account = await repo.instagramAccounts.getByIdInWorkspace(accountId);
  } catch {
    account = null;
  }
  if (!account || account['is_active'] === false) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(account['access_token_encrypted'] as string, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    return Response.json({ error: 'Failed to decrypt token' }, { status: 500 });
  }

  const result = await getSubscribedFields(account['instagram_user_id'] as string, accessToken);
  if (!result.ok) {
    return Response.json({ error: 'meta_api_error', message: result.raw.slice(0, 300) }, { status: 502 });
  }

  return Response.json({
    subscribedFields: result.fields,
    hasComments: result.fields.includes('comments'),
    hasMessages: result.fields.includes('messages'),
    raw: result.raw,
  });
}
