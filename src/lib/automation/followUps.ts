/**
 * Scheduled follow-up messages (release-prep row 17, restored in Phase 5).
 *
 * A follow-up is a single pre-written message sent to a recipient a fixed
 * delay after a QUALIFYING inbound response (a quick-reply/postback tap, or
 * a keyword-matched DM / story reply). Comment-triggered flows only create a
 * 'waiting_response' record when the opening DM goes out — Meta allows just
 * one private reply per comment, so nothing is scheduled until the recipient
 * genuinely responds in the DM thread (the tap / DM paths above).
 *
 * Durability model:
 *  - `automation_follow_ups` is the durable record (one row per
 *    automation + recipient + qualifying event, UNIQUE-enforced).
 *  - A delayed `follow_up` job in job_queue carries the send; its dedupe key
 *    is derived from the same triple, so re-scheduling can never double-send.
 *  - The processor atomically CLAIMS the row (status scheduled/held →
 *    sending) before touching Meta; a second worker (or a retry after a
 *    successful send) finds the claim gone and skips. Exactly-once.
 *  - The cron sweep re-enqueues jobs for rows still 'scheduled' past their
 *    time (e.g. the original enqueue failed) — dedupe makes that safe.
 *
 * NO AI: follow-ups send their stored message_snapshot text only. The
 * release-prep `follow_up_ai_instructions` column/behaviour is deliberately
 * NOT ported (AI features are a separate pending owner decision).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { enqueueJob } from '@/lib/automation/queue';
import { resolveWorkspaceForAccount } from '@/lib/tenancy/context';
import type { AutoDmJobPayload } from '@/lib/types';

/**
 * Phase D1: the workspace a follow-up job should carry, resolved from the
 * parent automation/session's account binding (server-side truth). Never
 * throws and never invents: an unbound account — or any lookup failure —
 * yields null and the payload is left unstamped, exactly as before.
 */
async function followUpWorkspaceId(
  db: SupabaseClient,
  instagramAccountId: string
): Promise<string | null> {
  try {
    return await resolveWorkspaceForAccount(db, instagramAccountId);
  } catch {
    return null;
  }
}

const logger = createLogger('follow-ups');

/** Meta's 24h messaging window — a follow-up may never be scheduled past it. */
export const FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type FollowUpStatus =
  | 'waiting_response'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'skipped'
  | 'expired'
  | 'held'
  | 'failed';

export interface ScheduleFollowUpParams {
  automationId: string;
  instagramAccountId: string;
  igAccountIgsid: string;
  /** Session that qualified the recipient, when the response was a button tap. */
  sessionId?: string | null;
  recipientId: string;
  recipientUsername?: string | null;
  /** The inbound event that qualifies the recipient (tap mid or message mid). */
  qualifiedEventId: string;
  /** Unix epoch ms of the qualifying inbound event — the 24h window anchor. */
  qualifiedTimestamp: number;
  delayMinutes: number;
  message: string;
}

/**
 * Records the durable follow-up row AND enqueues its delayed send job.
 * Returns true when a send job exists for this follow-up (newly enqueued or
 * already queued by an earlier identical call).
 */
