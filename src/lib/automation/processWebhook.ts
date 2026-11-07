/**
 * Webhook payload processing - routes Meta events to queue jobs.
 *
 * Runs AFTER the 200 response has been sent to Meta (via `after()`), so
 * nothing here is latency-critical. Ported 1:1 from the proven receiver:
 *
 *  comment events → keyword/post match → auto_dm job
 *  DM events      → quick-reply/postback session routing → follow_up job
 *                 → story replies (message.reply_to.story) → story_reply keyword match
 *                 → plain DMs → dm_reply keyword match
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog, type DebugLevel, type DebugStatus } from '@/lib/debugLog';
import { keywordMatches, isExplicitWildcardAutomation } from '@/lib/automation/keywordMatch';
import { enqueueJob } from '@/lib/automation/queue';
import { recordContactInteraction } from '@/lib/automation/contacts';
import { recordAndEvaluateCommentTraffic } from '@/lib/trafficGuard/tracker';
import { isOptOutIntent, recordRecipientOptOut, isRecipientSuppressed } from '@/lib/automation/optOut';
import { scheduleFollowUpMessage } from '@/lib/automation/followUps';
import type {
  MetaWebhookBody,
  MetaCommentChangeValue,
  MetaWebhookMessaging,
  AutoDmJobPayload,
} from '@/lib/types';

const logger = createLogger('webhook');

/** Max event age accepted for processing: 24h window + 1h queue buffer. */
const MAX_EVENT_AGE_MS = 25 * 60 * 60 * 1000;

export async function processWebhookPayload(body: MetaWebhookBody): Promise<number> {
  if (body.object !== 'instagram') {
    debugLog('webhook', 'info', 'payload_routing', 'skipped', `Webhook object "${body.object}" is not instagram - ignoring`, {});
    return 0;
  }

  debugLog('webhook', 'info', 'payload_routing', 'ok', `Processing instagram webhook - ${body.entry.length} entr${body.entry.length === 1 ? 'y' : 'ies'}`, {
    entryIds: body.entry.map((e) => e.id),
  });

  const db = createServiceClient();
  let enqueued = 0;

  for (const entry of body.entry) {
    debugLog('webhook', 'info', 'entry_processing', 'processing', `Entry for IG account ${entry.id}`, {
      entryId: entry.id,
      changeFields: entry.changes?.map((c) => c.field) ?? [],
      messagingCount: entry.messaging?.length ?? 0,
    });

    const { data: igAccount, error } = await db
      .from('instagram_accounts')
      .select('id, instagram_user_id, user_id, traffic_guard_paused, workspace_id')
      .eq('instagram_user_id', entry.id)
      .eq('is_active', true)
      .single();

    if (error || !igAccount) {
      debugLog('webhook', 'warn', 'ig_account_lookup', 'skipped', `No active IG account for entry.id=${entry.id}`, {
        entryId: entry.id,
        hint: 'Meta console "Test" button sends entry.id=0 (fake) - real comments from the connected account are required.',
      });
      continue;
    }

    // Phase D1: the account's workspace binding (…000026) — null for the
    // legacy single-owner world. When bound, it is stamped onto every job
    // payload (and, via enqueueJob, the job_queue row) and threaded into
    // this entry's debug logs; when null, nothing changes.
    const accountWorkspaceId =
      typeof igAccount.workspace_id === 'string' && igAccount.workspace_id.length > 0
        ? (igAccount.workspace_id as string)
        : null;

    // Smart Comment Traffic Guard: count unique inbound comments (excluding
    // the account's own) and evaluate the spike state machine — runs even
    // while paused, so recovery can be detected.
    const commentIds: string[] = [];
    if (entry.changes?.length) {
      for (const change of entry.changes) {
        if (change.field === 'comments' && change.value?.id && change.value.from?.id !== entry.id) {
          commentIds.push(change.value.id);
        }
      }
    }
    if (commentIds.length > 0) {
      await recordAndEvaluateCommentTraffic(igAccount.id as string, commentIds);
    }

    if (entry.changes?.length) {
      if (igAccount.traffic_guard_paused) {
        // Paused by Traffic Guard: comment automations must not dispatch.
        debugLog('webhook', 'warn', 'traffic_guard_paused', 'skipped',
          `Account ${entry.id} is paused by Traffic Guard - skipping comment automation processing`, {
            accountId: igAccount.id,
            userId: igAccount.user_id as string,
            ...(accountWorkspaceId ? { workspaceId: accountWorkspaceId } : {}),
          });
      } else for (const change of entry.changes) {
        if (change.field === 'comments') {
          enqueued += await processCommentEvent(
            igAccount.id as string,
            entry.id,
            change.value,
            entry.time,
            igAccount.user_id as string,
            accountWorkspaceId
          );
        } else {
          debugLog('webhook', 'info', 'change_field_ignored', 'skipped', `Ignoring change field "${change.field}"`, {
            field: change.field,
            userId: igAccount.user_id as string,
            ...(accountWorkspaceId ? { workspaceId: accountWorkspaceId } : {}),
          });
        }
      }
    } else if (!entry.messaging?.length) {
      debugLog('webhook', 'warn', 'entry_empty', 'skipped', `Entry ${entry.id} has no changes and no messaging`, {
        hint: 'Likely a read-receipt or unsupported event. Check the per-account subscription includes "comments".',
        userId: igAccount.user_id as string,
        ...(accountWorkspaceId ? { workspaceId: accountWorkspaceId } : {}),
      });
    }

    if (entry.messaging) {
      for (const messaging of entry.messaging) {
        enqueued += await processDmEvent(
          igAccount.id as string,
          entry.id,
          messaging,
          igAccount.user_id as string,
          accountWorkspaceId
        );
      }
    }
  }

  return enqueued;
}

