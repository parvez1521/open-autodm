/**
 * Area 10 — Meta error classification + engine retry/rate-limit handling.
 *
 * (a) classifyMetaError (src/lib/instagram/errors.ts) — pure.
 * (b) processDueJobs (src/lib/automation/engine.ts) with the queue and job
 *     processors mocked: verifies the engine's response per error class —
 *     368 → pause account 24h + fail job; [190,10,100,200] → fail, no retry;
 *     [4,17,32,613] → reschedule after exactly 15 min WITHOUT counting an
 *     attempt; local RateLimitDelay → reschedule for the limiter's own
 *     retry-after, no attempt counted; generic error → counted retry with
 *     retryBackoffMs backoff.
 *
 * NOTE (partial coverage): checkRateLimit itself is not exported from
 * processJob.ts, so the limiter's RPC decision is covered here at the
 * engine boundary via RateLimitDelay; the real 180/hr constant is asserted
 * in rate-limit.test.ts against the unmocked module. The limiter RPC runs
 * in Postgres and cannot be unit-tested without a database.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  classifyMetaError,
  MetaApiError,
  NonRetryableMetaError,
  AccountPausedMetaError,
  NON_RETRYABLE_CODES,
  ACCOUNT_PAUSE_CODES,
  META_RATE_LIMIT_CODES,
} from '@/lib/instagram/errors';
import type { JobQueueRow } from '@/lib/types';

// ── Engine harness ──────────────────────────────────────────────────────────

vi.mock('@/lib/automation/queue', () => ({
  claimDueJobs: vi.fn(),
  markJobDone: vi.fn(async () => {}),
  markJobFailed: vi.fn(async () => {}),
  rescheduleJob: vi.fn(async () => {}),
  // Same formula as the real implementation (unit-tested for real in
  // queue-idempotency.test.ts); duplicated here so the engine test can
  // assert the exact delay the engine asks for.
  retryBackoffMs: (attempts: number) => 5000 * Math.pow(5, Math.max(0, attempts - 1)),
}));

vi.mock('@/lib/automation/processJob', () => {
  class RateLimitDelay extends Error {
    constructor(
      public readonly retryAfterMs: number,
      public readonly currentCount: number
    ) {
      super(`Rate limit reached (${currentCount}/180/h)`);
      this.name = 'RateLimitDelay';
    }
  }
  class AccountOnPause extends Error {
    constructor(public readonly resumeAtMs: number) {
      super('Account is paused by the safety circuit breaker');
      this.name = 'AccountOnPause';
    }
  }
  return {
    processAutoDmJob: vi.fn(),
    processFollowUpDmJob: vi.fn(),
    pauseAccount: vi.fn(async () => {}),
    RateLimitDelay,
    AccountOnPause,
  };
});
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import { processDueJobs } from '@/lib/automation/engine';
import { RateLimitDelay, AccountOnPause, processAutoDmJob, pauseAccount } from '@/lib/automation/processJob';
import { claimDueJobs, markJobDone, markJobFailed, rescheduleJob } from '@/lib/automation/queue';

const mockClaim = vi.mocked(claimDueJobs);
const mockDone = vi.mocked(markJobDone);
const mockFailed = vi.mocked(markJobFailed);
const mockReschedule = vi.mocked(rescheduleJob);
const mockProcess = vi.mocked(processAutoDmJob);
const mockPause = vi.mocked(pauseAccount);

function makeJob(overrides: Partial<JobQueueRow> = {}): JobQueueRow {
  return {
    id: 'job-1',
    job_type: 'auto_dm',
    payload: {
      automationId: 'auto-1',
      instagramAccountId: 'acct-1',
      igAccountIgsid: 'IG-OWNER',
      triggerType: 'comment',
      triggerUserId: 'IG-FAN',
      triggerEventId: 'evt-1',
      triggerTimestamp: 1762000000000,
      postId: 'post-1',
      commentText: 'LINK',
      messageText: null,
    },
    dedupe_key: 'dedupe-1',
    status: 'processing',
    run_after: new Date().toISOString(),
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    locked_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockClaim.mockReset();
  mockDone.mockClear();
  mockFailed.mockClear();
  mockReschedule.mockClear();
  mockProcess.mockReset();
  mockPause.mockClear();
});

// ── (a) classification ──────────────────────────────────────────────────────

describe('classifyMetaError', () => {
  it('classifies 368 as an account-pause (circuit breaker) error', () => {
    const err = classifyMetaError('blocked for policy', 368, undefined);
    expect(err).toBeInstanceOf(AccountPausedMetaError);
    expect(ACCOUNT_PAUSE_CODES).toEqual([368]);
  });

  it.each([190, 10, 100, 200])('classifies %i as non-retryable', (code) => {
    expect(classifyMetaError('nope', code, undefined)).toBeInstanceOf(NonRetryableMetaError);
    expect(NON_RETRYABLE_CODES).toContain(code);
  });

  it.each([4, 17, 32, 613])('classifies %i as a plain (retryable) MetaApiError in the rate-limit set', (code) => {
    const err = classifyMetaError('slow down', code, undefined);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).not.toBeInstanceOf(NonRetryableMetaError);
    expect(err).not.toBeInstanceOf(AccountPausedMetaError);
    expect(META_RATE_LIMIT_CODES).toContain(code);
  });

  it('classifies unknown / missing codes as plain retryable MetaApiError', () => {
    expect(classifyMetaError('???', 999, undefined)).toBeInstanceOf(MetaApiError);
    const noCode = classifyMetaError('???', undefined, undefined);
    expect(noCode).toBeInstanceOf(MetaApiError);
    expect(noCode).not.toBeInstanceOf(NonRetryableMetaError);
  });
});

// ── (b) engine behaviour per error class ────────────────────────────────────

describe('processDueJobs error handling', () => {
  it('marks a successful job done', async () => {
    mockClaim.mockResolvedValue([makeJob()]);
    mockProcess.mockResolvedValue(undefined);
    const result = await processDueJobs(5);
    expect(result).toMatchObject({ claimed: 1, done: 1, failed: 0, rescheduled: 0 });
    expect(mockDone).toHaveBeenCalledWith('job-1');
  });

  it('RateLimitDelay → reschedule for the limiter retry-after, attempt NOT counted', async () => {
    const job = makeJob();
    mockClaim.mockResolvedValue([job]);
    mockProcess.mockRejectedValue(new RateLimitDelay(1_800_000, 180));
    const result = await processDueJobs(5);
    expect(result.rescheduled).toBe(1);
    expect(mockReschedule).toHaveBeenCalledWith(job, 1_800_000, null, false);
    expect(mockFailed).not.toHaveBeenCalled();
  });

  it('AccountOnPause → reschedule shortly after the pause lifts, attempt NOT counted', async () => {
    const job = makeJob();
    mockClaim.mockResolvedValue([job]);
    mockProcess.mockRejectedValue(new AccountOnPause(Date.now() + 600_000));
    const result = await processDueJobs(5);
    expect(result.rescheduled).toBe(1);
    const call = mockReschedule.mock.calls[0]! as unknown as [JobQueueRow, number, string, boolean];
    expect(call[0]).toBe(job);
    expect(call[1]).toBeGreaterThanOrEqual(600_000);
    expect(call[3]).toBe(false);
  });

  it('Meta code 368 (AccountPausedMetaError) → pauses the account and fails the job, no retry', async () => {
    const job = makeJob();
    mockClaim.mockResolvedValue([job]);
    mockProcess.mockRejectedValue(classifyMetaError('policy block', 368, undefined));
    const result = await processDueJobs(5);
    expect(result.failed).toBe(1);
    expect(mockPause).toHaveBeenCalledWith('acct-1', expect.stringContaining('code 368'));
    expect(mockFailed).toHaveBeenCalledWith('job-1', 'policy block');
    expect(mockReschedule).not.toHaveBeenCalled();
  });

  it.each([190, 10, 100, 200])('non-retryable code %i → job failed immediately, never rescheduled', async (code) => {
    mockClaim.mockResolvedValue([makeJob()]);
    mockProcess.mockRejectedValue(classifyMetaError('fatal', code, undefined));
    const result = await processDueJobs(5);
    expect(result.failed).toBe(1);
    expect(mockFailed).toHaveBeenCalledWith('job-1', 'fatal');
    expect(mockReschedule).not.toHaveBeenCalled();
  });

  it.each([4, 17, 32, 613])(
    'Meta rate-limit code %i → rescheduled after exactly 15 minutes, attempt NOT counted',
    async (code) => {
      const job = makeJob();
      mockClaim.mockResolvedValue([job]);
      mockProcess.mockRejectedValue(classifyMetaError('rate limited', code, undefined));
      const result = await processDueJobs(5);
      expect(result.rescheduled).toBe(1);
      expect(mockReschedule).toHaveBeenCalledWith(job, 15 * 60_000, `Meta rate limit (code ${code})`, false);
      expect(mockFailed).not.toHaveBeenCalled();
    }
  );

  it('generic transient error → counted retry with retryBackoffMs (attempt 1 → 5s)', async () => {
    const job = makeJob({ attempts: 0 });
    mockClaim.mockResolvedValue([job]);
    mockProcess.mockRejectedValue(new Error('socket hangup'));
    const result = await processDueJobs(5);
    expect(result.rescheduled).toBe(1);
    expect(mockReschedule).toHaveBeenCalledWith(job, 5_000, 'socket hangup', true);
  });
});
