/**
 * Facebook Page job processors — the Facebook twin of
 * src/lib/automation/processJob.ts (Instagram), linear pipeline only.
 *
 * processFacebookAutoDmJob      - opening DM (comment / DM keyword trigger)
 * processFacebookFollowUpDmJob  - follow-up after a reveal-button tap
 *
 * Control flow contract with the engine (same as processJob.ts):
 *  - return              → job completed or intentionally skipped
 *  - throw RateLimitDelay / RateLimitUnavailable → reschedule, no attempt counted
 *  - throw AccountOnPause → reschedule after the breaker closes
 *  - throw AccountPausedMetaError → engine pauses the Page + fails the job
 *  - throw NonRetryableMetaError → fail the job
 *  - throw AmbiguousDeliveryError → fail closed, never retry (send may have happened)
 *  - throw anything else → retry with backoff (max_attempts guard)
 *
 * DELIBERATE v1 DIFFERENCES from the Instagram pipeline:
 *  - NO flow-graph engine. Facebook automations never carry a flow_graph
 *    (the UI never creates one for FB); the linear pipeline below is the
 *    only path. A flow_graph on an FB automation is ignored.
 *  - NO Traffic Guard. That feature is Instagram-only (its columns do not
 *    exist on facebook_pages). The circuit breaker (paused_until) IS shared.
 *  - NO lead-form capture. lead_form responses are skipped with a debug
 *    log (the UI hides the lead-form response type for Facebook); the ask
 *    text is never sent without a capture behind it.
 *  - NO scheduled follow-ups. follow_up columns exist on the automation
 *    row but the UI hides the section for Facebook; nothing schedules them.
 *  - NO ask-to-follow gate. Facebook's profile API has no "follows the
 *    Page" signal, so require-follow is not offered for Facebook.
 *  - DEDUPE IS PER COMMENT, NOT PER USER. Instagram's "once per user per
 *    automation" rule is deliberately NOT applied to Facebook: a second
 *    comment by the same person CAN still trigger. The guarantee that IS
 *    kept is Meta's "one private reply per comment", enforced by a claim
 *    row in dm_sent_log (see claimComment below) + the migration's
 *    partial unique index uq_dm_sent_log_fb_event. The claim is inserted
 *    BEFORE any send (after every pre-send guard) and released (deleted)
 *    when a send fails before delivery, kept when delivery is ambiguous
 *    or permanently failed — the same disposition taxonomy as the
 *    Instagram reservation system (reservations.ts), minus the separate
 *    reservation tables.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog, type DebugLevel, type DebugStatus } from '@/lib/debugLog';
import { decrypt } from '@/lib/crypto';
import { getEnv, getAppUrl } from '@/lib/env';
import { trackLink, rewriteResponseLinks } from '@/lib/automation/linkTracking';
import { getTextLinkButtons, formatInlineLinkButtons } from '@/lib/automation/responseButtons';
import { renderTemplate } from '@/lib/automation/personalize';
import { isFacebookSuppressed } from '@/lib/automation/optOut';
import {
  recordFacebookContactInteraction,
  updateFacebookContactProfile,
} from '@/lib/automation/contacts';
import {
  sendFacebookMessage,
  sendFacebookLinkButtonMessage,
  sendFacebookCardMessage,
  replyToFacebookComment,
  getFacebookUserProfile,
  type FbRecipient,
} from '@/lib/facebook/api';
import {
  RateLimitDelay,
  RateLimitUnavailable,
  AccountOnPause,
  selectPublicReplyOption,
} from '@/lib/automation/processJob';
import {
  MetaApiError,
  AccountPausedMetaError,
  NonRetryableMetaError,
  AmbiguousDeliveryError,
  META_RATE_LIMIT_CODES,
} from '@/lib/instagram/errors';
import type { AutoDmJobPayload, AutomationRow, DMResponse, FacebookPageRow } from '@/lib/types';

const logger = createLogger('facebook-worker');

/** Meta's DM window: only message users who engaged within the last 24h. */
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/** Meta's private-reply window for a comment: 7 days from the comment. */
const FB_COMMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Hourly DM cap per Page (Meta hard limit is 200; 20-DM safety buffer). */
export const FB_DM_LIMIT_PER_HOUR = 180;

/** Fixed delay before retrying a job whose rate-limit decision was unavailable. */
export const FB_RATE_LIMIT_UNAVAILABLE_RETRY_MS = 60_000;

/** Randomized pre-send delay - automation that behaves like a human. */
const JITTER_MIN_MS = 2000;
const JITTER_MAX_MS = 5000;

