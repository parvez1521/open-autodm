/**
 * GET /api/instagram/callback - Instagram redirects here after consent.
 *
 * Flow (identity comes exclusively from the signed state JWT - CSRF-safe):
 *   verify state → code → short-lived token → long-lived token (60d)
 *   → fetch profile → AES-256-GCM encrypt token → ownership check
 *   → insert/update instagram_accounts → subscribe account to webhook
 *   fields → redirect to /settings
 *
 * WORKSPACE (Phase D1): when the signed state carries a workspaceId,
 * membership (owner/admin) is re-verified at callback time and the
 * account is bound to that workspace (instagram_accounts.workspace_id +
 * connected_by_user_id, plus the workspace_instagram_accounts mapping).
 * An account already bound to a DIFFERENT workspace is rejected like a
 * different user. Stateless (legacy) connects are unchanged.
 *
 * OWNERSHIP (security audit finding #7): an Instagram account belongs to
 * exactly ONE user on this instance (global UNIQUE on instagram_user_id).
 * The existing row is looked up BEFORE anything is written: if it belongs
 * to a different user the connect is rejected with
 * instagram_error=account_already_connected and NOTHING is written - a
 * blind upsert on the unique key would silently transfer the account (and,
 * via FK cascades, its automations/jobs/contacts) to the caller.
 */