export async function scheduleFollowUpMessage(
  db: SupabaseClient,
  params: ScheduleFollowUpParams
): Promise<boolean> {
  const message = params.message.trim();
  if (!message) return false;

  const scheduledFor = new Date(params.qualifiedTimestamp + params.delayMinutes * 60_000);
  const maxAllowed = params.qualifiedTimestamp + FOLLOW_UP_WINDOW_MS;

  // Phase H (Programme 18): the durable row is stamped with the workspace
  // derived server-side from the parent account binding — never from any
  // caller/payload claim. Unbound accounts keep the legacy NULL shape.
  const workspaceId = await followUpWorkspaceId(db, params.instagramAccountId);
  const workspaceStamp = workspaceId ? { workspace_id: workspaceId } : {};

  if (scheduledFor.getTime() > maxAllowed) {
    await db.from('automation_follow_ups').upsert(
      {
        automation_id: params.automationId,
        instagram_account_id: params.instagramAccountId,
        session_id: params.sessionId ?? null,
        recipient_id: params.recipientId,
        recipient_username: params.recipientUsername ?? null,
        qualified_event_id: params.qualifiedEventId,
        qualified_timestamp: new Date(params.qualifiedTimestamp).toISOString(),
        scheduled_for: scheduledFor.toISOString(),
        status: 'skipped',
        error_reason: 'Scheduled delay exceeds 24-hour messaging window',
        message_snapshot: message,
        ...workspaceStamp,
      },
      { onConflict: 'automation_id,recipient_id,qualified_event_id' }
    );
    return false;
  }

  const { error: upsertError } = await db.from('automation_follow_ups').upsert(
    {
      automation_id: params.automationId,
      instagram_account_id: params.instagramAccountId,
      session_id: params.sessionId ?? null,
      recipient_id: params.recipientId,
      recipient_username: params.recipientUsername ?? null,
      qualified_event_id: params.qualifiedEventId,
      qualified_timestamp: new Date(params.qualifiedTimestamp).toISOString(),
      scheduled_for: scheduledFor.toISOString(),
      status: 'scheduled',
      message_snapshot: message,
      ...workspaceStamp,
    },
    { onConflict: 'automation_id,recipient_id,qualified_event_id' }
  );
  if (upsertError) {
    logger.error({ err: upsertError, automationId: params.automationId }, 'Failed to record follow-up row');
    return false;
  }

  const payload: AutoDmJobPayload = {
    automationId: params.automationId,
    instagramAccountId: params.instagramAccountId,
    igAccountIgsid: params.igAccountIgsid,
    ...(workspaceId ? { workspaceId } : {}),
    triggerType: 'dm_reply_followup',
    triggerUserId: params.recipientId,
    triggerUsername: params.recipientUsername ?? null,
    triggerEventId: `scheduled_${params.qualifiedEventId}`,
    triggerTimestamp: params.qualifiedTimestamp,
    postId: null,
    commentText: null,
    messageText: null,
    isFollowUp: true,
    sessionId: params.sessionId ?? undefined,
    sessionStep: 99,
    isScheduledFollowUp: true,
    followUpText: message,
  };

  const jobId = await enqueueJob(
    'follow_up',
    payload,
    `scheduled_followup_${params.automationId}_${params.recipientId}_${params.qualifiedEventId}`,
    scheduledFor
  );

  debugLog('worker', 'info', 'followup_scheduled', 'ok',
    `Scheduled follow-up in ${params.delayMinutes}m for ${params.recipientId}`, {
      automationId: params.automationId,
      delayMinutes: params.delayMinutes,
      scheduledFor: scheduledFor.toISOString(),
      jobId,
      ...(workspaceId ? { workspaceId } : {}),
    });
  return true;
}

/**
 * Comment-triggered flows: record the follow-up intent WITHOUT scheduling.
 * The row sits in 'waiting_response' until a qualifying inbound response
 * schedules a real send (a separate row keyed by that response's event id).
 */
export async function recordWaitingResponseFollowUp(
  db: SupabaseClient,
  params: {
    automationId: string;
    instagramAccountId: string;
    sessionId?: string | null;
    recipientId: string;
    recipientUsername?: string | null;
    commentId: string;
    commentTimestamp: number;
    delayMinutes: number;
    message: string;
  }
): Promise<void> {
  const message = params.message.trim();
  if (!message) return;
  // Phase H (Programme 18): stamp from the parent account binding, as in
  // scheduleFollowUpMessage; unbound parents keep legacy NULL.
  const workspaceId = await followUpWorkspaceId(db, params.instagramAccountId);
  const { error } = await db.from('automation_follow_ups').upsert(
    {
      automation_id: params.automationId,
      instagram_account_id: params.instagramAccountId,
      session_id: params.sessionId ?? null,
      recipient_id: params.recipientId,
      recipient_username: params.recipientUsername ?? null,
      qualified_event_id: params.commentId,
      qualified_timestamp: new Date(params.commentTimestamp).toISOString(),
      scheduled_for: new Date(params.commentTimestamp + params.delayMinutes * 60_000).toISOString(),
      status: 'waiting_response',
      message_snapshot: message,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    },
    { onConflict: 'automation_id,recipient_id,qualified_event_id' }
  );
  if (error) {
    logger.warn({ err: error, automationId: params.automationId }, 'Failed to record waiting-response follow-up');
  }
}

