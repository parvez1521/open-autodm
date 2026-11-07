/**
 * Queue engine - claims due jobs and runs them with full error classification.
 *
 * Called from two places:
 *  1. The webhook route (via `after()`) right after enqueuing new jobs - this
 *     is the fast path: 95% of DMs send seconds after the comment.
 *  2. The cron endpoint - drains delayed jobs (rate-limit overflow, retries)
 *     and acts as the safety net if a webhook invocation died mid-flight.
 */

import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { claimDueJobs, markJobDone, markJobFailed, markJobHeld, rescheduleJob, retryBackoffMs } from '@/lib/automation/queue';
import {
  processAutoDmJob,
  processFollowUpDmJob,
  pauseAccount,
  RateLimitDelay,
  AccountOnPause,
} from '@/lib/automation/processJob';
import { AccountOnTrafficGuardPause } from '@/lib/automation/trafficGuardError';
import { AccountPausedMetaError, NonRetryableMetaError, AmbiguousDeliveryError, MetaApiError, META_RATE_LIMIT_CODES } from '@/lib/instagram/errors';
import type { JobQueueRow } from '@/lib/types';

const logger = createLogger('engine');

export interface DrainResult {
  claimed: number;
  done: number;
  rescheduled: number;
  failed: number;
  held: number;
}

/**
 * Wall-clock budget for one drain. Routes run with maxDuration = 60s and a
 * multi-response flow can take ~15s, so stop starting new jobs well before
 * the platform kills the invocation (which would strand claimed jobs in
 * 'processing' until the 10-minute stale-lock sweep).
 */
const DEFAULT_DRAIN_BUDGET_MS = 40_000;

export async function processDueJobs(limit: number, budgetMs = DEFAULT_DRAIN_BUDGET_MS): Promise<DrainResult> {
  const deadline = Date.now() + budgetMs;
  const jobs = await claimDueJobs(limit);
  const result: DrainResult = { claimed: jobs.length, done: 0, rescheduled: 0, failed: 0, held: 0 };

  // Sequential on purpose: preserves jitter spacing between sends and keeps a
  // single invocation from bursting DMs to Meta in parallel.
  for (const [idx, job] of jobs.entries()) {
    if (Date.now() >= deadline) {
      // Out of time - hand the rest back immediately so the next drain picks them up.
      await Promise.all(jobs.slice(idx).map((j) => rescheduleJob(j, 0, null, false)));
      result.rescheduled += jobs.length - idx;
      break;
    }
    await runJob(job, result);
  }

  if (result.claimed > 0) {
    logger.info({ ...result }, 'Queue drain finished');
  }
  return result;
}

async function runJob(job: JobQueueRow, result: DrainResult): Promise<void> {
  // ── Phase F (Programme 18): claim-time workspace cross-check ────────────
  // The job_queue row's workspace_id column and the payload's workspaceId
  // were both stamped at enqueue from the verified binding. If they now
  // DISAGREE, the row/payload pair was tampered with or rebound
  // inconsistently — fail the job closed without processing it (the
  // processors would refuse on the account-binding check anyway; this
  // stops the work one layer earlier and leaves an audit event). When
  // only the column carries a workspace, it is adopted into the payload —
  // still only an assertion, re-derived by processJob before any send.
  const rowWorkspaceId =
    typeof job.workspace_id === 'string' && job.workspace_id.length > 0 ? job.workspace_id : null;
  if (rowWorkspaceId && job.payload.workspaceId && rowWorkspaceId !== job.payload.workspaceId) {
    debugLog('worker', 'error', 'tenant_context_mismatch', 'error',
      'Claimed job row workspace does not match its payload workspace - failing closed', {
        jobId: job.id,
        rowWorkspaceId,
        payloadWorkspaceId: job.payload.workspaceId,
      });
    await markJobFailed(job.id, 'Tenant context mismatch: job row workspace does not match payload workspace');
    result.failed += 1;
    return;
  }
  if (rowWorkspaceId && !job.payload.workspaceId) {
    job.payload.workspaceId = rowWorkspaceId;
  }

  try {
    if (job.job_type === 'follow_up') {
      await processFollowUpDmJob(job.payload);
    } else {
      await processAutoDmJob(job.payload, job.attempts + 1);
    }
    await markJobDone(job.id);
    result.done += 1;
  } catch (err) {
    if (err instanceof RateLimitDelay) {
      // Hourly window full - wait it out. Not a failure, no attempt counted.
      await rescheduleJob(job, err.retryAfterMs, null, false);
      result.rescheduled += 1;
      return;
    }

    if (err instanceof AccountOnTrafficGuardPause) {
      // Traffic Guard pause — park the job as HELD (not failed, not dropped,
      // no attempt counted). The resume RPC returns held jobs to 'pending'.
      await markJobHeld(job.id, 'Held by Traffic Guard pause');
      result.held += 1;
      return;
    }

    if (err instanceof AccountOnPause) {
      // Circuit breaker is open - try again shortly after it closes.
      const delayMs = Math.max(60_000, err.resumeAtMs - Date.now() + 60_000);
      await rescheduleJob(job, delayMs, 'Account paused by circuit breaker', false);
      result.rescheduled += 1;
      return;
    }

    if (err instanceof AccountPausedMetaError) {
      // Meta says this account is policy-blocked - open the breaker for 24h
      // and stop retrying. Protecting the creator's account beats delivering
      // one more DM.
      await pauseAccount(
        job.payload.instagramAccountId,
        `Meta policy block (code ${err.code}${err.subcode ? `/${err.subcode}` : ''}): ${err.message}`
      );
      await markJobFailed(job.id, err.message);
      result.failed += 1;
      return;
    }

    if (err instanceof NonRetryableMetaError) {
      debugLog('worker', 'error', 'job_failed', 'error',
        `Non-retryable Meta error - code ${err.code}: ${err.message}`,
        { jobId: job.id, metaCode: err.code, hint: 'Code 190 = expired token, 10 = permission denied, 100 = invalid param' });
      await markJobFailed(job.id, err.message);
      result.failed += 1;
      return;
    }

    if (err instanceof AmbiguousDeliveryError) {
      // Phase 6 (release-prep parity): the send may have reached Meta and
      // the reservation has already been failed closed — retrying could
      // deliver a duplicate. Fail the job terminally, never reschedule.
      debugLog('worker', 'error', 'job_failed', 'error',
        `Ambiguous delivery error - failing closed to prevent duplicate private reply: ${err.message}`,
        { jobId: job.id });
      await markJobFailed(job.id, err.message);
      result.failed += 1;
      return;
    }

    if (err instanceof MetaApiError && err.code !== undefined && (META_RATE_LIMIT_CODES as readonly number[]).includes(err.code)) {
      // Meta-side rate limiting - back off generously without burning attempts.
      await rescheduleJob(job, 15 * 60_000, `Meta rate limit (code ${err.code})`, false);
      result.rescheduled += 1;
      return;
    }

    // Anything else: transient - retry with exponential backoff.
    const message = err instanceof Error ? err.message : String(err);
    debugLog('worker', 'error', 'job_retry', 'error', `Job errored (attempt ${job.attempts + 1}/${job.max_attempts}) - ${message}`, {
      jobId: job.id,
    });
    await rescheduleJob(job, retryBackoffMs(job.attempts + 1), message, true);
    result.rescheduled += 1;
  }
}
