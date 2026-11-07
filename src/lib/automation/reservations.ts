/**
 * Comment reply reservations — Phase 6 port of release-prep's pre-send
 * reservation system (row 13), adapted to the candidate.
 *
 * WHY: the candidate's original dedupe records a send AT/AFTER the send
 * (`dm_sent_log` insert in processJob, after the Meta call returns). A
 * worker crash in the window between "Meta accepted the private reply"
 * and "dm_sent_log row written" loses the only record, so the job's
 * reclaim/retry sends a DUPLICATE. A reservation reverses the order:
 *
 *   1. RESERVE  — atomically claim (instagram_account_id, comment_id) in
 *      Postgres BEFORE any Meta call. The UNIQUE constraint makes the
 *      claim race-free across concurrent workers AND across different
 *      automations on the same account (Meta allows at most ONE private
 *      reply per comment, account-wide — `dm_sent_log` dedupe is only
 *      per-automation, so it cannot enforce this on its own).
 *   2. SEND     — only the reservation holder may call Meta.
 *   3. CONFIRM  — on success the reservation becomes 'sent' (terminal).
 *      RELEASE  — when the send provably never happened / was definitively
 *      rejected before delivery (pre-send errors, Meta rate-limit codes),
 *      the reservation row is deleted so a later retry can re-reserve.
 *      FAIL     — on definitive permanent errors and on AMBIGUOUS outcomes
 *      (send initiated, outcome unknown) the reservation becomes 'failed'
 *      (terminal) and the comment is never re-authorized. Fail closed:
 *      losing one DM beats delivering a duplicate.
 *
 * STALE RESERVATIONS: a 'reserved' row older than STALE_RESERVATION_MS
 * (10 minutes, mirroring the SQL RPC) whose owner never confirmed is
 * transitioned to 'failed' (reason 'stale_unconfirmed_abandoned') by the
 * next reserve attempt and is NEVER re-authorized — the crashed worker
 * may have delivered before dying, and that is indistinguishable from
 * "crashed before sending". The reservation therefore never blocks
 * forever (it reaches a terminal state), but the comment's DM is
 * sacrificed. This is release-prep's exact behaviour, preserved by the
 * owner's Phase 6 decision.
 *
 * SCOPE (adaptations vs release-prep, individually reviewed):
 *  - Private-reply reservations apply only to the INITIAL comment contact
 *    (triggerType 'comment', not a flow/follow-up continuation).
 *    Continuations send via `{ id: triggerUserId }`, never via
 *    `{ commentId }` (see flowEngine's isInitialCommentContact), so they
 *    are not private replies and must not consume/block on the
 *    reservation. Release-prep reserves unconditionally for comment
 *    triggers; applying that verbatim here would break the candidate's
 *    restored flow continuations, whose reservation is already 'sent'.
 *  - DM / story / follow-up sends are NOT reservation-guarded (they were
 *    not in release-prep either): they rely on job_queue dedupe_key,
 *    dm_sent_log, session state and — for scheduled follow-ups — the
 *    atomic claim in followUps.ts.
 *  - Helpers live in this module instead of inside processJob.ts
 *    (candidate structure); signatures and RPC names are release-prep's.
 *  - Private reserve THROWS on RPC error (release-prep semantics: the
 *    send must not proceed when authorization cannot be established).
 *    Public reserve returns authorized:false on RPC error (release-prep
 *    semantics: a public-reply failure never blocks the private DM).
 *  - Confirm/release/mark-failed log-and-swallow RPC errors, exactly as
 *    release-prep: after a successful send, a failed confirm leaves the
 *    row 'reserved' → stale → 'failed', which still blocks any duplicate
 *    (see phase6-reservation.md for the guarantee analysis).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';
import {
  MetaApiError,
  AccountPausedMetaError,
  NonRetryableMetaError,
  META_RATE_LIMIT_CODES,
} from '@/lib/instagram/errors';
import { resolveWorkspaceForAccount } from '@/lib/tenancy/context';

const logger = createLogger('worker');

/**
 * Phase H (Programme 18): the reservation RPCs (…000020) predate tenancy
 * and insert reservation rows without workspace_id. After a successful
 * reserve, stamp the row with the workspace derived server-side from the
 * parent account binding. Best-effort by design (mirrors the
 * confirm/release log-and-swallow convention): a stamp failure leaves the
 * row NULL — it never changes the reservation outcome. Unbound accounts
 * get no stamp (legacy NULL).
 */
async function stampReservationWorkspace(
  db: SupabaseClient,
  table: 'comment_private_reply_reservations' | 'comment_public_reply_reservations',
  accountId: string,
  commentId: string
): Promise<void> {
  try {
    const workspaceId = await resolveWorkspaceForAccount(db, accountId);
    if (!workspaceId) return;
    const { error } = await db
      .from(table)
      .update({ workspace_id: workspaceId })
      .eq('instagram_account_id', accountId)
      .eq('comment_id', commentId);
    if (error) logger.warn({ err: error, accountId, commentId }, 'reservation workspace stamp failed');
  } catch (err) {
    logger.warn({ err, accountId, commentId }, 'reservation workspace stamp threw');
  }
}

