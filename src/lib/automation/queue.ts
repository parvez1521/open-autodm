/**
 * Postgres-native job queue (replaces BullMQ + Redis).
 *
 * Jobs live in the job_queue table. Claiming uses the claim_due_jobs RPC
 * (FOR UPDATE SKIP LOCKED) so any number of concurrent serverless invocations
 * can drain the queue without double-processing.
 *
 * Idempotency: dedupe_key is unique - Meta webhook retries for the same event
 * can never create a second job (mirrors BullMQ's jobId dedupe).
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import type { AutoDmJobPayload, JobQueueRow } from '@/lib/types';

const logger = createLogger('queue');

/** Retry backoff: 5s → 25s → 125s (matches the original BullMQ config). */
export function retryBackoffMs(attempts: number): number {
  return 5000 * Math.pow(5, Math.max(0, attempts - 1));
}

export async function enqueueJob(
  jobType: 'auto_dm' | 'follow_up',
  payload: AutoDmJobPayload,
  dedupeKey: string,
  runAfter?: Date
): Promise<string | null> {
  const db = createServiceClient();

  // ── Phase F/H (Programme 18): verified workspace derivation ─────────────
  // A payload workspaceId is an ASSERTION, never evidence (same rule as
  // processJob). When the account row can be read, its workspace_id
  // binding (…000026) is the server-side truth:
  //   - payload asserts a DIFFERENT workspace than the binding ⇒ fail
  //     closed: nothing is enqueued (mirrors 'tenant_context_mismatch').
  //   - payload asserts none but the account is bound ⇒ the derived
  //     workspace is stamped onto the payload copy + the row column.
  //   - account explicitly unbound (workspace_id NULL) + no assertion ⇒
  //     legacy shape, unstamped.
  // When the account row cannot be read at all (missing row / lookup
  // error — e.g. pre-tenancy deployments and unit harnesses that enqueue
  // without seeding accounts), derivation is INDETERMINATE and the
  // pre-P18 payload behaviour is preserved; processJob still re-derives
  // and fails closed at execution time, so this fallback can never
  // authorize a send.
  let effectivePayload = payload;
  try {
    const { data: accountRow, error: accountError } = await db
      .from('instagram_accounts')
      .select('workspace_id')
      .eq('id', payload.instagramAccountId)
      .maybeSingle();
    if (!accountError && accountRow) {
      const derived =
        typeof accountRow.workspace_id === 'string' && accountRow.workspace_id.length > 0
          ? (accountRow.workspace_id as string)
          : null;
      if (payload.workspaceId && payload.workspaceId !== derived) {
        logger.error(
          { dedupeKey, payloadWorkspaceId: payload.workspaceId, actualWorkspaceId: derived },
          'enqueueJob refused - payload workspace does not match account binding'
        );
        debugLog('webhook', 'error', 'tenant_context_mismatch', 'error',
          'enqueueJob refused: payload workspace does not match the account workspace binding', {
            dedupeKey,
            instagramAccountId: payload.instagramAccountId,
            payloadWorkspaceId: payload.workspaceId,
            actualWorkspaceId: derived,
          });
        return null;
      }
      if (!payload.workspaceId && derived) {
        effectivePayload = { ...payload, workspaceId: derived };
      }
    }
  } catch {
    // Indeterminate derivation — legacy fallback documented above.
  }

  const insertData: Record<string, unknown> = { job_type: jobType, payload: effectivePayload, dedupe_key: dedupeKey };
  // Phase D1: stamp the row's workspace_id column (…000032) from the
  // VERIFIED workspace context (Programme 18: the derived value above,
  // which equals the payload assertion whenever both exist). Absent for
  // unbound accounts — the insert then stays byte-for-byte the legacy shape.
  if (effectivePayload.workspaceId) {
    insertData.workspace_id = effectivePayload.workspaceId;
  }
  if (runAfter) {
    insertData.run_after = runAfter.toISOString();
  }
  const { data, error } = await db
    .from('job_queue')
    .insert(insertData)
    .select('id')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      // Duplicate event (Meta webhook retry) - already queued or processed
      logger.info({ dedupeKey }, 'Job already exists - duplicate event ignored');
      return null;
    }
    logger.error({ err: error, dedupeKey }, 'Failed to enqueue job');
    debugLog('webhook', 'error', 'job_enqueue_error', 'error', `job_queue insert failed: ${error.message}`, {
      dedupeKey,
      error: error.message,
    });
    return null;
  }
  return (data?.id as string) ?? null;
}

/** Atomically claims up to `limit` due jobs for this invocation. */
export async function claimDueJobs(limit: number): Promise<JobQueueRow[]> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('claim_due_jobs', { p_limit: limit });
  if (error) {
    logger.error({ err: error }, 'claim_due_jobs RPC failed');
    return [];
  }
  return (data ?? []) as JobQueueRow[];
}

export async function markJobDone(jobId: string): Promise<void> {
  const db = createServiceClient();
  await db.from('job_queue').update({ status: 'done', locked_at: null }).eq('id', jobId);
}

/**
 * Parks a job in the 'held' state (Traffic Guard pause). Held jobs are never
 * claimed, never counted as failed, and are moved back to 'pending' by the
 * Traffic Guard resume RPC — nothing is dropped.
 */
export async function markJobHeld(jobId: string, reason: string): Promise<void> {
  const db = createServiceClient();
  await db
    .from('job_queue')
    .update({ status: 'held', locked_at: null, last_error: reason.slice(0, 500) })
    .eq('id', jobId);
}

export async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  const db = createServiceClient();
  await db
    .from('job_queue')
    .update({ status: 'failed', locked_at: null, last_error: errorMessage.slice(0, 2000) })
    .eq('id', jobId);
}

/**
 * Re-schedules a job. `countAttempt=false` is used for rate-limit delays -
 * waiting for the window to free up is not a failure.
 */
export async function rescheduleJob(
  job: JobQueueRow,
  delayMs: number,
  errorMessage: string | null,
  countAttempt: boolean
): Promise<void> {
  const db = createServiceClient();
  const attempts = countAttempt ? job.attempts + 1 : job.attempts;

  if (countAttempt && attempts >= job.max_attempts) {
    await markJobFailed(job.id, errorMessage ?? 'Max attempts exceeded');
    return;
  }

  await db
    .from('job_queue')
    .update({
      status: 'pending',
      locked_at: null,
      attempts,
      run_after: new Date(Date.now() + delayMs).toISOString(),
      last_error: errorMessage ? errorMessage.slice(0, 2000) : job.last_error,
    })
    .eq('id', job.id);
}