/** Updates the durable row for one (automation, recipient, qualifying event). */
export async function markFollowUpStatus(
  db: SupabaseClient,
  automationId: string,
  recipientId: string,
  qualifiedEventId: string,
  status: FollowUpStatus,
  errorReason: string | null,
  sentAt?: Date
): Promise<void> {
  const updatePayload: Record<string, unknown> = {
    status,
    error_reason: errorReason,
    updated_at: new Date().toISOString(),
  };
  if (sentAt) updatePayload.sent_at = sentAt.toISOString();
  const { error } = await db
    .from('automation_follow_ups')
    .update(updatePayload)
    .eq('automation_id', automationId)
    .eq('recipient_id', recipientId)
    .eq('qualified_event_id', qualifiedEventId);
  if (error) {
    logger.warn({ err: error, automationId, qualifiedEventId, status }, 'Failed to update follow-up status');
  }
}

/**
 * Atomically claims a due follow-up for sending: a single conditional UPDATE
 * (status scheduled/held → sending) matched on the unique triple. Returns the
 * claimed row, or null when another worker already claimed/sent it — the
 * caller MUST NOT send in that case (exactly-once guarantee).
 */
export async function claimFollowUpForSending(
  db: SupabaseClient,
  automationId: string,
  recipientId: string,
  qualifiedEventId: string
): Promise<{ id: string; message_snapshot: string; session_id: string | null } | null> {
  const { data, error } = await db
    .from('automation_follow_ups')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('automation_id', automationId)
    .eq('recipient_id', recipientId)
    .eq('qualified_event_id', qualifiedEventId)
    .in('status', ['scheduled', 'held'])
    .select('id, message_snapshot, session_id');
  if (error) {
    logger.error({ err: error, automationId, qualifiedEventId }, 'Follow-up claim failed');
    return null;
  }
  const rows = (data ?? []) as Array<{ id: string; message_snapshot: string; session_id: string | null }>;
  return rows[0] ?? null;
}

/**
 * Cron safety net: re-enqueue send jobs for follow-up rows that are due and
 * still 'scheduled' (their original enqueue may have failed, or the job may
 * have exhausted retries while the row was reset). The job_queue dedupe key
 * makes re-enqueueing a no-op when the job already exists.
 */
export async function sweepDueFollowUps(limit = 25): Promise<number> {
  const db = createServiceClient();
  const { data: rows, error } = await db
    .from('automation_follow_ups')
    .select(
      'automation_id, instagram_account_id, session_id, recipient_id, recipient_username, qualified_event_id, qualified_timestamp, scheduled_for, message_snapshot'
    )
    .eq('status', 'scheduled')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limit);

  if (error || !rows?.length) return 0;

  // The job payload needs the account's IGSID — resolve accounts in one pass.
  // Phase D1: the same pass also carries each account's workspace binding
  // (…000026) so re-enqueued follow-ups are stamped like fresh ones.
  const accountIds = [...new Set(rows.map((r) => r.instagram_account_id as string))];
  const { data: accounts } = await db
    .from('instagram_accounts')
    .select('id, instagram_user_id, workspace_id')
    .in('id', accountIds);
  const igsidById = new Map((accounts ?? []).map((a) => [a.id as string, a.instagram_user_id as string]));
  const workspaceById = new Map(
    (accounts ?? []).map((a) => [
      a.id as string,
      typeof a.workspace_id === 'string' && a.workspace_id.length > 0 ? (a.workspace_id as string) : null,
    ])
  );

  let requeued = 0;
  for (const row of rows) {
    const igsid = igsidById.get(row.instagram_account_id as string);
    if (!igsid) continue;
    const workspaceId = workspaceById.get(row.instagram_account_id as string) ?? null;
    const payload: AutoDmJobPayload = {
      automationId: row.automation_id as string,
      instagramAccountId: row.instagram_account_id as string,
      igAccountIgsid: igsid,
      ...(workspaceId ? { workspaceId } : {}),
      triggerType: 'dm_reply_followup',
      triggerUserId: row.recipient_id as string,
      triggerUsername: (row.recipient_username as string | null) ?? null,
      triggerEventId: `scheduled_${row.qualified_event_id as string}`,
      triggerTimestamp: new Date(row.qualified_timestamp as string).getTime(),
      postId: null,
      commentText: null,
      messageText: null,
      isFollowUp: true,
      sessionId: (row.session_id as string | null) ?? undefined,
      sessionStep: 99,
      isScheduledFollowUp: true,
      followUpText: row.message_snapshot as string,
    };
    const jobId = await enqueueJob(
      'follow_up',
      payload,
      `scheduled_followup_${row.automation_id as string}_${row.recipient_id as string}_${row.qualified_event_id as string}`,
      new Date(row.scheduled_for as string)
    );
    if (jobId) requeued += 1;
  }
  return requeued;
}