/** Mirrors the stale interval inside the reserve RPCs (migration …000020). */
export const STALE_RESERVATION_MS = 10 * 60 * 1000;

export interface ReservationResult {
  authorized: boolean;
  status: string;
  reason: string;
}

// ── Comment Private Reply Reservation Helpers (release-prep, verbatim logic) ──

export async function reserveCommentPrivateReply(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  automationId: string
): Promise<ReservationResult> {
  const { data, error } = await db.rpc('reserve_comment_private_reply', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_automation_id: automationId,
  });
  if (error) {
    logger.error({ err: error, accountId, commentId, automationId }, 'Failed to invoke reserve_comment_private_reply');
    throw new Error(`Reservation RPC error: ${error.message}`);
  }
  const result = data as ReservationResult;
  if (result.authorized) {
    await stampReservationWorkspace(db, 'comment_private_reply_reservations', accountId, commentId);
  }
  return result;
}

export async function confirmCommentPrivateReply(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  automationId: string
): Promise<void> {
  const { error } = await db.rpc('confirm_comment_private_reply_sent', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_automation_id: automationId,
  });
  if (error) {
    logger.warn({ err: error, accountId, commentId, automationId }, 'Failed to confirm comment private reply sent');
  }
}

export async function releaseCommentPrivateReply(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  automationId: string
): Promise<void> {
  const { error } = await db.rpc('release_comment_private_reply', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_automation_id: automationId,
  });
  if (error) {
    logger.warn({ err: error, accountId, commentId, automationId }, 'Failed to release comment private reply reservation');
  }
}

export async function markCommentPrivateReplyFailed(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  automationId: string,
  reason?: string
): Promise<void> {
  const { error } = await db.rpc('mark_comment_private_reply_failed', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_automation_id: automationId,
    p_failure_reason: reason ?? null,
  });
  if (error) {
    logger.warn({ err: error, accountId, commentId, automationId }, 'Failed to mark comment private reply failed');
  }
}

// ── Comment Public Reply Reservation Helpers (release-prep, verbatim logic) ──

export async function reserveCommentPublicReply(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  automationId: string
): Promise<ReservationResult> {
  const { data, error } = await db.rpc('reserve_comment_public_reply', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_automation_id: automationId,
  });
  if (error) {
    logger.error({ err: error, accountId, commentId, automationId }, 'Failed to invoke reserve_comment_public_reply');
    return { authorized: false, status: 'error', reason: error.message };
  }
  const result = data as ReservationResult;
  if (result.authorized) {
    await stampReservationWorkspace(db, 'comment_public_reply_reservations', accountId, commentId);
  }
  return result;
}

export async function confirmCommentPublicReply(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  replyCommentId?: string
): Promise<void> {
  const { error } = await db.rpc('confirm_comment_public_reply_sent', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_reply_comment_id: replyCommentId ?? null,
  });
  if (error) {
    logger.warn({ err: error, accountId, commentId }, 'Failed to confirm comment public reply sent');
  }
}

export async function releaseCommentPublicReply(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  automationId: string
): Promise<void> {
  const { error } = await db.rpc('release_comment_public_reply', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_automation_id: automationId,
  });
  if (error) {
    logger.warn({ err: error, accountId, commentId, automationId }, 'Failed to release comment public reply reservation');
  }
}

export async function markCommentPublicReplyFailed(
  db: SupabaseClient,
  accountId: string,
  commentId: string,
  reason?: string
): Promise<void> {
  const { error } = await db.rpc('mark_comment_public_reply_failed', {
    p_instagram_account_id: accountId,
    p_comment_id: commentId,
    p_failure_reason: reason ?? null,
  });
  if (error) {
    logger.warn({ err: error, accountId, commentId }, 'Failed to mark comment public reply failed');
  }
}

// ── Error disposition (release-prep catch-block taxonomy, factored out) ──────

/**
 * What to do with a held private-reply reservation when the guarded
 * section throws:
 *  - 'release'     — the send provably did not deliver (nothing was
 *    initiated yet, or Meta definitively rejected it with a rate-limit
 *    code before processing): delete the reservation; a retry may
 *    re-reserve and send exactly once.
 *  - 'mark_failed' — Meta definitively rejected the send permanently
 *    (policy block / non-retryable): terminal 'failed', never retry.
 *  - 'ambiguous'   — the send was initiated and the outcome is unknown:
 *    terminal 'failed' + AmbiguousDeliveryError; never retry.
 */
export type ReservationDisposition = 'release' | 'mark_failed' | 'ambiguous';

export function reservationDispositionForError(
  err: unknown,
  sendAttemptInitiated: boolean
): ReservationDisposition {
  if (!sendAttemptInitiated) return 'release';
  if (
    err instanceof MetaApiError &&
    err.code !== undefined &&
    (META_RATE_LIMIT_CODES as readonly number[]).includes(err.code)
  ) {
    return 'release';
  }
  if (err instanceof AccountPausedMetaError || err instanceof NonRetryableMetaError) {
    return 'mark_failed';
  }
  return 'ambiguous';
}
