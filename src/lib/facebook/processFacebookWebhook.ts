/**
 * Facebook Page webhook processor — the Facebook twin of
 * src/lib/automation/processWebhook.ts (Instagram).
 *
 * Receives Page `feed` events (comments on Page posts) and `messages`
 * events (Messenger DMs to the Page) for object === 'page', matches them
 * against the Page's fb_comment_dm / fb_dm_reply automations, and enqueues
 * jobs on the shared job_queue. The queue engine dispatches by
 * payload.channel === 'facebook' into processFacebookJob.ts.
 *
 * Meta rules enforced here (Graph API v23.0):
 *  - Pages only. The Page can never message first; every send is a reply
 *    to a comment (7-day private-reply window) or to a Messenger message
 *    (24h standard window, enforced again at send time).
 *  - One private reply per comment: the job processor claims the comment
 *    in dm_sent_log before sending; a second comment by the same person
 *    CAN still trigger (no per-user dedupe on Facebook — deliberate,
 *    unlike Instagram).
 *  - Replies to comments are treated like top-level comments (same as
 *    Instagram: any comment on the post can trigger). parent_id is only
 *    used for logging.
 *  - The Page's own comments (from.id === Page id) never trigger.
 *
 * This module never sends to Meta and never touches Instagram rows.
 * Signature verification + the GET handshake live in the webhook route
 * (src/app/api/webhook/route.ts), shared with Instagram — the FB app
 * secret IS the Meta app secret, so no second secret is needed.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { enqueueJob } from '@/lib/automation/queue';
import { keywordMatches, isExplicitWildcardAutomation } from '@/lib/automation/keywordMatch';
import { isFacebookSuppressed, recordFacebookOptOut, isOptOutIntent } from '@/lib/automation/optOut';
import type {
  AutoDmJobPayload,
  AutomationRow,
  FacebookPageRow,
  MetaFeedChangeValue,
  MetaWebhookBody,
  MetaWebhookEntry,
  MetaWebhookMessaging,
} from '@/lib/types';

const logger = createLogger('facebook-webhook');

/** Meta's private-reply window for a comment: 7 days from the comment. */
const FB_COMMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type DebugLevel = 'info' | 'warn' | 'error';
type DebugStatus = 'ok' | 'error' | 'skipped' | 'processing';

/**
 * Processes one verified Page webhook body. Returns the number of jobs
 * enqueued (0 when nothing matched — a normal, non-error outcome).
 */
export async function processFacebookWebhook(body: MetaWebhookBody): Promise<number> {
  const db = createServiceClient();
  let enqueued = 0;

  for (const entry of body.entry ?? []) {
    const pageMetaId = entry.id;
    const { data: page } = await db
      .from('facebook_pages')
      .select('*')
      .eq('facebook_page_id', pageMetaId)
      .eq('is_active', true)
      .maybeSingle<FacebookPageRow>();

    if (!page) {
      debugLog('webhook', 'warn', 'fb_page_not_connected', 'skipped',
        `Facebook Page ${pageMetaId} is not connected - ignoring webhook entry`, {
          pageMetaId,
        });
      continue;
    }

    const logEvent = (
      level: DebugLevel,
      eventType: string,
      status: DebugStatus,
      message: string,
      metadata: Record<string, unknown> = {}
    ): void =>
      debugLog('webhook', level, eventType, status, message, {
        ...metadata,
        userId: page.user_id,
        facebookPageId: page.id,
        ...(page.workspace_id ? { workspaceId: page.workspace_id } : {}),
      });

    // Circuit breaker: a paused Page enqueues nothing.
    if (page.paused_until && new Date(page.paused_until).getTime() > Date.now()) {
      logEvent('warn', 'fb_page_paused', 'skipped',
        `Page ${page.name} is paused until ${page.paused_until} - ignoring webhook entry`, {
          pausedUntil: page.paused_until,
        });
      continue;
    }

    for (const change of entry.changes ?? []) {
      enqueued += await processFeedChange(db, page, entry, change, logEvent);
    }
    for (const event of entry.messaging ?? []) {
      enqueued += await processMessagingEvent(db, page, event, logEvent);
    }
  }

  return enqueued;
}

