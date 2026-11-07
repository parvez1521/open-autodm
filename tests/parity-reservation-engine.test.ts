/**
 * Phase 6 — engine handling of AmbiguousDeliveryError
 * (src/lib/automation/engine.ts). Harness mirrors errors-engine.test.ts:
 * queue + processors are mocked; the error classes are the REAL ones from
 * src/lib/instagram/errors.ts (the engine's instanceof checks run against
 * them). Asserts the fail-closed contract: an ambiguous job is FAILED
 * terminally and NEVER rescheduled (a reschedule could re-authorize a
 * duplicate send in designs without the reservation backstop, and wastes
 * attempts in this one).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AmbiguousDeliveryError } from '@/lib/instagram/errors';
import type { JobQueueRow } from '@/lib/types';

vi.mock('@/lib/automation/queue', () => ({
  claimDueJobs: vi.fn(),
  markJobDone: vi.fn(async () => {}),
  markJobFailed: vi.fn(async () => {}),
  markJobHeld: vi.fn(async () => {}),
  rescheduleJob: vi.fn(async () => {}),
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
import { processAutoDmJob } from '@/lib/automation/processJob';
import { claimDueJobs, markJobDone, markJobFailed, rescheduleJob } from '@/lib/automation/queue';

const mockClaim = vi.mocked(claimDueJobs);
const mockDone = vi.mocked(markJobDone);
const mockFailed = vi.mocked(markJobFailed);
const mockReschedule = vi.mocked(rescheduleJob);
const mockProcess = vi.mocked(processAutoDmJob);

function makeJob(): JobQueueRow {
  return {
    id: 'job-1',
    job_type: 'auto_dm',
    payload: {
      automationId: 'auto-1',
      instagramAccountId: 'acct-1',
      igAccountIgsid: 'IG-OWNER',
      triggerType: 'comment',
      triggerUserId: 'IG-FAN',
      triggerEventId: 'cmt-1',
      triggerTimestamp: Date.now(),
      postId: 'post-1',
      commentText: 'LINK',
      messageText: null,
    },
    dedupe_key: 'event_auto-1_cmt-1',
    status: 'processing',
    run_after: new Date().toISOString(),
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    locked_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  mockClaim.mockReset();
  mockDone.mockClear();
  mockFailed.mockClear();
  mockReschedule.mockClear();
  mockProcess.mockReset();
});

describe('engine: AmbiguousDeliveryError fails closed', () => {
  it('marks the job FAILED and never reschedules it', async () => {
    mockClaim.mockResolvedValue([makeJob()]);
    mockProcess.mockRejectedValue(new AmbiguousDeliveryError('Ambiguous send outcome for comment cmt-1: socket hangup'));

    const result = await processDueJobs(5);

    expect(result).toMatchObject({ claimed: 1, done: 0, failed: 1, rescheduled: 0, held: 0 });
    expect(mockFailed).toHaveBeenCalledTimes(1);
    expect(mockFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('Ambiguous send outcome'));
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockDone).not.toHaveBeenCalled();
  });
});
