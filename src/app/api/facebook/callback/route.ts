/**
 * GET /api/facebook/callback - Facebook redirects here after Login consent.
 *
 * Flow (identity comes exclusively from the signed state JWT - CSRF-safe):
 *   verify state → code → short-lived USER token → long-lived user token
 *   → /me/accounts (every Page the user granted in the dialog) → per Page:
 *   AES-256-GCM encrypt Page token → ownership check → entitlement gate
 *   (new Pages only) → insert/update facebook_pages → subscribe the Page
 *   to webhook fields → redirect to /settings
 *
 * Differences from the Instagram callback (same file shape, FB semantics):
 *  - The token is a USER token; the stored token is the PAGE token from
 *    /me/accounts. Page tokens obtained via a long-lived user token do
 *    NOT expire, so token_expires_at stays NULL (no 60-day refresh loop).
 *  - The dialog can grant SEVERAL Pages at once; each is connected in
 *    turn. A Page that fails its ownership/gate check is SKIPPED and
 *    counted (facebook_skipped=N) instead of failing the whole callback
 *    — one bad Page must not strand the good ones.
 *  - Entitlement: Pages count toward the SAME 'instagramAccounts'
 *    dimension as Instagram accounts (the "connected accounts" slot —
 *    the gate's usage is IG count + FB count). The owner's forever-free
 *    comp bypasses the gate, exactly like Instagram.
 *  - No workspace_instagram_accounts mapping: the facebook_pages
 *    workspace_id column IS the binding.
 *  - Preserve-on-disconnect: reconnecting the SAME Page (matched by
 *    facebook_page_id) reactivates exactly the automations its
 *    disconnect paused.
 */

import { getMetaSettings } from '@/lib/settings';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyOAuthState } from '@/lib/instagram/oauth';
import {
  exchangeFacebookCodeForToken,
  exchangeFacebookForLongLivedToken,
  listManagedFacebookPages,
} from '@/lib/facebook/oauth';
import { subscribePageToWebhookFields } from '@/lib/facebook/api';
import { encrypt } from '@/lib/crypto';
import { getAppUrl, getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { reactivateFacebookAutomationsAfterReconnect } from '@/lib/automation/disconnectPreservation';
import { resolveWorkspaceContext, requireWorkspaceRole } from '@/lib/tenancy/context';
import {
  evaluateEntitlementGate,
  countUserInstagramAccounts,
  countWorkspaceInstagramAccounts,
  countUserFacebookPages,
  countWorkspaceFacebookPages,
} from '@/lib/entitlements/guard';
import { resolveBillingWorkspace } from '@/lib/billing/access';
import { isOwnerFree } from '@/lib/owner';
import type { FbPageAccount } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const logger = createLogger('facebook-oauth-callback');

export async function GET(request: Request): Promise<Response> {
  const appUrl = getAppUrl(request);
  const settingsRedirect = (params: string): Response =>
    Response.redirect(`${appUrl}/settings?${params}`, 302);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');
  const fbError = url.searchParams.get('error');

  if (fbError) {
    logger.warn({ fbError }, 'User denied Facebook authorization');
    return settingsRedirect('facebook_error=access_denied');
  }
  if (!code || !stateToken) {
    return settingsRedirect('facebook_error=invalid_callback');
  }

  let userId: string;
  let workspaceId: string | undefined;
  try {
    ({ userId, workspaceId } = await verifyOAuthState(stateToken));
  } catch {
    logger.warn({}, 'Facebook OAuth state JWT verification failed');
    return settingsRedirect('facebook_error=state_mismatch');
  }

  if (workspaceId) {
    try {
      const ctx = await resolveWorkspaceContext(createServiceClient(), userId, workspaceId);
      requireWorkspaceRole(ctx, ['owner', 'admin']);
    } catch {
      logger.warn({ userId, workspaceId }, 'Facebook OAuth callback rejected - caller is not owner/admin of the state workspace');
      return settingsRedirect('facebook_error=workspace_not_authorized');
    }
  }

  const settings = await getMetaSettings();
  if (!settings) {
    return settingsRedirect('facebook_error=setup_required');
  }

  try {
    const redirectUri = `${appUrl}/api/facebook/callback`;

    debugLog('oauth', 'info', 'fb_oauth_exchange', 'processing', 'Exchanging Facebook authorization code for tokens', { userId });
    // The Facebook app secret is the Meta app secret: use the dedicated
    // FB secret when the Setup Wizard filled it, else the IG app secret
    // (same Meta app, one secret — the webhook route already accepts
    // either for verification).
    const fbAppSecret = settings.metaFbAppSecret ?? settings.metaAppSecret;
    const shortLived = await exchangeFacebookCodeForToken(code, settings.metaAppId, fbAppSecret, redirectUri);
    const longLived = await exchangeFacebookForLongLivedToken(shortLived.access_token, settings.metaAppId, fbAppSecret);
    const pages = await listManagedFacebookPages(longLived.access_token);

    if (pages.length === 0) {
      logger.warn({ userId }, 'Facebook Login granted no Pages - user may administer none');
      return settingsRedirect('facebook_error=no_pages');
    }

    const env = getEnv();
    const db = createServiceClient();

    // Guarantee the FK target exists (same backfill as the IG callback).
    await db.from('profiles').upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });

    let connected = 0;
    let skipped = 0;

    for (const page of pages) {
      const result = await connectOnePage(db, {
        userId,
        workspaceId,
        page,
        envTokenKey: env.TOKEN_ENCRYPTION_KEY,
      });
      if (result === 'connected') connected += 1;
      else skipped += 1;
    }

    if (connected === 0) {
      return settingsRedirect('facebook_error=account_already_connected');
    }
    const params = [`facebook_connected=${connected}`];
    if (skipped > 0) params.push(`facebook_skipped=${skipped}`);
    return settingsRedirect(params.join('&'));
  } catch (err) {
    const message = describeError(err);
    logger.error({ err, userId }, 'Facebook OAuth callback failed');
    debugLog('oauth', 'error', 'fb_oauth_failed', 'error', `Facebook OAuth exchange failed: ${message.slice(0, 300)}`, { userId });
    return settingsRedirect('facebook_error=server_error');
  }
}