// ── Feed (comment) events ───────────────────────────────────────────────────

async function processFeedChange(
  db: ReturnType<typeof createServiceClient>,
  page: FacebookPageRow,
  _entry: MetaWebhookEntry,
  change: { field: string; value: unknown },
  logEvent: (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata?: Record<string, unknown>
  ) => void
): Promise<number> {
  if (change.field !== 'feed') return 0;
  const value = change.value as MetaFeedChangeValue;
  if (value.item !== 'comment' || (value.verb !== 'add' && value.verb !== 'edited')) return 0;

  const commentId = value.comment_id;
  const postId = value.post_id;
  const from = value.from;
  if (!commentId || !postId || !from?.id) {
    logEvent('warn', 'fb_comment_malformed', 'skipped', 'Feed comment event is missing comment_id/post_id/from', {});
    return 0;
  }

  // The Page commenting on its own post never triggers an automation.
  if (from.id === page.facebook_page_id) {
    logEvent('info', 'fb_self_comment', 'skipped', 'Comment is from the Page itself - ignoring', { commentId });
    return 0;
  }

  // Private replies are only valid within 7 days of the comment. Events
  // older than that can never send, so drop them here instead of letting
  // them occupy a job slot (the job processor re-checks the window).
  const createdMs = toEpochMs(value.created_time);
  if (createdMs !== null && Date.now() - createdMs > FB_COMMENT_WINDOW_MS) {
    logEvent('info', 'fb_comment_too_old', 'skipped',
      `Comment ${commentId} is older than 7 days - private-reply window closed`, { commentId });
    return 0;
  }

  const text = value.message ?? '';
  // An explicit opt-out in the comment itself ("stop", "unsubscribe", …)
  // is recorded and the comment never triggers (webhook-ingestion check).
  if (isOptOutIntent(text)) {
    await recordFacebookOptOut(db, {
      facebookPageId: page.id,
      recipientId: from.id,
      triggerEventId: commentId,
      text,
    });
    logEvent('warn', 'fb_recipient_opted_out', 'skipped',
      `Commenter ${from.id} opted out in this comment - ignoring`, { commentId });
    return 0;
  }
  if (await isFacebookSuppressed(db, page.id, from.id)) {
    logEvent('warn', 'fb_recipient_suppressed', 'skipped',
      `Commenter ${from.id} is suppressed for this Page - ignoring comment`, { commentId });
    return 0;
  }

  const { data: automations } = await db
    .from('automations')
    .select('*')
    .eq('facebook_page_id', page.id)
    .eq('type', 'fb_comment_dm')
    .eq('is_active', true);
  const list = (automations ?? []) as AutomationRow[];
  if (list.length === 0) return 0;

  let enqueued = 0;
  for (const automation of list) {
    if (automation.post_id && automation.post_id !== postId) continue;

    const excluded = (automation.trigger_config as { excluded_keywords?: unknown } | null)?.excluded_keywords;
    if (Array.isArray(excluded) && excluded.length > 0 && keywordMatches(text, excluded as string[])) {
      logEvent('info', 'fb_keyword_exclude', 'skipped',
        `Automation ${automation.id}: comment matches excluded keyword`, { automationId: automation.id });
      continue;
    }

    const isAnyComment = isExplicitWildcardAutomation(automation);
    if (!isAnyComment && !keywordMatches(text, automation.keywords as string[] | null, { exactStandalone: true })) {
      logEvent('info', 'fb_keyword_match', 'skipped',
        `Automation ${automation.id}: no keyword match`, { automationId: automation.id });
      continue;
    }

    const payload: AutoDmJobPayload = {
      automationId: automation.id,
      instagramAccountId: page.id,
      igAccountIgsid: page.facebook_page_id,
      channel: 'facebook',
      ...(page.workspace_id ? { workspaceId: page.workspace_id } : {}),
      triggerType: 'comment',
      triggerUserId: from.id,
      triggerUsername: from.name ?? null,
      triggerEventId: commentId,
      triggerTimestamp: createdMs ?? Date.now(),
      commentId,
      commentText: text,
      messageText: null,
      postId,
    };
    const jobId = await enqueueJob('auto_dm', payload, `fb-comment:${automation.id}:${commentId}`);
    if (jobId) {
      enqueued += 1;
      logEvent('info', 'fb_keyword_match', 'ok',
        `Automation ${automation.id}: ${isAnyComment ? 'any comment' : 'keyword'} matched - enqueued`, {
          automationId: automation.id,
          isAnyComment,
          commentId,
        });
    }
  }
  return enqueued;
}

