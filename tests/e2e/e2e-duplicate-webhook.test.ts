/**
 * Phase 10.3 E2E (Area 4) — duplicate webhook delivery is idempotent
 * END TO END: webhook → queue → job processing → Meta send.
 *
 * The layers are proven separately elsewhere (queue dedupe in
 * tests/queue-idempotency.test.ts + parity-webhook (i); send dedupe in
 * parity-reservations (2)). This file chains them in ONE world with the
 * Meta send counter as the final oracle: Meta redelivers the identical
 * comment event, the queue absorbs the retry, and even if the job is
 * processed twice the audience member receives exactly ONE DM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import {
  accountRow,
  automationRow,
  commentWebhookBody,
  dmWebhookBody,
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
import { sendInstagramDm } from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
let restoreJitter: (() => void) | null = null;

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
  // Belt-and-braces: the Meta layer is module-mocked above; any OTHER
  // real fetch to a Meta host would throw via the guard.
  stubFetchGuard(createFetchGuard());
  restoreJitter = collapseJitter();
});

afterEach(() => {
  restoreJitter?.();
  restoreJitter = null;
  vi.unstubAllGlobals();
});

describe('the same comment delivered twice, processed twice → exactly one DM', () => {
  it('webhook redelivery is absorbed by the queue; double processing still sends once', async () => {
    // First delivery → one job.
    expect(await processWebhookPayload(commentWebhookBody('LINK'))).toBe(1);
    expect(fake.rows('job_queue')).toHaveLength(1);

    // Meta retries the identical delivery. Postgres would reject the
    // second insert on dedupe_key (23505) — injected, as in the parity
    // suite, because the fake has no unique index.
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    expect(await processWebhookPayload(commentWebhookBody('LINK'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(1);

    // The single job is then processed — and, simulating a reclaim /
    // duplicate drain, processed a SECOND time.
    await processAutoDmJob(jobPayload(), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    await processAutoDmJob(jobPayload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);

    // Final state: one send recorded, one confirmed reservation.
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
    const reservations = fake.rows('comment_private_reply_reservations');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!['status']).toBe('sent');
    expect(reservations[0]!['comment_id']).toBe(E2E.commentId);
  });

  it('a duplicated DM webhook likewise yields one job (dedupe on the message id)', async () => {
    expect(await processWebhookPayload(dmWebhookBody('hello', 'mid-dup-1'))).toBe(0); // no dm_reply automation yet
    fake.replaceRows('automations', [automationRow({ type: 'dm_reply', keywords: ['hello'] })]);
    expect(await processWebhookPayload(dmWebhookBody('hello', 'mid-dup-1'))).toBe(1);
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    expect(await processWebhookPayload(dmWebhookBody('hello', 'mid-dup-1'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(1);
    expect(fake.rows('job_queue')[0]!['dedupe_key']).toBe(`event_${E2E.automationId}_mid-dup-1`);
  });
});