async function processCommentEvent(
  instagramAccountId: string,
  igAccountIgsid: string,
  comment: MetaCommentChangeValue,
  entryTime: number,
  ownerUserId: string,
  workspaceId: string | null = null
): Promise<number> {
  // Owner-scoped debug logging: every event in this handler belongs to the
  // connected account's owner (debug_events.user_id - finding #6). Phase
  // D1: the account's workspace (when bound) rides along the same way
  // (debug_events.workspace_id - …000032); unbound accounts log exactly
  // as before.
  const logEvent = (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata: Record<string, unknown> = {}
  ): void =>
    debugLog('webhook', level, eventType, status, message, {
      ...metadata,
      userId: ownerUserId,
      ...(workspaceId ? { workspaceId } : {}),
    });
  // Only top-level comments trigger - replies are ignored (incl. our own replies)
  if (comment.parent_id) {
    logEvent( 'info', 'comment_event', 'skipped', `Comment ${comment.id} is a reply - ignored`, {
      commentId: comment.id,
    });
    return 0;
  }

  // Never react to the account's own comments (self-trigger loop guard)
  if (comment.from.id === igAccountIgsid) {
    logEvent( 'info', 'comment_event', 'skipped', 'Comment authored by the connected account itself - ignored', {});
    return 0;
  }

  // Meta may omit comment.timestamp on IG comment webhooks - fall back to entry.time
  const triggerTimestamp = (comment.timestamp ?? entryTime) * 1000;
  const eventAgeMs = Date.now() - triggerTimestamp;

  logEvent( 'info', 'comment_event', 'processing', `Comment received: "${comment.text.slice(0, 80)}"`, {
    commentId: comment.id,
    commenterId: comment.from.id,
    commenterUsername: comment.from.username ?? null,
    postId: comment.media.id,
    ageSeconds: Math.round(eventAgeMs / 1000),
  });

  if (eventAgeMs > MAX_EVENT_AGE_MS) {
    logEvent( 'warn', 'window_check', 'skipped', `Comment ${Math.round(eventAgeMs / 3600000)}h old - beyond processing window`, {});
    return 0;
  }

  const db = createServiceClient();

  // ── Opt-Out & Suppression Gate (takes precedence over EVERY trigger) ─────
  // Fail-closed: isRecipientSuppressed returns true when the lookup itself
  // errors, so an unverifiable commenter is never enqueued.
  if (isOptOutIntent(comment.text)) {
    await recordRecipientOptOut(db, {
      instagramAccountId,
      recipientId: comment.from.id,
      triggerEventId: comment.id,
      text: comment.text,
      reason: 'comment_keyword',
    });
    logEvent('warn', 'comment_opt_out', 'skipped',
      `Commenter ${comment.from.id} opted out via comment: "${comment.text.slice(0, 60)}" - suppression recorded`, {
        commentId: comment.id,
        commenterId: comment.from.id,
      });
    return 0;
  }

  if (await isRecipientSuppressed(db, instagramAccountId, comment.from.id)) {
    logEvent('info', 'comment_suppressed', 'skipped',
      `Commenter ${comment.from.id} is suppressed (opted out) - skipping automations`, {
        commentId: comment.id,
        commenterId: comment.from.id,
      });
    return 0;
  }

  const { data: automations, error } = await db
    .from('automations')
    .select('id, post_id, keywords, trigger_config, flow_graph')
    .eq('instagram_account_id', instagramAccountId)
    .eq('type', 'comment_dm')
    .eq('is_active', true)
    .eq('is_traffic_guard_paused', false);

  if (error) {
    logEvent( 'error', 'automations_fetch', 'error', `DB error fetching automations: ${error.message}`, {});
    return 0;
  }
  if (!automations?.length) {
    logEvent( 'info', 'automations_fetch', 'skipped', 'No active comment_dm automations for this account', {});
    return 0;
  }

  logEvent( 'info', 'automations_fetch', 'ok', `Checking ${automations.length} active automation(s)`, {
    automationIds: automations.map((a) => a.id),
  });

  let enqueued = 0;
  let capturedAutomationId: string | null = null;
  for (const automation of automations) {
    if (automation.post_id && automation.post_id !== comment.media.id) {
      logEvent( 'info', 'post_filter', 'skipped', `Automation ${automation.id}: different post`, {
        automationId: automation.id,
      });
      continue;
    }

    // Excluded keywords (trigger_config) veto the automation even when a
    // trigger keyword matches (release-prep processWebhook ~L242-250).
    const excluded = (automation.trigger_config as { excluded_keywords?: unknown } | null)?.excluded_keywords;
    if (Array.isArray(excluded) && excluded.length > 0 && keywordMatches(comment.text, excluded as string[])) {
      logEvent('info', 'keyword_exclude', 'skipped', `Automation ${automation.id}: comment matches excluded keyword`, {
        automationId: automation.id,
      });
      continue;
    }

    // Hardened matching: null/empty keywords NEVER match; '*ANY*' only when
    // the automation explicitly opted into wildcard mode; comments use
    // exactStandalone so "send link please" does not fire a "LINK" funnel.
    const isAnyComment = isExplicitWildcardAutomation(automation);
    if (!isAnyComment && !keywordMatches(comment.text, automation.keywords as string[] | null, { exactStandalone: true })) {
      logEvent( 'info', 'keyword_match', 'skipped', `Automation ${automation.id}: no keyword match`, {
        automationId: automation.id,
        keywords: automation.keywords ?? null,
      });
      continue;
    }

    logEvent( 'info', 'keyword_match', 'ok', `Automation ${automation.id}: ${isAnyComment ? 'any comment' : 'keyword'} matched - enqueuing`, {
      automationId: automation.id,
      isAnyComment,
    });

    const payload: AutoDmJobPayload = {
      automationId: automation.id as string,
      instagramAccountId,
      igAccountIgsid,
      ...(workspaceId ? { workspaceId } : {}),
      triggerType: 'comment',
      triggerUserId: comment.from.id,
      triggerUsername: comment.from.username ?? null,
      triggerEventId: comment.id,
      triggerTimestamp,
      postId: comment.media.id,
      commentText: comment.text,
      messageText: null,
    };

    const jobId = await enqueueJob('auto_dm', payload, `event_${automation.id}_${comment.id}`);
    if (jobId) {
      enqueued += 1;
      capturedAutomationId = capturedAutomationId ?? (automation.id as string);
      logEvent( 'info', 'job_enqueued', 'ok', `AutoDM job enqueued - ${jobId}`, { jobId });
    }
  }

  if (enqueued > 0) {
    recordContactInteraction({
      instagramAccountId,
      audienceIgUserId: comment.from.id,
      username: comment.from.username ?? null,
      triggerType: 'comment',
      automationId: capturedAutomationId,
    });
  }
  return enqueued;
}