// ── Messenger events ────────────────────────────────────────────────────────

async function processMessagingEvent(
  db: ReturnType<typeof createServiceClient>,
  page: FacebookPageRow,
  event: MetaWebhookMessaging,
  logEvent: (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata?: Record<string, unknown>
  ) => void
): Promise<number> {
  const senderId = event.sender?.id;
  if (!senderId || senderId === page.facebook_page_id) return 0; // own echo / self
  if (event.message?.is_echo) return 0;
  if (event.read || event.delivery) return 0; // receipts carry no trigger

  // Postback taps (reveal button "Send me the link" / any button the
  // automation sent) route to the follow-up processor via the session.
  if (event.postback?.payload) {
    return processPostback(db, page, event, logEvent);
  }

  const text = event.message?.text?.trim();
  if (!text) return 0; // stickers / attachments / location: no text to match

  // A quick_reply tap on an automation button carries the SESSION payload
  // as its quick_reply payload — route it like a postback.
  const quickPayload = event.message?.quick_reply?.payload;
  if (quickPayload?.startsWith('SESSION_')) {
    return processPostback(db, page, { ...event, postback: { payload: quickPayload, title: '' } }, logEvent);
  }

  const mid = event.message?.mid ?? `fb-msg-${senderId}-${event.timestamp}`;
  if (isOptOutIntent(text)) {
    await recordFacebookOptOut(db, {
      facebookPageId: page.id,
      recipientId: senderId,
      triggerEventId: mid,
      text,
    });
    logEvent('warn', 'fb_recipient_opted_out', 'skipped',
      `Messenger user ${senderId} opted out - ignoring message`, {});
    return 0;
  }
  if (await isFacebookSuppressed(db, page.id, senderId)) {
    logEvent('warn', 'fb_recipient_suppressed', 'skipped',
      `Messenger user ${senderId} is suppressed for this Page - ignoring message`, {});
    return 0;
  }

  const { data: automations } = await db
    .from('automations')
    .select('*')
    .eq('facebook_page_id', page.id)
    .eq('type', 'fb_dm_reply')
    .eq('is_active', true);
  const list = (automations ?? []) as AutomationRow[];
  if (list.length === 0) return 0;

  let enqueued = 0;
  for (const automation of list) {
    const excluded = (automation.trigger_config as { excluded_keywords?: unknown } | null)?.excluded_keywords;
    if (Array.isArray(excluded) && excluded.length > 0 && keywordMatches(text, excluded as string[])) {
      continue;
    }
    const isAnyDm = isExplicitWildcardAutomation(automation);
    if (!isAnyDm && !keywordMatches(text, automation.keywords as string[] | null)) {
      continue;
    }

    const payload: AutoDmJobPayload = {
      automationId: automation.id,
      instagramAccountId: page.id,
      igAccountIgsid: page.facebook_page_id,
      channel: 'facebook',
      ...(page.workspace_id ? { workspaceId: page.workspace_id } : {}),
      triggerType: 'dm',
      triggerUserId: senderId,
      triggerUsername: null, // Messenger events carry no name; the job enriches it via the profile API
      triggerEventId: mid,
      triggerTimestamp: event.timestamp,
      commentText: text,
      messageText: text,
      postId: null,
    };
    const jobId = await enqueueJob('auto_dm', payload, `fb-dm:${automation.id}:${senderId}:${mid}`);
    if (jobId) {
      enqueued += 1;
      logEvent('info', 'fb_dm_match', 'ok',
        `Automation ${automation.id}: ${isAnyDm ? 'any message' : 'keyword'} matched - enqueued`, {
          automationId: automation.id,
          isAnyDm,
        });
    }
  }
  return enqueued;
}