function jitter(): Promise<void> {
  const ms = JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shorter humanized pause BETWEEN consecutive responses in one flow. */
function interMessageJitter(): Promise<void> {
  const ms = 1200 + Math.floor(Math.random() * 1300);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when a failed button-template send should be retried as plain text
 * with an inline link. Template rejections surface as parameter/permission
 * errors; a policy block (368) must propagate so the circuit breaker opens
 * instead of immediately re-hitting Meta. (Same rule as processJob.ts.)
 */
function shouldFallBackToInlineLink(err: unknown): err is MetaApiError {
  return err instanceof MetaApiError && !(err instanceof AccountPausedMetaError);
}

function trackingBaseUrl(): string | null {
  try {
    return getAppUrl();
  } catch {
    return null;
  }
}

// ── Page circuit breaker ────────────────────────────────────────────────────

/** Circuit breaker: skip sends while the Page is paused. */
function assertPageNotPaused(page: FacebookPageRow): void {
  if (page.paused_until && new Date(page.paused_until).getTime() > Date.now()) {
    debugLog('worker', 'warn', 'fb_circuit_breaker', 'skipped',
      `Page ${page.name} is paused until ${page.paused_until} (${page.pause_reason ?? 'policy block'})`,
      { facebookPageId: page.id, pausedUntil: page.paused_until, userId: page.user_id });
    throw new AccountOnPause(new Date(page.paused_until).getTime());
  }
}

/** Opens the circuit breaker: pause all sends for this Page (24h default). */
export async function pauseFacebookPage(pageId: string, reason: string, hours = 24): Promise<void> {
  const db = createServiceClient();
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  const { data: pausedRow } = await db
    .from('facebook_pages')
    .update({ paused_until: until, pause_reason: reason.slice(0, 500) })
    .eq('id', pageId)
    .select('user_id')
    .maybeSingle();
  debugLog('worker', 'error', 'fb_circuit_breaker', 'error',
    `CIRCUIT BREAKER OPENED - Facebook Page paused for ${hours}h: ${reason}`,
    { facebookPageId: pageId, pausedUntil: until, userId: (pausedRow?.user_id as string | undefined) ?? null });
}

// ── Rate limit (fail closed, mirrors processJob.checkRateLimit) ─────────────

/**
 * The FB limiter RPC is the ONLY source of the rate-limit decision.
 * Unknown (RPC error / throw / empty result) throws RateLimitUnavailable:
 * no send happens, the engine reschedules without counting an attempt.
 */
async function checkFbRateLimit(db: SupabaseClient, pageId: string, userId: string | null = null): Promise<void> {
  let data: unknown = null;
  let error: { message: string } | null = null;
  try {
    const result = await db.rpc('check_and_record_fb_dm_rate_limit', {
      p_page_id: pageId,
      p_limit: FB_DM_LIMIT_PER_HOUR,
    });
    data = result.data;
    error = result.error;
  } catch (err) {
    logger.error({ err, facebookPageId: pageId }, 'FB rate limiter RPC threw - failing closed, delaying send');
    debugLog('worker', 'warn', 'fb_rate_limit_check', 'skipped',
      'FB rate limiter unavailable (RPC threw) - delaying send, failing closed',
      { facebookPageId: pageId, userId });
    throw new RateLimitUnavailable(FB_RATE_LIMIT_UNAVAILABLE_RETRY_MS);
  }
  if (error) {
    logger.error({ err: error, facebookPageId: pageId }, 'FB rate limiter RPC error - failing closed, delaying send');
    debugLog('worker', 'warn', 'fb_rate_limit_check', 'skipped',
      'FB rate limiter unavailable (RPC error) - delaying send, failing closed',
      { facebookPageId: pageId, userId });
    throw new RateLimitUnavailable(FB_RATE_LIMIT_UNAVAILABLE_RETRY_MS);
  }
  const row = (data as Array<{ allowed: boolean; current_count: number; retry_after_seconds: number }> | null)?.[0];
  if (!row || typeof row.allowed !== 'boolean') {
    logger.error({ facebookPageId: pageId }, 'FB rate limiter RPC returned no usable row - failing closed, delaying send');
    debugLog('worker', 'warn', 'fb_rate_limit_check', 'skipped',
      'FB rate limiter unavailable (empty/malformed result) - delaying send, failing closed',
      { facebookPageId: pageId, userId });
    throw new RateLimitUnavailable(FB_RATE_LIMIT_UNAVAILABLE_RETRY_MS);
  }
  if (!row.allowed) {
    debugLog('worker', 'warn', 'fb_rate_limit_check', 'skipped',
      `FB rate limit reached (${row.current_count}/${FB_DM_LIMIT_PER_HOUR}/h) - delaying ${Math.ceil(row.retry_after_seconds / 60)}min`,
      { facebookPageId: pageId, currentCount: row.current_count, userId });
    throw new RateLimitDelay(row.retry_after_seconds * 1000, row.current_count);
  }
  debugLog('worker', 'info', 'fb_rate_limit_check', 'ok',
    `FB rate limit OK - ${row.current_count}/${FB_DM_LIMIT_PER_HOUR} this hour`,
    { facebookPageId: pageId, userId });
}

/**
 * Truthful rate accounting: each flow reserves ONE window slot up front, but
 * a flow can deliver several messages. Record the extras so the next jobs
 * see the real send count and throttle correctly (fire-and-forget).
 */
function recordExtraFbSends(pageId: string, extraCount: number, workspaceId?: string | null): void {
  if (extraCount <= 0) return;
  void (async (): Promise<void> => {
    try {
      const db = createServiceClient();
      await db.from('dm_rate_events').insert(
        Array.from({ length: extraCount }, () => ({
          facebook_page_id: pageId,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
        }))
      );
    } catch (err) {
      logger.warn({ err, facebookPageId: pageId, extraCount }, 'Failed to record extra FB rate events');
    }
  })();
}

// ── dm_jobs status (Facebook twin of processJob.markJobStatus) ──────────────

type JobStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'skipped';

/** Upserts the dm_jobs row for a Facebook job (facebook_page_id, never IG). */
export async function markFbJobStatus(
  db: SupabaseClient,
  payload: AutoDmJobPayload,
  status: JobStatus,
  errorMessage: string | null,
  sentAt?: Date
): Promise<void> {
  let derivedWorkspaceId: string | null = null;
  try {
    const { data } = await db
      .from('facebook_pages')
      .select('workspace_id')
      .eq('id', payload.instagramAccountId)
      .maybeSingle();
    const ws = (data as { workspace_id?: string | null } | null)?.workspace_id;
    derivedWorkspaceId = typeof ws === 'string' && ws.length > 0 ? ws : null;
  } catch {
    derivedWorkspaceId = null;
  }
  const { error } = await db.from('dm_jobs').upsert(
    {
      automation_id: payload.automationId,
      facebook_page_id: payload.instagramAccountId,
      trigger_type: payload.triggerType,
      trigger_user_id: payload.triggerUserId,
      trigger_event_id: payload.triggerEventId,
      trigger_timestamp: new Date(payload.triggerTimestamp).toISOString(),
      status,
      error_message: errorMessage,
      sent_at: sentAt?.toISOString() ?? null,
      ...(derivedWorkspaceId ? { workspace_id: derivedWorkspaceId } : {}),
    },
    { onConflict: 'automation_id,trigger_event_id', ignoreDuplicates: false }
  );
  if (error) logger.warn({ err: error, status }, 'Failed to upsert FB dm_job status');
}

// ── One-private-reply-per-comment claim ─────────────────────────────────────

/**
 * Claims (automation, comment) in dm_sent_log BEFORE any send. The
 * migration's partial unique index uq_dm_sent_log_fb_event makes the
 * claim atomic across automations: a second automation (or a retried
 * job) hitting the same comment gets a conflict and skips. Returns the
 * claim row id, or null when the comment was already claimed.
 *
 * The claim row doubles as the send log (created_at ≈ send time). It is
 * deleted only when a send fails BEFORE delivery (release); kept when
 * delivery is ambiguous or permanently failed (fail closed — the comment
 * must never be re-attempted blindly).
 */
async function claimComment(
  db: SupabaseClient,
  payload: AutoDmJobPayload,
  workspaceId: string | null
): Promise<string | null> {
  const { data, error } = await db
    .from('dm_sent_log')
    .insert({
      facebook_page_id: payload.instagramAccountId,
      automation_id: payload.automationId,
      trigger_user_id: payload.triggerUserId,
      trigger_event_id: payload.triggerEventId,
      // Scopes the uq_dm_sent_log_fb_event claim index: 'comment' claims
      // are cross-automation (one private reply per comment), 'dm' claims
      // are per-automation only (two automations may both answer one DM).
      trigger_type: payload.triggerType,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    })
    .select('id')
    .maybeSingle();
  if (error) {
    // Any unique violation (same automation+comment, or another automation
    // already claimed this comment) lands here when ON CONFLICT is absent
    // — but this insert has no ON CONFLICT clause, so a 23505 means the
    // claim lost the race. Anything else is a real DB error: fail closed.
    if (error.code === '23505') return null;
    logger.error({ err: error }, 'FB dm_sent_log claim insert failed');
    throw new Error('Failed to claim comment for private reply');
  }
  return (data?.id as string | undefined) ?? null;
}

async function releaseClaim(db: SupabaseClient, claimId: string): Promise<void> {
  const { error } = await db.from('dm_sent_log').delete().eq('id', claimId);
  if (error) logger.warn({ err: error, claimId }, 'Failed to release FB comment claim');
}

// ── Response sending ────────────────────────────────────────────────────────

/** Sends a single configured response (text w/ optional link button, or card). */
async function sendOneFacebookResponse(
  pageMetaId: string,
  recipient: FbRecipient,
  audienceId: string,
  response: DMResponse,
  username: string | null | undefined,
  accessToken: string
): Promise<void> {
  if (response.type === 'card') {
    // Cards cannot be private replies — they always go to the user id.
    const cardImageUrl = response.cardImage?.startsWith('http') ? response.cardImage : undefined;
    await sendFacebookCardMessage(pageMetaId, audienceId, accessToken, {
      title: response.cardTitle ?? response.content,
      ...(cardImageUrl !== undefined ? { imageUrl: cardImageUrl } : {}),
      ...(response.cardSubtitle !== undefined ? { subtitle: response.cardSubtitle } : {}),
      ...(response.cardButtons !== undefined
        ? { buttons: response.cardButtons.map((b) => ({ title: b.title, url: b.link })) }
        : {}),
    });
    return;
  }

  const messageText = renderTemplate(response.content.trim(), username);
  // Link buttons (2026-11-22): up to 2 per text response, resolved by
  // getTextLinkButtons (prefers `buttons`, falls back to the legacy
  // buttonTitle/buttonLink). The button template takes up to 3.
  const buttons = getTextLinkButtons(response);
  if (buttons.length > 0) {
    try {
      await sendFacebookLinkButtonMessage(
        pageMetaId,
        recipient,
        messageText,
        buttons.map((b) => ({ title: b.title, url: b.link })),
        accessToken,
      );
    } catch (buttonErr) {
      if (!shouldFallBackToInlineLink(buttonErr)) throw buttonErr;
      await sendFacebookMessage(pageMetaId, recipient, `${messageText}\n\n${formatInlineLinkButtons(buttons)}`, accessToken);
    }
  } else {
    await sendFacebookMessage(pageMetaId, recipient, messageText, accessToken);
  }
}

/**
 * Best-effort sequential delivery of configured responses for the 1-step
 * flow (no reveal button). Per-response failures are logged and skipped —
 * the opening DM already went out, so a retry could never resend it.
 * lead_form responses are skipped (no Facebook lead capture in v1).
 */
async function deliverFacebookResponsesBestEffort(
  payload: AutoDmJobPayload,
  responses: DMResponse[],
  accessToken: string,
  userId: string | null = null
): Promise<number> {
  const db = createServiceClient();
  const baseUrl = trackingBaseUrl();
  let trackedResponses = responses;
  if (baseUrl) {
    trackedResponses = await rewriteResponseLinks(db, {
      automationId: payload.automationId,
      instagramAccountId: payload.instagramAccountId,
      facebookPageId: payload.instagramAccountId,
      responses,
      appUrl: baseUrl,
    });
  }
  let sent = 0;
  for (const [idx, response] of trackedResponses.entries()) {
    if (response.type === 'lead_form') {
      debugLog('worker', 'warn', 'fb_responses_send', 'skipped',
        `Response ${idx + 1} is a lead form - no Facebook lead capture in v1, skipped`, {
          responseIndex: idx + 1,
          userId,
        });
      continue;
    }
    if (!response.content?.trim() && response.type !== 'card') continue;
    if (sent > 0) await interMessageJitter();
    try {
      const recipient: FbRecipient =
        payload.triggerType === 'comment' && payload.triggerEventId && response.type !== 'card'
          ? { commentId: payload.triggerEventId }
          : { id: payload.triggerUserId };
      await sendOneFacebookResponse(
        payload.igAccountIgsid,
        recipient,
        payload.triggerUserId,
        response,
        payload.triggerUsername,
        accessToken
      );
      sent += 1;
      debugLog('worker', 'info', 'fb_responses_send', 'ok', `Response ${idx + 1}/${responses.length} sent (1-step flow)`, {
        responseIndex: idx + 1,
        type: response.type,
        userId,
      });
    } catch (err) {
      if (err instanceof AccountPausedMetaError) throw err; // circuit breaker must still open
      debugLog('worker', 'warn', 'fb_responses_send', 'error',
        `Response ${idx + 1}/${responses.length} failed (1-step flow, skipped): ${err instanceof Error ? err.message : String(err)}`,
        { responseIndex: idx + 1, userId });
    }
  }
  return sent;
}

// ═══════════════════════════════════════════════════════════════════════════
// Opening DM processor
// ═══════════════════════════════════════════════════════════════════════════

export async function processFacebookAutoDmJob(payload: AutoDmJobPayload, attempt: number): Promise<void> {
  const db = createServiceClient();
  const env = getEnv();

  // Owner of the connected Page - scopes every debug event this job writes.
  const { data: ownerRow } = await db
    .from('facebook_pages')
    .select('user_id, workspace_id')
    .eq('id', payload.instagramAccountId)
    .maybeSingle();
  const ownerUserId = (ownerRow?.user_id as string | undefined) ?? null;
  let resolvedWorkspaceId: string | null = null;
  const logEvent = (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata: Record<string, unknown> = {}
  ): void =>
    debugLog('worker', level, eventType, status, message, {
      ...metadata,
      userId: ownerUserId,
      ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
    });

  // ── 0: Workspace validation (fail closed — same rule as processJob) ──────
  const actualWorkspaceId =
    typeof ownerRow?.workspace_id === 'string' && (ownerRow.workspace_id as string).length > 0
      ? (ownerRow.workspace_id as string)
      : null;
  if (payload.workspaceId && payload.workspaceId !== actualWorkspaceId) {
    resolvedWorkspaceId = payload.workspaceId;
    logEvent('error', 'tenant_context_mismatch', 'error',
      'FB job payload workspace does not match the Page workspace binding - refusing to process', {
        automationId: payload.automationId,
        facebookPageId: payload.instagramAccountId,
        payloadWorkspaceId: payload.workspaceId,
        actualWorkspaceId,
      });
    await markFbJobStatus(db, payload, 'skipped', 'Tenant context mismatch: payload workspace does not match Page binding');
    return;
  }
  if (actualWorkspaceId) {
    resolvedWorkspaceId = actualWorkspaceId;
    if (!payload.workspaceId) payload.workspaceId = actualWorkspaceId;
  }

  logEvent('info', 'fb_job_started', 'processing', `Facebook AutoDM job started - ${payload.triggerType} trigger`, {
    automationId: payload.automationId,
    triggerType: payload.triggerType,
    triggerUserId: payload.triggerUserId,
    triggerEventId: payload.triggerEventId,
    attempt,
  });

  // ── 1: Messaging window ──────────────────────────────────────────────────
  // Comment triggers use Meta's 7-day private-reply window; DM triggers
  // use the 24h standard messaging window. (No flow-graph continuations
  // exist for Facebook, so there is no 7-day exception for DM jobs.)
  const maxEventAgeMs = payload.triggerType === 'comment' ? FB_COMMENT_WINDOW_MS : MAX_EVENT_AGE_MS;
  const eventAge = Date.now() - payload.triggerTimestamp;
  if (eventAge > maxEventAgeMs) {
    logEvent('warn', 'fb_window_check', 'skipped',
      `Event ${Math.round(eventAge / 3600000)}h old - outside ${payload.triggerType === 'comment' ? '7-day private-reply' : '24h messaging'} window`, {
        ageHours: Math.round(eventAge / 3600000),
      });
    await markFbJobStatus(db, payload, 'skipped', 'Event outside messaging window');
    return;
  }

  // ── 2: Load automation + Page, verify circuit breaker ────────────────────
  const { data: automation } = await db
    .from('automations')
    .select('*')
    .eq('id', payload.automationId)
    .eq('is_active', true)
    .single<AutomationRow>();
  if (!automation) {
    logEvent('warn', 'fb_automation_fetch', 'skipped', `Automation ${payload.automationId} not found or inactive`, {});
    await markFbJobStatus(db, payload, 'skipped', 'Automation not found or inactive');
    return;
  }
  if (automation.channel !== 'facebook' || (automation.type !== 'fb_comment_dm' && automation.type !== 'fb_dm_reply')) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      `Automation ${payload.automationId} is not a Facebook automation - refusing to process`, {
        automationId: payload.automationId,
        channel: automation.channel,
        type: automation.type,
      });
    await markFbJobStatus(db, payload, 'skipped', 'Automation is not a Facebook automation');
    return;
  }

  // ── Tenant pair validation (fail closed) ────────────────────────────────
  if (automation.facebook_page_id !== payload.instagramAccountId) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      'FB job payload Page does not match the automation Page binding - refusing to process', {
        automationId: payload.automationId,
        facebookPageId: payload.instagramAccountId,
        automationPageId: automation.facebook_page_id,
      });
    await markFbJobStatus(db, payload, 'skipped', 'Tenant context mismatch: automation does not belong to payload Page');
    return;
  }

  const { data: page } = await db
    .from('facebook_pages')
    .select('*')
    .eq('id', payload.instagramAccountId)
    .eq('is_active', true)
    .single<FacebookPageRow>();
  if (!page) {
    logEvent('error', 'fb_page_fetch', 'error', `Facebook Page ${payload.instagramAccountId} not found`, {});
    throw new Error('Facebook Page not found or inactive');
  }

  assertPageNotPaused(page);

  // ── Recipient opt-out suppression (fail closed on lookup error) ─────────
  if (await isFacebookSuppressed(db, page.id, payload.triggerUserId)) {
    logEvent('warn', 'fb_recipient_suppressed', 'skipped',
      `Recipient ${payload.triggerUserId} is opted-out/suppressed - blocking outbound auto_dm`, {
        recipientId: payload.triggerUserId,
        automationId: payload.automationId,
      });
    await markFbJobStatus(db, payload, 'skipped', 'Recipient has opted out of automated messages');
    return;
  }

  // ── 3: Rate limit (atomic, per Page) ─────────────────────────────────────
  await checkFbRateLimit(db, page.id, ownerUserId);

  // ── 4: Decrypt token ─────────────────────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = decrypt(page.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    logEvent('error', 'fb_token_decrypt', 'error', 'Token decryption failed - TOKEN_ENCRYPTION_KEY mismatch?', {});
    throw new Error('Token decryption failed');
  }

  // ── 5: One-private-reply-per-comment claim (before any send) ────────────
  // Every pre-send guard that can skip the job has already run, so a held
  // claim always guards a real send window.
  const claimId = await claimComment(db, payload, resolvedWorkspaceId);
  if (!claimId) {
    logEvent('info', 'fb_dedup_check', 'skipped',
      `Event ${payload.triggerEventId} already processed - one private reply per comment enforced`, {});
    await markFbJobStatus(db, payload, 'skipped', 'Duplicate event');
    return;
  }

  await markFbJobStatus(db, payload, 'processing', null);

  // Guarded send section: every Meta send happens inside this try. The
  // catch applies the claim disposition (release / keep-failed /
  // fail-closed-as-ambiguous) — the FB twin of the IG reservation
  // disposition in processJob.ts.
  let sendAttempted = false;
  try {
    // ── 6: Human-like jitter before touching Meta ──────────────────────────
    await jitter();

    // ── 7: Public comment reply (GATED, idempotent across retries) ────────
    // Posted ONLY when public_reply_enabled is true. Text comes from
    // public_reply_options, falling back to comment_reply_options.
    // replyToFacebookComment resolves even when Meta rejects the reply
    // (it logs internally) — a resolved call is treated as sent, exactly
    // like the IG replyToComment contract, so a retried job never posts
    // a second visible reply. A failed public reply never blocks the DM.
    if (payload.triggerType === 'comment' && payload.triggerEventId) {
      if (automation.public_reply_enabled !== true) {
        logEvent('info', 'fb_comment_reply', 'skipped', 'Public replies disabled for this automation (public_reply_enabled=false) - not posting', {});
      } else {
        const { data: jobRow } = await db
          .from('dm_jobs')
          .select('public_reply_sent_at')
          .eq('automation_id', payload.automationId)
          .eq('trigger_event_id', payload.triggerEventId)
          .maybeSingle();

        if (jobRow?.public_reply_sent_at) {
          logEvent('info', 'fb_comment_reply', 'skipped', 'Public reply already posted on an earlier attempt', {});
        } else {
          const options = automation.public_reply_options?.length
            ? automation.public_reply_options
            : automation.comment_reply_options;
          const replyText = selectPublicReplyOption(options, payload.triggerEventId);
          if (replyText) {
            await replyToFacebookComment(
              payload.triggerEventId,
              renderTemplate(replyText, payload.triggerUsername),
              accessToken
            );
            await db
              .from('dm_jobs')
              .update({ public_reply_sent_at: new Date().toISOString() })
              .eq('automation_id', payload.automationId)
              .eq('trigger_event_id', payload.triggerEventId);
          } else {
            logEvent('info', 'fb_comment_reply', 'skipped', 'Public replies enabled but no reply text configured - not posting', {});
          }
        }
      }
    }

    // ── 8: Compose + send the opening DM ───────────────────────────────────
    if (!automation.dm_opening_message_enabled || !automation.dm_opening_message.trim()) {
      // Opening message is off - the FIRST response becomes the initial DM.
      const responses = automation.dm_responses ?? [];
      const firstResponse = responses.find((r) => r.type !== 'lead_form' && (r.content?.trim() || r.type === 'card'));
      if (!firstResponse) {
        logEvent('info', 'fb_opening_dm', 'skipped', 'Opening DM disabled and no responses configured - nothing to send', {});
        await markFbJobStatus(db, payload, 'skipped', 'DM disabled');
        await releaseClaim(db, claimId);
        return;
      }

      // Comment triggers deliver the initial contact via private reply
      // (cards cannot be private replies — they go to the user id).
      const directRecipient: FbRecipient =
        payload.triggerType === 'comment' && payload.triggerEventId && firstResponse.type !== 'card'
          ? { commentId: payload.triggerEventId }
          : { id: payload.triggerUserId };

      logEvent('info', 'fb_opening_dm', 'processing', 'Opening message off - sending first response directly', {
        recipientId: payload.triggerUserId,
        viaPrivateReply: 'commentId' in directRecipient,
      });

      sendAttempted = true;
      try {
        await sendOneFacebookResponse(
          payload.igAccountIgsid,
          directRecipient,
          payload.triggerUserId,
          firstResponse,
          payload.triggerUsername,
          accessToken
        );
      } catch (err) {
        await markFbJobStatus(db, payload, 'failed', err instanceof Error ? err.message : String(err));
        throw err;
      }

      await markFbJobStatus(db, payload, 'sent', null, new Date());
      await db.rpc('increment_automation_dms_sent', { automation_id: payload.automationId });
      recordFacebookContactInteraction({
        facebookPageId: page.id,
        audienceIgUserId: payload.triggerUserId,
        username: payload.triggerUsername,
        triggerType: payload.triggerType === 'comment' ? 'comment' : 'dm',
        automationId: payload.automationId,
      });
      logEvent('info', 'fb_job_completed', 'ok', `Direct response delivered to ${payload.triggerUserId}`, {
        automationId: payload.automationId,
      });
      return;
    }

    const hasQuickReply = !!automation.dm_opening_message_button_title?.trim();
    let sessionId: string | null = null;
    let quickReplyPayload: string | undefined;

    if (hasQuickReply) {
      // Session row FIRST - its ID is the routing key embedded in the button payload.
      const expiresAt = new Date(Date.now() + MAX_EVENT_AGE_MS);
      const { data: session, error: sessionError } = await db
        .from('automation_sessions')
        .insert({
          automation_id: payload.automationId,
          facebook_page_id: page.id,
          audience_ig_user_id: payload.triggerUserId,
          current_step: 1,
          completed: false,
          expires_at: expiresAt.toISOString(),
          ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
        })
        .select('id')
        .single();

      if (sessionError) {
        if (sessionError.code === '23505') {
          logEvent('info', 'fb_session_create', 'skipped', `Active session already exists for ${payload.triggerUserId}`, {});
          await markFbJobStatus(db, payload, 'skipped', 'Session already active');
          await releaseClaim(db, claimId);
          return;
        }
        logger.warn({ err: sessionError }, 'FB session insert failed - degrading to plain DM');
        logEvent('warn', 'fb_session_create', 'error', 'Session insert failed - sending plain DM without button', {
          error: sessionError.message,
        });
      } else {
        sessionId = session.id as string;
        quickReplyPayload = `SESSION_${sessionId}_STEP_1`;
        logEvent('info', 'fb_session_create', 'ok', `Session created - id=${sessionId}`, { sessionId });
      }
    }

    // If variations exist, one is picked at random for this DM - same
    // rotation pattern as the public comment replies above. Falls back
    // to the legacy single opening message when no variations are stored.
    const openingVariations = (automation.dm_opening_message_variations ?? []).filter((v) => v.trim());
    const openingText = openingVariations.length > 0
      ? openingVariations[Math.floor(Math.random() * openingVariations.length)]!
      : automation.dm_opening_message;
    const messageText = renderTemplate(openingText.trim(), payload.triggerUsername);
    const openingLink = automation.dm_opening_message_button_link?.trim();
    // Link click tracking: rewrite the opening link button to a short
    // /r/[code] URL. Fail-open: the original link on any failure.
    let trackedOpeningLink = openingLink;
    const trackingUrl = trackingBaseUrl();
    if (openingLink && trackingUrl) {
      trackedOpeningLink = await trackLink(db, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        facebookPageId: page.id,
        destinationUrl: openingLink,
        appUrl: trackingUrl,
      });
    }

    // Comment triggers go out as PRIVATE REPLIES (recipient: comment_id) -
    // Meta's purpose-built comment-to-DM channel: separate 750/h allowance,
    // valid 7 days after the comment, more deliverable than general messaging.
    const recipient: FbRecipient =
      payload.triggerType === 'comment' && payload.triggerEventId
        ? { commentId: payload.triggerEventId }
        : { id: payload.triggerUserId };

    logEvent('info', 'fb_opening_dm', 'processing', `Sending opening DM to ${payload.triggerUserId}`, {
      recipientId: payload.triggerUserId,
      viaPrivateReply: 'commentId' in recipient,
      hasQuickReply,
      sessionId,
    });

    let messageId: string;
    sendAttempted = true;
    try {
      if (hasQuickReply && quickReplyPayload) {
        // 2-step flow: opening message + postback button ("Send me the link")
        messageId = await sendFacebookMessage(payload.igAccountIgsid, recipient, messageText, accessToken, {
          title: automation.dm_opening_message_button_title!.trim(),
          payload: quickReplyPayload,
        });
      } else if (trackedOpeningLink) {
        // 1-step flow with a link: try a tappable web_url button template first;
        // if Meta rejects it for this recipient, fall back to an inline link.
        const buttonTitle = automation.dm_opening_message_button_title?.trim() || 'Open link';
        try {
          messageId = await sendFacebookLinkButtonMessage(
            payload.igAccountIgsid,
            recipient,
            messageText,
            buttonTitle,
            trackedOpeningLink,
            accessToken
          );
        } catch (buttonErr) {
          if (!shouldFallBackToInlineLink(buttonErr)) throw buttonErr;
          logEvent('warn', 'fb_opening_dm', 'processing', 'Link button rejected - falling back to inline link', {});
          messageId = await sendFacebookMessage(
            payload.igAccountIgsid,
            recipient,
            `${messageText}\n\n${buttonTitle}: ${trackedOpeningLink}`,
            accessToken
          );
        }
      } else {
        messageId = await sendFacebookMessage(payload.igAccountIgsid, recipient, messageText, accessToken);
      }
    } catch (err) {
      // Orphaned session cleanup on hard failures - the engine classifies the error
      if (sessionId) {
        await db.from('automation_sessions').delete().eq('id', sessionId);
      }
      await markFbJobStatus(db, payload, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }

    // ── 9: Record the send ─────────────────────────────────────────────────
    // The claim row inserted above IS the dm_sent_log record (created_at ≈
    // send time) — no second insert (it would violate the FB event index).
    await markFbJobStatus(db, payload, 'sent', null, new Date());

    if (sessionId) {
      await db.from('dm_logs').insert({
        session_id: sessionId,
        direction: 'outbound',
        step: 1,
        message_text: messageText,
        ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
      });
    }

    const { error: counterError } = await db.rpc('increment_automation_dms_sent', {
      automation_id: payload.automationId,
    });
    if (counterError) logger.warn({ err: counterError }, 'Failed to increment FB DM counter');

    // 1-step flow: no reveal button (or session creation degraded) → there
    // is no tap coming, so deliver the configured responses right away.
    if (!sessionId && automation.dm_responses?.length) {
      logEvent('info', 'fb_responses_send', 'processing',
        `No reveal button - delivering ${automation.dm_responses.length} response(s) immediately`, {
          responseCount: automation.dm_responses.length,
        });
      const sentCount = await deliverFacebookResponsesBestEffort(payload, automation.dm_responses, accessToken, ownerUserId);
      // Opening DM used the reserved slot; responses are extra sends.
      recordExtraFbSends(page.id, sentCount, resolvedWorkspaceId);
    }

    // Contacts: DM webhooks don't carry a name - enrich it from the
    // profile API now that they've messaged us.
    recordFacebookContactInteraction({
      facebookPageId: page.id,
      audienceIgUserId: payload.triggerUserId,
      username: payload.triggerUsername,
      triggerType: payload.triggerType === 'comment' ? 'comment' : 'dm',
      automationId: payload.automationId,
    });
    if (payload.triggerType !== 'comment') {
      void getFacebookUserProfile(payload.triggerUserId, accessToken).then((p) => {
        if (p) {
          const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || null;
          updateFacebookContactProfile({
            facebookPageId: page.id,
            audienceIgUserId: payload.triggerUserId,
            username: name,
          });
        }
      });
    }

    logEvent('info', 'fb_job_completed', 'ok', `Opening DM delivered to ${payload.triggerUserId}`, {
      automationId: payload.automationId,
      messageId,
      sessionId,
    });
  } catch (err) {
    // ── Claim disposition (FB twin of the IG reservation disposition) ─────
    if (err instanceof MetaApiError && err.code !== undefined && (META_RATE_LIMIT_CODES as readonly number[]).includes(err.code)) {
      // Definitive pre-delivery rejection — safe for a retry to re-claim.
      await releaseClaim(db, claimId);
    } else if (err instanceof NonRetryableMetaError || err instanceof AccountPausedMetaError) {
      // Definitive permanent Meta failure — keep the claim: the comment
      // must never be re-attempted blindly (the engine fails this job).
    } else if (sendAttempted) {
      // AMBIGUOUS OUTCOME: the send was initiated and its result is
      // unknown — Meta may have delivered. FAIL CLOSED: keep the claim
      // and surface AmbiguousDeliveryError so the engine fails (never
      // reschedules) this job.
      const errorMsg = err instanceof Error ? err.message : String(err);
      await markFbJobStatus(db, payload, 'failed', `Ambiguous delivery outcome: ${errorMsg}`);
      throw new AmbiguousDeliveryError(`Ambiguous FB send outcome for event ${payload.triggerEventId}: ${errorMsg}`);
    } else {
      // Sending never began — safe for a retry to re-claim.
      await releaseClaim(db, claimId);
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Follow-up processor (reveal-button / postback tap)
// ═══════════════════════════════════════════════════════════════════════════

export async function processFacebookFollowUpDmJob(payload: AutoDmJobPayload): Promise<void> {
  // Facebook has no scheduled follow-ups in v1; the webhook never
  // enqueues them. A stray flag is dropped, never processed.
  if (payload.isScheduledFollowUp) return;

  const db = createServiceClient();
  const env = getEnv();

  const { data: ownerRow } = await db
    .from('facebook_pages')
    .select('user_id, workspace_id')
    .eq('id', payload.instagramAccountId)
    .maybeSingle();
  const ownerUserId = (ownerRow?.user_id as string | undefined) ?? null;
  let resolvedWorkspaceId: string | null = null;
  const logEvent = (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata: Record<string, unknown> = {}
  ): void =>
    debugLog('worker', level, eventType, status, message, {
      ...metadata,
      userId: ownerUserId,
      ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
    });

  // ── Tenant pair pre-check (fail closed) ─────────────────────────────────
  // Direct automation↔Page validation BEFORE the session fetch, before
  // the suppression branch and before ANY session-mutating operation.
  {
    const { data: pairAutomation } = await db
      .from('automations')
      .select('facebook_page_id')
      .eq('id', payload.automationId)
      .maybeSingle();
    if (pairAutomation && pairAutomation.facebook_page_id !== payload.instagramAccountId) {
      logEvent('error', 'tenant_context_mismatch', 'error',
        'FB follow-up payload Page does not match the automation Page binding - refusing to process', {
          automationId: payload.automationId,
          facebookPageId: payload.instagramAccountId,
          automationPageId: pairAutomation.facebook_page_id,
        });
      return;
    }
  }

  // ── Workspace validation (fail closed; follow-up convention: log + drop).
  const actualWorkspaceId =
    typeof ownerRow?.workspace_id === 'string' && (ownerRow.workspace_id as string).length > 0
      ? (ownerRow.workspace_id as string)
      : null;
  if (payload.workspaceId && payload.workspaceId !== actualWorkspaceId) {
    resolvedWorkspaceId = payload.workspaceId;
    logEvent('error', 'tenant_context_mismatch', 'error',
      'FB follow-up payload workspace does not match the Page workspace binding - refusing to process', {
        automationId: payload.automationId,
        facebookPageId: payload.instagramAccountId,
        payloadWorkspaceId: payload.workspaceId,
        actualWorkspaceId,
      });
    return;
  }
  if (actualWorkspaceId) {
    resolvedWorkspaceId = actualWorkspaceId;
    if (!payload.workspaceId) payload.workspaceId = actualWorkspaceId;
  }

  logEvent('info', 'fb_followup_started', 'processing', `Facebook follow-up job started - step ${payload.sessionStep}`, {
    sessionId: payload.sessionId ?? null,
    sessionStep: payload.sessionStep ?? null,
    triggerUserId: payload.triggerUserId,
  });

  if (!payload.sessionId) {
    logEvent('warn', 'fb_followup_started', 'error', 'Follow-up job has no sessionId - dropping', {});
    return;
  }

  // ── 1: Verify session ────────────────────────────────────────────────────
  const { data: session } = await db
    .from('automation_sessions')
    .select('id, automation_id, facebook_page_id, audience_ig_user_id, current_step, expires_at, completed')
    .eq('id', payload.sessionId)
    .maybeSingle();

  if (!session) {
    logEvent('warn', 'fb_session_verify', 'error', `Session ${payload.sessionId} not found`, {});
    return;
  }
  // The session row is tenant data: it must belong to the payload's own
  // automation AND Page. A foreign session is dropped WITHOUT touching it.
  if (
    session.facebook_page_id !== payload.instagramAccountId ||
    session.automation_id !== payload.automationId
  ) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      'FB follow-up session does not belong to the payload automation/Page - refusing to process', {
        sessionId: payload.sessionId,
        automationId: payload.automationId,
        facebookPageId: payload.instagramAccountId,
        sessionAutomationId: session.automation_id,
        sessionPageId: session.facebook_page_id,
      });
    return;
  }
  if (session.audience_ig_user_id !== payload.triggerUserId) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      'FB follow-up sender does not own the session - refusing to process', {
        sessionId: payload.sessionId,
        triggerUserId: payload.triggerUserId,
      });
    return;
  }

  // ── 1.5: Recipient opt-out suppression (fail closed) ─────────────────────
  // Runs only after the pair validation above, so the session completion
  // here can only ever touch the payload's OWN tenant session.
  if (await isFacebookSuppressed(db, payload.instagramAccountId, payload.triggerUserId)) {
    logEvent('warn', 'fb_followup_suppressed', 'skipped',
      `Recipient ${payload.triggerUserId} is suppressed (opted out) - dropping follow-up`, {
        recipientId: payload.triggerUserId,
        sessionId: payload.sessionId,
      });
    await db.from('automation_sessions').update({ completed: true }).eq('id', payload.sessionId);
    return;
  }
  if (session.completed as boolean) {
    logEvent('info', 'fb_session_verify', 'skipped', `Session ${payload.sessionId} already completed`, {});
    return;
  }
  if (new Date(session.expires_at as string) < new Date()) {
    logEvent('warn', 'fb_session_verify', 'skipped', `Session ${payload.sessionId} expired`, {});
    await db.from('automation_sessions').update({ completed: true }).eq('id', payload.sessionId);
    return;
  }

  const expectedStep = session.current_step as number;
  if (payload.sessionStep !== undefined && payload.sessionStep !== expectedStep) {
    logEvent('warn', 'fb_session_verify', 'skipped',
      `Step mismatch: tap says ${payload.sessionStep}, session expects ${expectedStep} - stale button tap`, {});
    return;
  }

  // ── 2: Load automation + Page, breaker + rate limit ──────────────────────
  // No ask-to-follow gate: Facebook's profile API has no "follows the
  // Page" signal, so require-follow is not offered for Facebook.
  const { data: automation } = await db
    .from('automations')
    .select('facebook_page_id, dm_responses')
    .eq('id', payload.automationId)
    .eq('is_active', true)
    .single<AutomationRow>();
  if (!automation) {
    logEvent('warn', 'fb_automation_fetch', 'skipped', `Automation ${payload.automationId} inactive - completing session`, {});
    await db.from('automation_sessions').update({ completed: true }).eq('id', payload.sessionId);
    return;
  }
  if (automation.facebook_page_id !== payload.instagramAccountId) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      'FB follow-up payload Page does not match the automation Page binding - refusing to process', {
        automationId: payload.automationId,
        facebookPageId: payload.instagramAccountId,
        automationPageId: automation.facebook_page_id,
      });
    return;
  }

  const { data: page } = await db
    .from('facebook_pages')
    .select('*')
    .eq('id', payload.instagramAccountId)
    .eq('is_active', true)
    .single<FacebookPageRow>();
  if (!page) {
    throw new Error('Facebook Page not found');
  }

  assertPageNotPaused(page);

  // The tap itself re-opens the 24h standard messaging window — the
  // follow-up must still go out within 24h of the tap.
  const tapAge = Date.now() - payload.triggerTimestamp;
  if (tapAge > MAX_EVENT_AGE_MS) {
    logEvent('warn', 'fb_window_check', 'skipped',
      `Tap is ${Math.round(tapAge / 3600000)}h old - 24h messaging window closed`, {
        ageHours: Math.round(tapAge / 3600000),
      });
    await db.from('automation_sessions').update({ completed: true }).eq('id', payload.sessionId);
    return;
  }

  await checkFbRateLimit(db, page.id, ownerUserId);

  let accessToken: string;
  try {
    accessToken = decrypt(page.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new Error('Token decryption failed');
  }

  await jitter();

  // ── 3: Deliver dm_responses sequentially ─────────────────────────────────
  if (!automation.dm_responses?.length) {
    logEvent('warn', 'fb_responses_send', 'skipped', 'Automation has 0 dm_responses - session completed with no content', {
      hint: 'Add at least one response (text or card) in the automation configuration',
    });
    await db.from('automation_sessions').update({ completed: true, last_activity_at: new Date().toISOString() }).eq('id', payload.sessionId);
    return;
  }

  logEvent('info', 'fb_responses_send', 'processing', `Sending ${automation.dm_responses.length} response(s) to ${payload.triggerUserId}`, {
    sessionId: payload.sessionId,
    responseCount: automation.dm_responses.length,
  });

  // Link click tracking: rewrite every destination to a short /r/[code]
  // URL before sending. Fail-open: original links when no app URL set.
  let responsesToSend = automation.dm_responses;
  const followUpBaseUrl = trackingBaseUrl();
  if (followUpBaseUrl) {
    responsesToSend = await rewriteResponseLinks(db, {
      automationId: payload.automationId,
      instagramAccountId: payload.instagramAccountId,
      facebookPageId: page.id,
      responses: automation.dm_responses,
      appUrl: followUpBaseUrl,
    });
  }

  let lastMessageText = '';
  let deliveredCount = 0;
  for (const [idx, response] of responsesToSend.entries()) {
    if (response.type === 'lead_form') {
      logEvent('warn', 'fb_responses_send', 'skipped',
        `Response ${idx + 1} is a lead form - no Facebook lead capture in v1, skipped`, {
          responseIndex: idx + 1,
          type: response.type,
        });
      continue;
    }
    if (!response.content?.trim() && response.type !== 'card') continue;
    if (deliveredCount > 0) await interMessageJitter();

    if (response.type === 'card') {
      const cardImageUrl = response.cardImage?.startsWith('http') ? response.cardImage : undefined;
      await sendFacebookCardMessage(page.facebook_page_id, payload.triggerUserId, accessToken, {
        title: response.cardTitle ?? response.content,
        ...(cardImageUrl !== undefined ? { imageUrl: cardImageUrl } : {}),
        ...(response.cardSubtitle !== undefined ? { subtitle: response.cardSubtitle } : {}),
        ...(response.cardButtons !== undefined
          ? { buttons: response.cardButtons.map((b) => ({ title: b.title, url: b.link })) }
          : {}),
      });
      lastMessageText = response.cardTitle ?? response.content ?? 'Card message';
    } else {
      const messageText = renderTemplate(response.content.trim(), payload.triggerUsername);
      // Link buttons (2026-11-22): up to 2 per text response, resolved by
      // getTextLinkButtons (prefers `buttons`, falls back to the legacy
      // buttonTitle/buttonLink). The reveal-tap path used to read only the
      // legacy fields, so the second button was silently dropped.
      const buttons = getTextLinkButtons(response);
      if (buttons.length > 0) {
        try {
          await sendFacebookLinkButtonMessage(
            page.facebook_page_id,
            { id: payload.triggerUserId },
            messageText,
            buttons.map((b) => ({ title: b.title, url: b.link })),
            accessToken
          );
          lastMessageText = messageText;
        } catch (buttonErr) {
          if (!shouldFallBackToInlineLink(buttonErr)) throw buttonErr;
          logEvent('warn', 'fb_responses_send', 'processing', 'Link button rejected - falling back to inline link', {});
          const fallback = `${messageText}\n\n${formatInlineLinkButtons(buttons)}`;
          await sendFacebookMessage(page.facebook_page_id, { id: payload.triggerUserId }, fallback, accessToken);
          lastMessageText = fallback;
        }
      } else {
        await sendFacebookMessage(page.facebook_page_id, { id: payload.triggerUserId }, messageText, accessToken);
        lastMessageText = messageText;
      }
    }
    deliveredCount += 1;
    logEvent('info', 'fb_responses_send', 'ok', `Response ${idx + 1}/${automation.dm_responses.length} sent`, {
      responseIndex: idx + 1,
      type: response.type,
    });
  }

  // The tap reserved one slot; anything beyond the first message is extra.
  recordExtraFbSends(page.id, deliveredCount - 1, resolvedWorkspaceId);

  // ── 4: Log + complete session ────────────────────────────────────────────
  if (payload.messageText) {
    await db.from('dm_logs').insert({
      session_id: payload.sessionId,
      direction: 'inbound',
      step: expectedStep,
      message_text: payload.messageText,
      ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
    });
  }
  if (lastMessageText) {
    await db.from('dm_logs').insert({
      session_id: payload.sessionId,
      direction: 'outbound',
      step: expectedStep,
      message_text: lastMessageText,
      ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
    });
  }

  await db
    .from('automation_sessions')
    .update({ completed: true, last_activity_at: new Date().toISOString() })
    .eq('id', payload.sessionId);

  await db.rpc('increment_automation_dms_sent', { automation_id: payload.automationId });

  logEvent('info', 'fb_session_completed', 'ok', `All responses delivered to ${payload.triggerUserId}`, {
    sessionId: payload.sessionId,
    step: expectedStep,
  });
}
