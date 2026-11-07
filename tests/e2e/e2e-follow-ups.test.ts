/**
 * Phase 10.3 E2E (Area 10) — scheduled follow-ups: exactly-once claim
 * and the 24-hour window, at scheduling time AND at send time.
 *
 * tests/parity-process-job.test.ts (h) proves sequential exactly-once
 * processing and the claim helper's first-wins behaviour. This file
 * EXTENDS it with: CONCURRENT claims (three racing workers, exactly
 * one winner) and concurrent processing; the scheduling-side window
 * (scheduleFollowUpMessage refuses a delay that lands past 24h and
 * records the row 'skipped' with the window reason, enqueueing
 * nothing); and the send-side window (a follow-up whose qualifying
 * event has aged past 24h expires without a send).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  accountRow,
  automationRow,
  followUpRow,
  scheduledFollowUpPayload,
  E2E,
} from './fixtures/payloads';
import { collapseJitter, createFetchGuard, stubFetchGuard } from './helpers/harness';

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

import { processFollowUpDmJob } from '@/lib/automation/processJob';
import { claimFollowUpForSending, scheduleFollowUpMessage } from '@/lib/automation/followUps';
import { sendInstagramDm } from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
const db = fake as unknown as SupabaseClient;
let restoreJitter: (() => void) | null = null;

const QUALIFIED_EVENT = 'evt-e2e-qual-1';

function seedScheduledFollowUp(): void {
  fake.replaceRows('automations', [
    automationRow({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
  ]);
  fake.seed('automation_follow_ups', [followUpRow()]);
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
  mockSendDm.mockClear();
  stubFetchGuard(createFetchGuard());
  restoreJitter = collapseJitter();
});

afterEach(() => {
  restoreJitter?.();
  restoreJitter = null;
  vi.unstubAllGlobals();
});

describe('the atomic claim under concurrency', () => {
  it('three racing claims: exactly one worker wins, the row ends in sending', async () => {
    seedScheduledFollowUp();
    const results = await Promise.all([
      claimFollowUpForSending(db, E2E.automationId, E2E.fanIgsid, QUALIFIED_EVENT),
      claimFollowUpForSending(db, E2E.automationId, E2E.fanIgsid, QUALIFIED_EVENT),
      claimFollowUpForSending(db, E2E.automationId, E2E.fanIgsid, QUALIFIED_EVENT),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sending');
  });

  it('two workers processing the same due follow-up concurrently send exactly one DM', async () => {
    seedScheduledFollowUp();
    await Promise.all([
      processFollowUpDmJob(scheduledFollowUpPayload()),
      processFollowUpDmJob(scheduledFollowUpPayload()),
    ]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');
  });
});

describe('the 24-hour window — enforced when scheduling', () => {
  it('a delay INSIDE the window schedules the row and enqueues its job', async () => {
    const ok = await scheduleFollowUpMessage(db, {
      automationId: E2E.automationId,
      instagramAccountId: E2E.accountId,
      igAccountIgsid: E2E.ownerIgsid,
      recipientId: E2E.fanIgsid,
      qualifiedEventId: 'evt-sched-ok',
      qualifiedTimestamp: Date.now(),
      delayMinutes: 60,
      message: 'Checking in!',
    });
    expect(ok).toBe(true);
    const row = fake.rows('automation_follow_ups').find((r) => r['qualified_event_id'] === 'evt-sched-ok')!;
    expect(row['status']).toBe('scheduled');
    expect(fake.rows('job_queue')).toHaveLength(1);
  });

  it('a delay landing PAST 24h is refused: row recorded skipped with the window reason, NO job enqueued', async () => {
    const ok = await scheduleFollowUpMessage(db, {
      automationId: E2E.automationId,
      instagramAccountId: E2E.accountId,
      igAccountIgsid: E2E.ownerIgsid,
      recipientId: E2E.fanIgsid,
      qualifiedEventId: 'evt-sched-late',
      qualifiedTimestamp: Date.now(),
      delayMinutes: 25 * 60, // 25h > 24h window
      message: 'Checking in!',
    });
    expect(ok).toBe(false);
    const row = fake.rows('automation_follow_ups').find((r) => r['qualified_event_id'] === 'evt-sched-late')!;
    expect(row['status']).toBe('skipped');
    expect(String(row['error_reason'])).toContain('24-hour');
    expect(fake.rows('job_queue')).toHaveLength(0);
  });
});

describe('the 24-hour window — enforced again at send time', () => {
  it('a follow-up whose qualifying event aged past 24h EXPIRES without a send', async () => {
    seedScheduledFollowUp();
    const stale = scheduledFollowUpPayload({
      triggerTimestamp: Date.now() - 25 * 60 * 60 * 1000,
    });
    await processFollowUpDmJob(stale);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('expired');
  });

  it('a follow-up inside the window sends once; a later reprocess sends nothing more', async () => {
    seedScheduledFollowUp();
    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');
    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });
});