async function processPostback(
  db: ReturnType<typeof createServiceClient>,
  page: FacebookPageRow,
  event: MetaWebhookMessaging,
  logEvent: (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata?: Record<string, unknown>
  ) => void
): Promise<number> {
  const rawPayload = event.postback?.payload ?? '';
  const match = /^SESSION_([0-9a-f-]{36})_STEP_(\d+)$/.exec(rawPayload);
  if (!match) {
    // A postback this app did not send (e.g. a Get Started button or a
    // persistent-menu item) — nothing to route.
    logEvent('info', 'fb_postback_unknown', 'skipped', `Postback payload is not an automation session tap: ${rawPayload.slice(0, 80)}`, {});
    return 0;
  }
  const sessionId = match[1]!;
  const step = Number(match[2]);

  const { data: session } = await db
    .from('automation_sessions')
    .select('id, automation_id, facebook_page_id, audience_ig_user_id, current_step, completed')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session) {
    logEvent('warn', 'fb_session_missing', 'skipped', `Postback references unknown session ${sessionId}`, { sessionId });
    return 0;
  }
  if (session.facebook_page_id !== page.id) {
    logEvent('error', 'fb_session_page_mismatch', 'skipped',
      `Postback session ${sessionId} belongs to a different Page - ignoring`, { sessionId });
    return 0;
  }
  if (session.completed) {
    logEvent('info', 'fb_session_completed', 'skipped', `Session ${sessionId} already completed - ignoring tap`, { sessionId });
    return 0;
  }

  const senderId = event.sender.id;
  if (session.audience_ig_user_id !== senderId) {
    logEvent('error', 'fb_session_user_mismatch', 'skipped',
      `Postback sender ${senderId} does not own session ${sessionId} - ignoring`, { sessionId });
    return 0;
  }

  const postbackMid =
    (event.postback as { mid?: string } | undefined)?.mid ?? `fb-postback-${sessionId}-${step}-${senderId}`;
  const payload: AutoDmJobPayload = {
    automationId: session.automation_id as string,
    instagramAccountId: page.id,
    igAccountIgsid: page.facebook_page_id,
    channel: 'facebook',
    ...(page.workspace_id ? { workspaceId: page.workspace_id } : {}),
    triggerType: 'dm_reply_followup',
    triggerUserId: senderId,
    triggerUsername: null,
    triggerEventId: postbackMid,
    triggerTimestamp: event.timestamp,
    sessionId,
    sessionStep: step,
    postId: null,
    commentText: null,
    messageText: null,
  };
  const jobId = await enqueueJob('follow_up', payload, `fb-followup:${sessionId}:STEP_${step}`);
  if (jobId) {
    logEvent('info', 'fb_postback_routed', 'ok', `Session ${sessionId} step ${step} tap - follow-up enqueued`, {
      sessionId,
      sessionStep: step,
    });
    return 1;
  }
  return 0;
}

/** Meta feed `created_time` is unix seconds; messaging `timestamp` is ms. */
function toEpochMs(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Seconds (< 1e12) vs milliseconds — disambiguate by magnitude.
  return n < 1e12 ? n * 1000 : n;
}

export { logger as facebookWebhookLogger };