import { getMetaSettings } from '@/lib/settings';
import { createServiceClient } from '@/lib/supabase/service';
import {
  verifyOAuthState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getInstagramProfile,
} from '@/lib/instagram/oauth';
import { subscribeToWebhookFields } from '@/lib/instagram/api';
import { encrypt } from '@/lib/crypto';
import { getAppUrl, getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { resolveWorkspaceContext, requireWorkspaceRole } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const logger = createLogger('oauth-callback');

export async function GET(request: Request): Promise<Response> {
  const appUrl = getAppUrl(request);
  const settingsRedirect = (params: string): Response =>
    Response.redirect(`${appUrl}/settings?${params}`, 302);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');
  const igError = url.searchParams.get('error');

  if (igError) {
    logger.warn({ igError }, 'User denied Instagram authorization');
    return settingsRedirect('instagram_error=access_denied');
  }
  if (!code || !stateToken) {
    return settingsRedirect('instagram_error=invalid_callback');
  }

  let userId: string;
  let workspaceId: string | undefined;
  try {
    ({ userId, workspaceId } = await verifyOAuthState(stateToken));
  } catch {
    logger.warn({}, 'OAuth state JWT verification failed');
    return settingsRedirect('instagram_error=state_mismatch');
  }

  // Phase D1: a workspace-carrying state is only an assertion. Re-verify
  // owner/admin membership server-side at callback time (membership may
  // have changed since connect was started) BEFORE any token exchange or
  // write; failure is closed and nothing is persisted.
  if (workspaceId) {
    try {
      const ctx = await resolveWorkspaceContext(createServiceClient(), userId, workspaceId);
      requireWorkspaceRole(ctx, ['owner', 'admin']);
    } catch {
      logger.warn({ userId, workspaceId }, 'OAuth callback rejected - caller is not owner/admin of the state workspace');
      return settingsRedirect('instagram_error=workspace_not_authorized');
    }
  }

  const settings = await getMetaSettings();
  if (!settings) {
    return settingsRedirect('instagram_error=setup_required');
  }

  try {
    const redirectUri = `${appUrl}/api/instagram/callback`;

    debugLog('oauth', 'info', 'oauth_exchange', 'processing', 'Exchanging authorization code for tokens', { userId });
    const shortLived = await exchangeCodeForToken(code, settings.metaAppId, settings.metaAppSecret, redirectUri);
    const longLived = await exchangeForLongLivedToken(shortLived.access_token, settings.metaAppSecret);
    const profile = await getInstagramProfile(longLived.access_token);

    const env = getEnv();
    const db = createServiceClient();
    const encryptedToken = encrypt(longLived.access_token, env.TOKEN_ENCRYPTION_KEY);
    const expiresAt = new Date(Date.now() + longLived.expires_in * 1000);

    // Ownership check BEFORE any write. If this IG account is already
    // connected to a DIFFERENT user, reject the connect and write nothing -
    // no account row, and automations/contacts are never touched.
    const { data: existingAccount } = await db
      .from('instagram_accounts')
      .select('id, user_id, workspace_id')
      .eq('instagram_user_id', profile.user_id)
      .maybeSingle();

    if (existingAccount && (existingAccount.user_id as string) !== userId) {
      logger.warn(
        { userId, username: profile.username },
        'Instagram connect rejected - account already connected to another user'
      );
      debugLog(
        'oauth',
        'warn',
        'oauth_rejected',
        'error',
        `Connect rejected for @${profile.username} - already connected to another user on this instance`,
        { userId }
      );
      return settingsRedirect('instagram_error=account_already_connected');
    }

    // Phase D1: the foreign-owner rule extends to workspaces. An account
    // bound to a DIFFERENT workspace (via its workspace_id column OR its
    // workspace_instagram_accounts mapping) is rejected exactly like a
    // different user; an account bound to the SAME workspace — or not
    // bound at all — proceeds (refresh in place / first binding).
    if (existingAccount && workspaceId) {
      const boundWorkspace =
        typeof existingAccount.workspace_id === 'string' && existingAccount.workspace_id.length > 0
          ? (existingAccount.workspace_id as string)
          : null;
      let mappingWorkspace: string | null = null;
      const { data: existingMapping } = await db
        .from('workspace_instagram_accounts')
        .select('workspace_id')
        .eq('instagram_account_id', existingAccount.id as string)
        .maybeSingle();
      if (existingMapping && typeof existingMapping.workspace_id === 'string') {
        mappingWorkspace = existingMapping.workspace_id as string;
      }
      if (
        (boundWorkspace && boundWorkspace !== workspaceId) ||
        (mappingWorkspace && mappingWorkspace !== workspaceId)
      ) {
        logger.warn(
          { userId, username: profile.username, workspaceId },
          'Instagram connect rejected - account already bound to another workspace'
        );
        debugLog(
          'oauth',
          'warn',
          'oauth_rejected',
          'error',
          `Connect rejected for @${profile.username} - already bound to another workspace`,
          { userId, workspaceId }
        );
        return settingsRedirect('instagram_error=account_already_connected');
      }
    }

    // Guarantee the FK target exists. Users created in the Supabase dashboard
    // BEFORE the migrations were applied have no profiles row (the auto-create
    // trigger didn't exist yet) - backfill it here so the account insert can
    // never hit a foreign-key violation.
    await db.from('profiles').upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });

    const accountRow = {
      user_id: userId,
      instagram_user_id: profile.user_id,
      username: profile.username,
      name: profile.name ?? null,
      profile_picture_url: profile.profile_picture_url ?? null,
      access_token_encrypted: encryptedToken,
      token_expires_at: expiresAt.toISOString(),
      is_active: true,
      paused_until: null,
      pause_reason: null,
      // Phase D1: workspace binding (…000026) is written ONLY for a
      // workspace-carrying state. The legacy row shape above is untouched
      // otherwise, so a plain reconnect never clears an existing binding.
      ...(workspaceId
        ? { workspace_id: workspaceId, connected_by_user_id: userId }
        : {}),
    };

    let connectedAccountId: string | null = null;

    if (existingAccount) {
      // Reconnect/refresh by the SAME owner - update tokens + profile in
      // place, addressed by row id so user_id can never be reassigned.
      const { error } = await db
        .from('instagram_accounts')
        .update(accountRow)
        .eq('id', existingAccount.id as string);
      if (error) throw error;
      connectedAccountId = existingAccount.id as string;
    } else {
      const { error } = await db.from('instagram_accounts').insert(accountRow);
      if (error) {
        if (error.code !== '23505') throw error;
        // Lost a race with a concurrent connect of the same IG account.
        // Re-read the winning row and apply the SAME ownership rule -
        // never blind-upsert over another user's row.
        const { data: racedAccount } = await db
          .from('instagram_accounts')
          .select('id, user_id, workspace_id')
          .eq('instagram_user_id', profile.user_id)
          .maybeSingle();
        if (!racedAccount || (racedAccount.user_id as string) !== userId) {
          return settingsRedirect('instagram_error=account_already_connected');
        }
        // The workspace foreign-binding rule applies to the winner too.
        if (
          workspaceId &&
          typeof racedAccount.workspace_id === 'string' &&
          racedAccount.workspace_id.length > 0 &&
          racedAccount.workspace_id !== workspaceId
        ) {
          return settingsRedirect('instagram_error=account_already_connected');
        }
        const { error: retryError } = await db
          .from('instagram_accounts')
          .update(accountRow)
          .eq('id', racedAccount.id as string);
        if (retryError) throw retryError;
        connectedAccountId = racedAccount.id as string;
      } else if (workspaceId) {
        // New row on a workspace connect: re-read its id for the mapping
        // below. (Legacy connects skip this — their flow is unchanged.)
        const { data: insertedAccount } = await db
          .from('instagram_accounts')
          .select('id')
          .eq('instagram_user_id', profile.user_id)
          .maybeSingle();
        connectedAccountId = (insertedAccount?.id as string | undefined) ?? null;
      }
    }

    // Phase D1: record the workspace ↔ account mapping (…000026).
    // Idempotent for same-workspace reconnects: an existing mapping for
    // THIS workspace is left as-is; the foreign-workspace case was
    // already rejected above, so an insert can only race a same-workspace
    // connect (23505 → already mapped, success).
    if (workspaceId && connectedAccountId) {
      const { data: mapping } = await db
        .from('workspace_instagram_accounts')
        .select('workspace_id')
        .eq('instagram_account_id', connectedAccountId)
        .maybeSingle();
      if (!mapping) {
        const { error: mappingError } = await db.from('workspace_instagram_accounts').insert({
          workspace_id: workspaceId,
          instagram_account_id: connectedAccountId,
          connected_by: userId,
        });
        if (mappingError && mappingError.code !== '23505') throw mappingError;
      }
    }

    // Per-account webhook subscription - without this NO events are delivered.
    await subscribeToWebhookFields(profile.user_id, longLived.access_token);

    debugLog('oauth', 'info', 'oauth_complete', 'ok', `Instagram @${profile.username} connected`, {
      userId,
      ...(workspaceId ? { workspaceId } : {}),
    });
    logger.info({ userId, username: profile.username }, 'Instagram account connected');
    return settingsRedirect('instagram_connected=true');
  } catch (err) {
    const message = describeError(err);
    logger.error({ err, userId }, 'Instagram OAuth callback failed');
    debugLog('oauth', 'error', 'oauth_failed', 'error', `OAuth exchange failed: ${message.slice(0, 300)}`, { userId });
    // While the Meta app is in Development mode, an Instagram account that
    // isn't an accepted tester fails the long-lived exchange with this error.
    if (message.includes('Unsupported request - method type: get')) {
      return settingsRedirect('instagram_error=test_user_required');
    }
    return settingsRedirect(`instagram_error=server_error&debug=${encodeURIComponent(message.slice(0, 200))}`);
  }
}

/**
 * Human-readable message from anything thrown - including Supabase/Postgrest
 * error objects, which are not Error instances and stringify to
 * "[object Object]" otherwise.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [e.message, e.details, e.code ? `(code ${e.code})` : null].filter(Boolean);
    if (parts.length) return parts.join(' - ');
    try {
      return JSON.stringify(err).slice(0, 300);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}