async function processDmEvent(
  instagramAccountId: string,
  igAccountIgsid: string,
  messaging: MetaWebhookMessaging,
  ownerUserId: string,
  workspaceId: string | null = null
): Promise<number> {
  // Owner-scoped debug logging (see processCommentEvent).
  const logEvent = (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata: Record<string, unknown> = {}
  ): void =>
    debugLog('webhook', level, eventType, status, message, {
      ...metadata,
      userId: ownerUserId,
      ...(workspaceId ? { workspaceId } : {}),
    });
  // Filter echoes (our own sends), read receipts, delivery receipts
  if (messaging.message?.is_echo || messaging.read || messaging.delivery) {
    const kind = messaging.message?.is_echo ? 'echo' : messaging.read ? 'read_receipt' : 'delivery_receipt';
    logEvent( 'info', 'dm_event_filtered', 'skipped', `DM event filtered - ${kind}`, { kind });
    return 0;
  }
  // Self-messaging loop guard
  if (messaging.sender.id === messaging.recipient.id) return 0;

  const message = messaging.message;
  const triggerTimestamp = messaging.timestamp;
  const eventAgeMs = Date.now() - triggerTimestamp;

  logEvent( 'info', 'dm_event', 'processing', `DM received from ${messaging.sender.id}`, {
    senderId: messaging.sender.id,
    hasQuickReply: !!message?.quick_reply,
    hasPostback: !!messaging.postback,
  });

  if (eventAgeMs > MAX_EVENT_AGE_MS) {
    logEvent( 'warn', 'window_check', 'skipped', `DM event ${Math.round(eventAgeMs / 3600000)}h old - beyond window`, {});
    return 0;
  }

  const db = createServiceClient();

  // ── Opt-Out & Suppression Gate for inbound DMs (before ANY routing) ──────
  if (message?.text && isOptOutIntent(message.text)) {
    await recordRecipientOptOut(db, {
      instagramAccountId,
      recipientId: messaging.sender.id,
      triggerEventId: message.mid,
      text: message.text,
      reason: 'dm_keyword',
    });
    logEvent('warn', 'dm_opt_out', 'skipped',
      `User ${messaging.sender.id} opted out via DM: "${message.text.slice(0, 60)}" - suppression recorded`, {
        mid: message.mid,
        senderId: messaging.sender.id,
      });
    return 0;
  }

  if (await isRecipientSuppressed(db, instagramAccountId, messaging.sender.id)) {
    logEvent('info', 'dm_suppressed', 'skipped',
      `User ${messaging.sender.id} is suppressed (opted out) - skipping DM event`, {
        senderId: messaging.sender.id,
      });
    return 0;
  }

  // ── Priority: session button tap (quick_reply OR postback) ───────────────
  // Both carry "SESSION_{uuid}_STEP_{n}". NEVER route on message.text - the
  // visible label could collide across automations.
  const tapPayload = messaging.message?.quick_reply?.payload ?? messaging.postback?.payload;
  if (tapPayload) {
    const sessionMatch = /^SESSION_([0-9a-f-]+)_STEP_(\d+)$/i.exec(tapPayload);
    if (sessionMatch) {
      const sessionId = sessionMatch[1] as string;
      const sessionStep = parseInt(sessionMatch[2] as string, 10);
      const eventMid = message?.mid ?? `postback_${messaging.sender.id}_${triggerTimestamp}`;
      const eventText = message?.text ?? messaging.postback?.title ?? null;

      logEvent( 'info', 'quick_reply_tap', 'processing', `Button tap - session ${sessionId} step ${sessionStep}`, {
        sessionId,
        sessionStep,
        senderId: messaging.sender.id,
      });

      const { data: session, error: sessionError } = await db
        .from('automation_sessions')
        .select('id, automation_id, instagram_account_id, completed, expires_at')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionError) {
        logEvent( 'error', 'session_lookup', 'error', `DB error fetching session: ${sessionError.message}`, {
          sessionId,
        });
        // Fall through to keyword matching rather than dropping the event
      } else if (!session) {
        logEvent( 'warn', 'session_lookup', 'skipped', `Session ${sessionId} not found - tap ignored`, { sessionId });
        return 0;
      } else if ((session.instagram_account_id as string) !== instagramAccountId) {
        // Tenant ownership (Programme 17, Workstream B): the session row is
        // tenant data loaded by bare id under the service role (RLS
        // bypassed), so it must be proven to belong to THIS entry's account
        // before it can route work. A foreign session is ignored WITHOUT
        // touching it and nothing is enqueued — previously the tap payload
        // paired the foreign session's automation_id with this account,
        // and only the downstream Phase E pair check in processJob kept
        // that cross-tenant pair from sending.
        logEvent( 'error', 'tenant_context_mismatch', 'error',
          `Session ${sessionId} does not belong to this account - tap ignored`, { sessionId });
        return 0;
      } else if (session.completed || new Date(session.expires_at as string) < new Date()) {
        logEvent( 'info', 'session_lookup', 'skipped',
          `Session ${sessionId} is ${session.completed ? 'completed' : 'expired'} - tap ignored`, { sessionId });
        return 0;
      } else {
        const followUpPayload: AutoDmJobPayload = {
          automationId: session.automation_id as string,
          instagramAccountId,
          igAccountIgsid,
          ...(workspaceId ? { workspaceId } : {}),
          triggerType: 'dm_reply_followup',
          triggerUserId: messaging.sender.id,
          triggerEventId: eventMid,
          triggerTimestamp,
          postId: null,
          commentText: null,
          messageText: eventText,
          isFollowUp: true,
          sessionId,
          sessionStep,
        };
        const jobId = await enqueueJob('follow_up', followUpPayload, `followup_${sessionId}_${sessionStep}_${eventMid}`);
        logEvent( 'info', 'job_enqueued', jobId ? 'ok' : 'skipped', `Follow-up job ${jobId ? `enqueued (${jobId})` : 'duplicate - ignored'}`, {
          sessionId,
          sessionStep,
        });

        // The button tap is a verified qualifying inbound response — schedule
        // the automation's follow-up check-in message if one is configured.
        const { data: tapAutomation } = await db
          .from('automations')
          .select('id, instagram_account_id, is_active, follow_up_enabled, follow_up_delay_minutes, follow_up_message')
          .eq('id', session.automation_id)
          .maybeSingle();
        if (tapAutomation?.is_active && (tapAutomation.instagram_account_id as string) === instagramAccountId && tapAutomation.follow_up_enabled && tapAutomation.follow_up_message?.trim()) {
          await scheduleFollowUpMessage(db, {
            automationId: tapAutomation.id as string,
            instagramAccountId,
            igAccountIgsid,
            sessionId,
            recipientId: messaging.sender.id,
            qualifiedEventId: eventMid,
            qualifiedTimestamp: triggerTimestamp,
            delayMinutes: (tapAutomation.follow_up_delay_minutes as number) || 60,
            message: tapAutomation.follow_up_message as string,
          });
        }

        if (jobId) {
          recordContactInteraction({
            instagramAccountId,
            audienceIgUserId: messaging.sender.id,
            triggerType: 'button',
            automationId: session.automation_id as string,
          });
        }
        return jobId ? 1 : 0;
      }
    }
  }

  // ── Incoming Shared-Reel DM Trigger (Phase 5, row 19; release-prep) ─────
  // When a user shares a Reel into DM with the account, Meta delivers an
  // attachment with type "ig_reel", "reel", or corroborated "share" (where
  // URL/title identifies it as a Reel). Runs AFTER the opt-out/suppression
  // gate and session-tap routing above, BEFORE keyword matching — a shared
  // Reel may carry no message text at all.
  const reelAttachment = message?.attachments?.find((att) => {
    if (att.type === 'ig_reel' || att.type === 'reel') return true;
    if (att.type === 'share') {
      const url = att.payload?.url?.toLowerCase() || '';
      const title = att.payload?.title?.toLowerCase() || '';
      return url.includes('/reel/') || url.includes('/reels/') || title.includes('reel');
    }
    return false;
  });

  if (reelAttachment && message) {
    const reelId = reelAttachment.payload?.id ?? null;
    const reelUrl = reelAttachment.payload?.url ?? null;
    const reelTitle = reelAttachment.payload?.title ?? message.text ?? null;

    logEvent('info', 'shared_reel_event', 'processing',
      `Incoming shared Reel received from ${messaging.sender.id} (reelId=${reelId ?? 'unknown'})`, {
        senderId: messaging.sender.id,
        reelId,
        reelTitle: reelTitle?.slice(0, 50),
        attachmentType: reelAttachment.type,
      });

    // Query active reel_dm automations (and dm_reply automations matching this reel)
    const { data: reelAutomations, error: reelError } = await db
      .from('automations')
      .select('id, type, post_id, keywords, trigger_config, flow_graph, follow_up_enabled, follow_up_delay_minutes, follow_up_message')
      .eq('instagram_account_id', instagramAccountId)
      .in('type', ['reel_dm', 'dm_reply'])
      .eq('is_active', true);

    if (reelError) {
      logEvent('error', 'reel_automations_fetch', 'error',
        `DB error fetching reel automations: ${reelError.message}`, {});
    } else if (reelAutomations && reelAutomations.length > 0) {
      let enqueuedReel = 0;
      for (const auto of reelAutomations) {
        // Must be explicitly a reel_dm automation OR have a post_id matching reelId
        const isReelAuto = auto.type === 'reel_dm' || (auto.post_id && auto.post_id === reelId);
        if (!isReelAuto) continue;

        // Per-Reel filter: If automation targets a specific Reel, verify reelId matches
        if (auto.post_id && auto.post_id !== reelId) {
          logEvent('info', 'reel_filter', 'skipped',
            `Automation ${auto.id} targets reel ${auto.post_id}, received ${reelId}`, {
              automationId: auto.id,
              targetReelId: auto.post_id,
              receivedReelId: reelId,
            });
          continue;
        }

        // Excluded keywords veto (trigger_config), consistent with the
        // comment/DM paths restored by the safety workstream.
        const excluded = (auto.trigger_config as { excluded_keywords?: unknown } | null)?.excluded_keywords;
        const matchText = message.text || reelTitle || '';
        if (Array.isArray(excluded) && excluded.length > 0 && keywordMatches(matchText, excluded as string[])) {
          logEvent('info', 'keyword_exclude', 'skipped',
            `Automation ${auto.id}: shared-Reel message matches excluded keyword`, {
              automationId: auto.id,
            });
          continue;
        }

        // Keyword filter:
        // A reel_dm automation triggers on any shared Reel by default unless specific non-wildcard keywords are configured.
        const isWildcard = isExplicitWildcardAutomation(auto);
        const hasSpecificKeywords = Boolean(auto.keywords && auto.keywords.length > 0 && !isWildcard);

        if (hasSpecificKeywords) {
          if (!keywordMatches(matchText, auto.keywords as string[] | null)) {
            logEvent('info', 'reel_keyword_filter', 'skipped',
              `Automation ${auto.id}: keyword does not match text "${matchText}"`, {});
            continue;
          }
        }

        const payload: AutoDmJobPayload = {
          automationId: auto.id as string,
          instagramAccountId,
          igAccountIgsid,
          ...(workspaceId ? { workspaceId } : {}),
          triggerType: 'reel_dm',
          triggerUserId: messaging.sender.id,
          triggerUsername: null,
          triggerEventId: message.mid,
          triggerTimestamp,
          postId: reelId,
          commentText: null,
          messageText: reelTitle,
          sharedReelId: reelId,
          sharedReelUrl: reelUrl,
          sharedReelTitle: reelTitle,
        };

        const dedupeKey = `event_${auto.id}_${message.mid}`;
        const jobId = await enqueueJob('auto_dm', payload, dedupeKey);
        if (jobId) {
          enqueuedReel += 1;
          logEvent('info', 'job_enqueued', 'ok',
            `Shared-Reel AutoDM job enqueued - ${jobId}`, { jobId, reelId });
          recordContactInteraction({
            instagramAccountId,
            audienceIgUserId: messaging.sender.id,
            triggerType: 'button',
            automationId: auto.id as string,
          });
        }
      }

      if (enqueuedReel > 0) {
        return enqueuedReel;
      }
    }
  }

  // ── Keyword matching - story replies vs plain DMs ────────────────────────
  // A story reply arrives as a normal messaging event with message.reply_to.story
  // set. It routes ONLY to story_reply automations; plain DMs route ONLY to
  // dm_reply automations - one event never fires both types.
  if (!message?.text) {
    logEvent( 'info', 'dm_event', 'skipped', 'DM has no text - skipping keyword match', {});
    return 0;
  }

  const isStoryReply = !!message.reply_to?.story;
  const automationType = isStoryReply ? 'story_reply' : 'dm_reply';
  const triggerType = isStoryReply ? 'story_reply' : 'dm';

  if (isStoryReply) {
    logEvent( 'info', 'story_reply_event', 'processing', `Story reply received: "${message.text.slice(0, 60)}"`, {
      senderId: messaging.sender.id,
      storyId: message.reply_to?.story?.id ?? null,
    });
  }

  const { data: automations, error } = await db
    .from('automations')
    .select('id, keywords, trigger_config, flow_graph, follow_up_enabled, follow_up_delay_minutes, follow_up_message')
    .eq('instagram_account_id', instagramAccountId)
    .eq('type', automationType)
    .eq('is_active', true);

  if (error) {
    logEvent( 'error', 'automations_fetch', 'error', `DB error fetching ${automationType} automations: ${error.message}`, {});
    return 0;
  }
  if (!automations?.length) {
    logEvent( 'info', 'automations_fetch', 'skipped', `No active ${automationType} automations`, {});
    return 0;
  }

  let enqueued = 0;
  let capturedAutomationId: string | null = null;
  for (const automation of automations) {
    const excluded = (automation.trigger_config as { excluded_keywords?: unknown } | null)?.excluded_keywords;
    if (Array.isArray(excluded) && excluded.length > 0 && keywordMatches(message.text, excluded as string[])) {
      logEvent('info', 'keyword_exclude', 'skipped', `${automationType} ${automation.id}: message matches excluded keyword`, {
        automationId: automation.id,
      });
      continue;
    }

    const isAnyDm = isExplicitWildcardAutomation(automation);
    if (!isAnyDm && !keywordMatches(message.text, automation.keywords as string[] | null)) {
      logEvent( 'info', 'keyword_match', 'skipped', `${automationType} ${automation.id}: no keyword match`, {
        automationId: automation.id,
      });
      continue;
    }

    logEvent( 'info', 'keyword_match', 'ok', `${automationType} ${automation.id}: ${isAnyDm ? 'any mode' : 'keyword'} matched - enqueuing`, {
      automationId: automation.id,
      isAnyDm,
    });

    const payload: AutoDmJobPayload = {
      automationId: automation.id as string,
      instagramAccountId,
      igAccountIgsid,
      ...(workspaceId ? { workspaceId } : {}),
      triggerType,
      triggerUserId: messaging.sender.id,
      triggerUsername: null,
      triggerEventId: message.mid,
      triggerTimestamp,
      postId: null,
      commentText: null,
      messageText: message.text,
    };
    const jobId = await enqueueJob('auto_dm', payload, `event_${automation.id}_${message.mid}`);
    if (jobId) {
      enqueued += 1;
      capturedAutomationId = capturedAutomationId ?? (automation.id as string);

      // This keyword-matched DM / story reply is a qualifying inbound
      // response — schedule the follow-up check-in if configured.
      if (automation.follow_up_enabled && automation.follow_up_message?.trim()) {
        await scheduleFollowUpMessage(db, {
          automationId: automation.id as string,
          instagramAccountId,
          igAccountIgsid,
          recipientId: messaging.sender.id,
          qualifiedEventId: message.mid,
          qualifiedTimestamp: triggerTimestamp,
          delayMinutes: automation.follow_up_delay_minutes || 60,
          message: automation.follow_up_message,
        });
      }
    }
  }

  if (enqueued > 0) {
    recordContactInteraction({
      instagramAccountId,
      audienceIgUserId: messaging.sender.id,
      triggerType: isStoryReply ? 'story_reply' : 'dm',
      automationId: capturedAutomationId,
    });
  }

  if (enqueued === 0 && automations.length > 0) {
    logger.debug({ senderId: messaging.sender.id, automationType }, 'Message matched no automations');
  }
  return enqueued;
}
