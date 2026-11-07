/**
 * Phase 10.3 E2E (Area 9) — Traffic Guard: pause holds, resume releases.
 *
 * tests/parity-traffic-guard-engine.test.ts proves the engine's held
 * handling for one account-level pause; parity-webhook proves ingestion
 * stops while the ACCOUNT is paused. This file EXTENDS both into the
 * staging Area 9 journey in one world — ingestion pause (account AND
 * automation level) → engine drain holds the job (not failed, not
 * dropped, no send) → resume → the SAME job completes with exactly one
 * send — plus the follow-up variant: a scheduled follow-up is parked
 * as 'held' and becomes claimable again after the resume.
 *
 * The queue claim/mark layer is mocked (the Postgres claim RPC lives
 * outside this layer — same boundary as the parity engine suite); the
 * pause decision, the hold signal, and the engine are REAL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from '../helpers/fakeSupabase';
import {
  accountRow,
  automationRow,
  commentWebhookBody,
  followUpRow,
  jobPayload,
  scheduledFollowUpPayload,
  E2E,
} from './fixtures/payloads';
import { collapseJitter, createFetchGuard, stubFetchGuard } from './helpers/harness';
import type { JobQueueRow } from '@/lib/types';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'e2'.repeat(32) }),
  getAppUrl: () => 'https://app.opendm.in',
}));
vi.mock('@/lib/instagram/api', () => ({
  sendInstagramDm: vi.fn(async () => 'msg-e2e-1'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'msg-e2e-2'),
  sendInstagramCardDm: vi.fn(async () => 'msg-e2e-3'),
  sendAskToFollowDm: vi.fn(async () => 'msg-e2e-4'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
}));
vi.mock('@/lib/automation/queue', () => ({
  // Real enqueue semantics against the fake (dedupe_key unique → null),
  // mocked claim/mark RPC layer (same boundary as parity engine suite).
  enqueueJob: vi.fn(
    async (
      _jobType: string,
      payload: Record<string, unknown>,
      dedupeKey: string
    ): Promise<string | null> => {
      if (fake.rows('job_queue').some((r) => r['dedupe_key'] === dedupeKey)) return null;
      const res = (await fake
        .from('job_queue')
        .insert({ job_type: _jobType, payload, dedupe_key: dedupeKey })
        .select('id')
        .maybeSingle()) as { data: { id: string } | null };
      return res.data?.id ?? null;
    }
  ),
  claimDueJobs: vi.fn(),
  markJobDone: vi.fn(async () => {}),
  markJobFailed: vi.fn(async () => {}),
  markJobHeld: vi.fn(async () => {}),
  rescheduleJob: vi.fn(async () => {}),
  retryBackoffMs: (attempts: number) => 5000 * Math.pow(5, Math.max(0, attempts - 1)),
}));

import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { processDueJobs } from '@/lib/automation/engine';
import { processFollowUpDmJob } from '@/lib/automation/processJob';
import { AccountOnTrafficGuardPause } from '@/lib/automation/trafficGuardError';
import { claimDueJobs, markJobDone, markJobFailed, markJobHeld } from '@/lib/automation/queue';
import { sendInstagramDm } from '@/lib/instagram/api';

const mockClaim = vi.mocked(claimDueJobs);
const mockDone = vi.mocked(markJobDone);
const mockFailed = vi.mocked(markJobFailed);
const mockHeld = vi.mocked(markJobHeld);
const mockSendDm = vi.mocked(sendInstagramDm);
let restoreJitter: (() => void) | null = null;

function makeJob(): JobQueueRow {
  return {
    id: 'job-e2e-1',
    job_type: 'auto_dm',
    payload: jobPayload(),
    dedupe_key: `event_${E2E.automationId}_${E2E.commentId}`,
    status: 'processing',
    run_after: new Date().toISOString(),
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    locked_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as JobQueueRow;
}

function setAccountPaused(paused: boolean): void {
  const row = fake.rows('instagram_accounts')[0]!;
  fake.replaceRows('instagram_accounts', [{ ...row, traffic_guard_paused: paused }]);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [accountRow()]);
  fake.replaceRows('automations', [automationRow()]);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('dm_jobs', []);
  fake.replaceRows('dm_logs', []);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('automation_follow_ups', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('comment_private_reply_reservations', []);
  fake.replaceRows('comment_public_reply_reservations', []);
  mockClaim.mockReset();
  mockDone.mockClear();
  mockFailed.mockClear();
  mockHeld.mockClear();
  mockSendDm.mockClear();
  stubFetchGuard(createFetchGuard());
  restoreJitter = collapseJitter();
});

afterEach(() => {
  restoreJitter?.();
  restoreJitter = null;
  vi.unstubAllGlobals();
});

describe('the full pause → hold → resume journey', () => {
  it('ingestion stops under account pause; the queued job is HELD by the drain; after resume it completes with exactly one send', async () => {
    // ── Ingestion while paused: nothing is dispatched at all.
    setAccountPaused(true);
    expect(await processWebhookPayload(commentWebhookBody('LINK'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);

    // ── Guard lifts for ingestion: the trigger now queues a job.
    setAccountPaused(false);
    expect(await processWebhookPayload(commentWebhookBody('LINK'))).toBe(1);
    expect(fake.rows('job_queue')).toHaveLength(1);

    // ── Guard re-engages before the drain: the job is HELD —
    //    not done, not failed, not rescheduled, and nothing is sent.
    setAccountPaused(true);
    mockClaim.mockResolvedValue([makeJob()]);
    const held = await processDueJobs(5);
    expect(held).toMatchObject({ claimed: 1, held: 1, done: 0, failed: 0, rescheduled: 0 });
    expect(mockHeld).toHaveBeenCalledTimes(1);
    expect(mockDone).not.toHaveBeenCalled();
    expect(mockFailed).not.toHaveBeenCalled();
    expect(mockSendDm).not.toHaveBeenCalled();

    // ── Resume: the held job returns (resume RPC's job in production)
    //    and the next drain completes it — exactly one send in total.
    setAccountPaused(false);
    mockClaim.mockResolvedValue([makeJob()]);
    const done = await processDueJobs(5);
    expect(done).toMatchObject({ claimed: 1, done: 1, held: 0, failed: 0 });
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });

  it('automation-level pause also stops ingestion for that automation only', async () => {
    fake.replaceRows('automations', [
      automationRow({ is_traffic_guard_paused: true }),
      automationRow({ id: E2E.automation2Id, name: 'Unpaused automation' }),
    ]);
    const enqueued = await processWebhookPayload(commentWebhookBody('LINK'));
    expect(enqueued).toBe(1); // only the unpaused automation queued
    const jobs = fake.rows('job_queue') as FakeRow[];
    expect((jobs[0]!['payload'] as FakeRow)['automationId']).toBe(E2E.automation2Id);
  });
});

describe('scheduled follow-ups under Traffic Guard', () => {
  it('a follow-up due during a pause is parked HELD (no send); after resume the held row is claimable and sends exactly once', async () => {
    fake.replaceRows('automations', [
      automationRow({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
    ]);
    fake.seed('automation_follow_ups', [followUpRow()]);
    setAccountPaused(true);

    await expect(processFollowUpDmJob(scheduledFollowUpPayload())).rejects.toBeInstanceOf(
      AccountOnTrafficGuardPause
    );
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('held');

    setAccountPaused(false);
    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');

    // Reprocessing after the send cannot claim the row again.
    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });
});
