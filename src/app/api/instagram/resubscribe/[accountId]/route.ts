/**
 * POST /api/instagram/resubscribe/:accountId - re-run the per-account webhook
 * field subscription ("Fix Webhooks" button). Use when comments stop arriving.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { subscribeToWebhookFields, WEBHOOK_SUBSCRIBED_FIELDS } from '@/lib/instagram/api';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Resubscribe(request, user, context);
  }

  const { accountId } = await context.params;
  const db = createServiceClient();

  const { data: account, error: fetchError } = await db
    .from('instagram_accounts')
    .select('id, user_id, username, instagram_user_id, access_token_encrypted')
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

  const result = await subscribeToWebhookFields(account.instagram_user_id as string, accessToken);
  if (!result.ok) {
    return Response.json(
      { error: 'resubscription_failed', message: `Meta API error: ${result.body.slice(0, 300)}` },
      { status: 502 }
    );
  }

  return Response.json({ success: true, subscribedFields: WEBHOOK_SUBSCRIBED_FIELDS, meta: result.body });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Resubscribe is ACCOUNT
// ADMINISTRATION: 'accountAdmin' capability (owner/admin) AND the
// account bound to the ctx workspace (repository getByIdInWorkspace;
// foreign/unbound/inactive ⇒ 404, token never decrypted for such an
// account).
async function p18Resubscribe(
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

  const result = await subscribeToWebhookFields(account['instagram_user_id'] as string, accessToken);
  if (!result.ok) {
    return Response.json(
      { error: 'resubscription_failed', message: `Meta API error: ${result.body.slice(0, 300)}` },
      { status: 502 }
    );
  }

  return Response.json({ success: true, subscribedFields: WEBHOOK_SUBSCRIBED_FIELDS, meta: result.body });
}