/**
 * Connects (or refreshes) ONE Page from /me/accounts. Returns whether the
 * Page ended up connected; every rejection path is a skip, never a throw
 * (the caller counts skips so one bad Page cannot strand the rest).
 */
async function connectOnePage(
  db: ReturnType<typeof createServiceClient>,
  args: {
    userId: string;
    workspaceId: string | undefined;
    page: FbPageAccount;
    envTokenKey: string;
  }
): Promise<'connected' | 'skipped'> {
  const { userId, workspaceId, page, envTokenKey } = args;
  const pageMetaId = page.id;
  const pageName = page.name;

  // Ownership check BEFORE any write. If this Page is already connected
  // to a DIFFERENT user, reject it and write nothing.
  const { data: existingPage } = await db
    .from('facebook_pages')
    .select('id, user_id, workspace_id')
    .eq('facebook_page_id', pageMetaId)
    .maybeSingle();

  if (existingPage && (existingPage.user_id as string) !== userId) {
    logger.warn({ userId, pageMetaId, pageName }, 'Facebook connect rejected - Page already connected to another user');
    debugLog('oauth', 'warn', 'fb_oauth_rejected', 'error',
      `Connect rejected for Page ${pageName} - already connected to another user on this instance`, { userId });
    return 'skipped';
  }

  // Foreign-workspace binding is rejected exactly like a different user.
  if (existingPage && workspaceId) {
    const boundWorkspace =
      typeof existingPage.workspace_id === 'string' && existingPage.workspace_id.length > 0
        ? (existingPage.workspace_id as string)
        : null;
    if (boundWorkspace && boundWorkspace !== workspaceId) {
      logger.warn({ userId, pageMetaId, pageName, workspaceId }, 'Facebook connect rejected - Page already bound to another workspace');
      return 'skipped';
    }
  }

  // A BRAND-NEW Page binding consumes one connected-account slot, so it
  // is gated here — the one server point where a new Page is created.
  // Reconnects/refreshes are NEVER gated. The slot is the shared
  // 'instagramAccounts' dimension (IG count + FB count); the owner's
  // forever-free comp bypasses it.
  if (!existingPage) {
    let ownerFree = false;
    try {
      const { data: authUser } = await db.auth.admin.getUserById(userId);
      ownerFree = isOwnerFree({ id: userId, email: authUser?.user?.email });
    } catch {
      ownerFree = false;
    }
    const gate = await evaluateEntitlementGate(db, {
      dimension: 'instagramAccounts',
      ownerFree,
      resolveContext: async () => {
        if (workspaceId) {
          const [igCount, fbCount] = await Promise.all([
            countWorkspaceInstagramAccounts(db, workspaceId),
            countWorkspaceFacebookPages(db, workspaceId),
          ]);
          return { workspaceId, usage: { instagramAccounts: igCount + fbCount } };
        }
        const ws = await resolveBillingWorkspace(db, userId, null);
        const [igCount, fbCount] = await Promise.all([
          countUserInstagramAccounts(db, userId),
          countUserFacebookPages(db, userId),
        ]);
        return {
          workspaceId: ws.ok ? ws.ctx.workspaceId : null,
          usage: { instagramAccounts: igCount + fbCount },
        };
      },
    });
    if (gate.blocked) {
      logger.warn(
        { userId, pageMetaId, pageName, workspaceId: workspaceId ?? null, planId: gate.check?.planId, limit: gate.check?.limit },
        'Facebook connect rejected - plan connected-account limit reached'
      );
      debugLog('oauth', 'warn', 'fb_oauth_rejected', 'error',
        `Connect rejected for Page ${pageName} - plan connected-account limit reached`, { userId });
      return 'skipped';
    }
  }

  const encryptedToken = encrypt(page.access_token, envTokenKey);
  const pictureUrl = page.picture?.data?.url ?? null;
  const pageRow = {
    user_id: userId,
    facebook_page_id: pageMetaId,
    name: pageName,
    username: page.username ?? null,
    profile_picture_url: pictureUrl,
    access_token_encrypted: encryptedToken,
    // Page tokens from a long-lived user token do not expire.
    token_expires_at: null,
    is_active: true,
    disconnected_at: null,
    paused_until: null,
    pause_reason: null,
    ...(workspaceId ? { workspace_id: workspaceId, connected_by_user_id: userId } : {}),
  };

  let connectedPageId: string | null = null;

  if (existingPage) {
    const { error } = await db
      .from('facebook_pages')
      .update(pageRow)
      .eq('id', existingPage.id as string);
    if (error) {
      logger.error({ err: error, userId, pageMetaId }, 'Failed to refresh Facebook Page row');
      return 'skipped';
    }
    connectedPageId = existingPage.id as string;
  } else {
    const { data: inserted, error } = await db
      .from('facebook_pages')
      .insert(pageRow)
      .select('id')
      .single();
    if (error) {
      if (error.code !== '23505') {
        logger.error({ err: error, userId, pageMetaId }, 'Failed to insert Facebook Page row');
        return 'skipped';
      }
      // Lost a race with a concurrent connect of the same Page.
      const { data: racedPage } = await db
        .from('facebook_pages')
        .select('id, user_id, workspace_id')
        .eq('facebook_page_id', pageMetaId)
        .maybeSingle();
      if (!racedPage || (racedPage.user_id as string) !== userId) {
        return 'skipped';
      }
      if (
        workspaceId &&
        typeof racedPage.workspace_id === 'string' &&
        racedPage.workspace_id.length > 0 &&
        racedPage.workspace_id !== workspaceId
      ) {
        return 'skipped';
      }
      const { error: retryError } = await db
        .from('facebook_pages')
        .update(pageRow)
        .eq('id', racedPage.id as string);
      if (retryError) {
        logger.error({ err: retryError, userId, pageMetaId }, 'Failed to refresh raced Facebook Page row');
        return 'skipped';
      }
      connectedPageId = racedPage.id as string;
    } else {
      connectedPageId = (inserted?.id as string | undefined) ?? null;
    }
  }

  // Preserve-on-disconnect: reconnecting the SAME Page reactivates
  // exactly the automations its disconnect paused. A failure here must
  // NOT fail the connect — the Page IS connected.
  if (connectedPageId) {
    try {
      const reactivated = await reactivateFacebookAutomationsAfterReconnect(db, connectedPageId);
      if (reactivated.length > 0) {
        logger.info({ userId, pageName, reactivatedAutomations: reactivated.length }, 'Automations reactivated after Facebook reconnect');
      }
    } catch (reactivateErr) {
      logger.error({ err: reactivateErr, userId, pageName }, 'Failed to reactivate automations after Facebook reconnect');
    }
  }

  // Per-Page webhook subscription - without this NO events are delivered.
  // A subscription failure must NOT fail the connect (same hardening as
  // the IG callback): the Page IS connected; the subscription can be
  // repaired from Settings (resubscribe).
  try {
    await subscribePageToWebhookFields(pageMetaId, page.access_token);
  } catch (subErr) {
    logger.warn({ err: subErr, userId, pageName }, 'Page connected but webhook field subscription failed; connect continues');
    debugLog('oauth', 'warn', 'fb_webhook_subscribe_failed', 'error', `Webhook subscription failed after connect for Page ${pageName}`, {
      userId,
      ...(workspaceId ? { workspaceId } : {}),
    });
  }

  debugLog('oauth', 'info', 'fb_oauth_complete', 'ok', `Facebook Page ${pageName} connected`, {
    userId,
    ...(workspaceId ? { workspaceId } : {}),
  });
  logger.info({ userId, pageName }, 'Facebook Page connected');
  return 'connected';
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
