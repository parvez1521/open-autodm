/**
 * Phase 10.3 E2E (Area 7) — reservation: a duplicated comment can
 * authorise AT MOST ONE Meta send, measured by the send counter.
 *
 * tests/parity-reservations.test.ts proves the reservation machine
 * layer by layer. This file EXTENDS it with the staging Area 11
 * journey in one world: the SAME comment is delivered by webhook
 * TWICE, matches TWO automations on the account, every resulting job
 * is processed (concurrently where the race is the point), and the
 * oracle is the mocked Meta send counter — it must read exactly 1.
 * Failure paths then check the disposition contract: a definitive
 * pre-delivery rejection (Meta 613) releases the reservation so the
 * retry sends exactly once; an ambiguous network failure fails it
 * closed so no replay is ever authorised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import {
  accountRow,
  automationRow,
  commentWebhookBody,
  jobPayload,
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

import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { processAutoDmJob } from '@/lib/automation/processJob';
import { MetaApiError, AmbiguousDeliveryError } from '@/lib/instagram/errors';
import { sendInstagramDm } from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
let restoreJitter: (() => void) | null = null;

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [accountRow()]);
  fake.replaceRows('automations', [
    automationRow(),
    automationRow({ id: E2E.automation2Id, name: 'E2E second automation' }),
  ]);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('dm_jobs', []);
  fake.replaceRows('dm_logs', []);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('automation_follow_ups', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('comment_private_reply_reservations', []);
  fake.replaceRows('comment_public_reply_reservations', []);
  mockSendDm.mockReset();
  mockSendDm.mockResolvedValue('msg-e2e-1');
  stubFetchGuard(createFetchGuard());
  restoreJitter = collapseJitter();
});

afterEach(() => {
  restoreJitter?.();
  restoreJitter = null;
  vi.unstubAllGlobals();
});

describe('duplicated comment, two automations, every job processed → send counter stays 1', () => {
  it('webhook ×2 → jobs for both automations → concurrent processing sends exactly once', async () => {
    // First delivery matches BOTH automations → two jobs (one per automation).
    expect(await processWebhookPayload(commentWebhookBody('LINK'))).toBe(2);
    expect(fake.rows('job_queue')).toHaveLength(2);

    // Redelivery: both inserts hit the dedupe constraint — no new jobs.
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    expect(await processWebhookPayload(commentWebhookBody('LINK'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(2);

    // Both jobs race. The account-wide reservation admits exactly one.
    await Promise.all([
      processAutoDmJob(jobPayload(), 1),
      processAutoDmJob(jobPayload({ automationId: E2E.automation2Id }), 1),
    ]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);

    const reservations = fake.rows('comment_private_reply_reservations');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!['status']).toBe('sent');
    // The losing job was skipped with the reservation reason, not failed.
    const statuses = fake.rows('dm_jobs').map((r) => r['status']);
    expect(statuses).toContain('sent');
    expect(statuses).toContain('skipped');
  });

  it('the same job processed by two workers at once still sends exactly once', async () => {
    await Promise.all([processAutoDmJob(jobPayload(), 1), processAutoDmJob(jobPayload(), 1)]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('comment_private_reply_reservations')[0]!['status']).toBe('sent');
  });
});

describe('reservation disposition on failure (send counter is the oracle)', () => {
  it('Meta 613 (definitive pre-delivery rejection) RELEASES the reservation; the retry delivers exactly once', async () => {
    mockSendDm.mockRejectedValueOnce(
      new MetaApiError('Calls to this api have exceeded the rate limit', 613, undefined)
    );
    await expect(processAutoDmJob(jobPayload(), 1)).rejects.toBeInstanceOf(MetaApiError);
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0); // released

    await processAutoDmJob(jobPayload(), 2);
    // Two ATTEMPTS reached the mock; exactly one DELIVERY is recorded.
    expect(mockSendDm).toHaveBeenCalledTimes(2);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
    expect(fake.rows('comment_private_reply_reservations')[0]!['status']).toBe('sent');
  });

  it('ambiguous network failure FAILS the reservation closed; a replay is never authorised', async () => {
    mockSendDm.mockRejectedValueOnce(new Error('socket hangup'));
    await expect(processAutoDmJob(jobPayload(), 1)).rejects.toBeInstanceOf(AmbiguousDeliveryError);
    const reservation = fake.rows('comment_private_reply_reservations')[0]!;
    expect(reservation['status']).toBe('failed');
    expect(String(reservation['failure_reason'])).toContain('Ambiguous');

    // Replay attempt: no second send is ever authorised for this comment.
    await processAutoDmJob(jobPayload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });
});
