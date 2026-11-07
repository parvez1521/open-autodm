/**
 * Area 9 — Job-queue idempotency + retry backoff (src/lib/automation/queue.ts).
 * The service client is mocked with the fake; enqueueJob's duplicate
 * handling (Postgres 23505 on the dedupe_key UNIQUE constraint → treated as
 * "already queued", returns null) is exercised exactly as implemented.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';
import type { AutoDmJobPayload, JobQueueRow } from '@/lib/types';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import { enqueueJob, rescheduleJob, retryBackoffMs } from '@/lib/automation/queue';

const PAYLOAD: AutoDmJobPayload = {
  automationId: 'auto-1',
  instagramAccountId: 'acct-1',
  igAccountIgsid: 'IG-OWNER',
  triggerType: 'comment',
  triggerUserId: 'IG-FAN',
  triggerUsername: 'fan',
  triggerEventId: 'comment-1',
  triggerTimestamp: 1762000000000,
  postId: 'post-1',
  commentText: 'LINK please',
  messageText: null,
};

function jobRow(overrides: Partial<JobQueueRow> = {}): JobQueueRow {
  return {
    id: 'job-1',
    job_type: 'auto_dm',
    payload: PAYLOAD,
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
  fake.calls.length = 0;
  fake.replaceRows('job_queue', []);
});

describe('enqueueJob dedupe', () => {
  it('inserts a new job and returns its id', async () => {
    const id = await enqueueJob('auto_dm', PAYLOAD, 'dedupe-1');
    expect(id).toBeTruthy();
    expect(fake.rows('job_queue')).toHaveLength(1);
    expect(fake.rows('job_queue')[0]!['dedupe_key']).toBe('dedupe-1');
  });

  it('treats a 23505 unique violation (Meta webhook retry) as a duplicate: returns null, no second row', async () => {
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    const id = await enqueueJob('auto_dm', PAYLOAD, 'dedupe-1');
    expect(id).toBeNull();
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('returns null (and does not throw) on a non-duplicate insert error', async () => {
    fake.failNextInsert('job_queue', { message: 'connection reset', code: '08006' });
    await expect(enqueueJob('auto_dm', PAYLOAD, 'dedupe-1')).resolves.toBeNull();
  });
});

describe('retryBackoffMs', () => {
  it('follows the 5s → 25s → 125s → 625s progression', () => {
    expect(retryBackoffMs(1)).toBe(5_000);
    expect(retryBackoffMs(2)).toBe(25_000);
    expect(retryBackoffMs(3)).toBe(125_000);
    expect(retryBackoffMs(4)).toBe(625_000);
  });
});

describe('rescheduleJob', () => {
  it('counts the attempt and re-queues as pending below max_attempts', async () => {
    const job = jobRow({ attempts: 0, max_attempts: 3 });
    fake.seed('job_queue', [{ ...job }]);
    await rescheduleJob(job, 25_000, 'transient', true);
    const row = fake.rows('job_queue')[0]!;
    expect(row['status']).toBe('pending');
    expect(row['attempts']).toBe(1);
    expect(new Date(row['run_after'] as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('marks the job FAILED when the counted attempt reaches max_attempts (3)', async () => {
    const job = jobRow({ attempts: 2, max_attempts: 3 });
    fake.seed('job_queue', [{ ...job }]);
    await rescheduleJob(job, 125_000, 'transient', true);
    const row = fake.rows('job_queue')[0]!;
    expect(row['status']).toBe('failed');
    expect(row['last_error']).toBe('transient');
  });

  it('does NOT count an attempt for rate-limit style reschedules', async () => {
    const job = jobRow({ attempts: 1, max_attempts: 3 });
    fake.seed('job_queue', [{ ...job }]);
    await rescheduleJob(job, 900_000, null, false);
    const row = fake.rows('job_queue')[0]!;
    expect(row['status']).toBe('pending');
    expect(row['attempts']).toBe(1);
  });
});
