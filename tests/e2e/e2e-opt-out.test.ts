/**
 * Phase 10.3 E2E (Area 8) — opt-out suppression as a stateful lifecycle.
 *
 * Pieces exist separately (ingestion suppression in parity-webhook,
 * send-path suppression + fail-closed in parity-process-job (c)/(d)).
 * This file EXTENDS them into the staging Area 8 journey in ONE world:
 * an opt-out expressed in a comment is RECORDED at ingestion, then that
 * same record suppresses (a) the fan's next trigger at ingestion and
 * (b) a direct send-path job, and (c) a scheduled follow-up. The
 * fail-closed branch is then exercised at BOTH layers with the lookup
 * forced to error, and a false-positive phrase ("can't stop watching")
 * proves the recorder does not over-fire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import {
  accountRow,
  automationRow,
  commentWebhookBody,
  dmWebhookBody,
  followUpRow,
  jobPayload,
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

import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import { sendInstagramDm, replyToComment } from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
const mockReply = vi.mocked(replyToComment);
let restoreJitter: (() => void) | null = null;

function forceSuppressionLookupFailure(): void {
  fake.setRpcHandler('is_recipient_suppressed', async () => ({
    data: null,
    error: { message: 'rpc unavailable (forced)' },
  }));
  fake.failNextQuery('recipient_opt_outs', { message: 'connection reset (forced)' });
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
  mockReply.mockClear();
  stubFetchGuard(createFetchGuard());
  restoreJitter = collapseJitter();
});

afterEach(() => {
  restoreJitter?.();
  restoreJitter = null;
  vi.unstubAllGlobals();
});

describe('one opt-out, suppressed everywhere afterwards', () => {
  it('comment "STOP" records the opt-out; the fan is then suppressed at ingestion, at send, and for follow-ups', async () => {
    // 1) Ingestion records the opt-out and enqueues nothing.
    expect(await processWebhookPayload(commentWebhookBody('STOP', 'cmt-stop-1'))).toBe(0);
    const optOuts = fake.rows('recipient_opt_outs');
    expect(optOuts).toHaveLength(1);
    expect(optOuts[0]!['recipient_id']).toBe(E2E.fanIgsid);
    expect(optOuts[0]!['reason']).toBe('comment_keyword');

    // 2) The fan's next genuine trigger is suppressed at ingestion.
    expect(await processWebhookPayload(commentWebhookBody('LINK', 'cmt-after-stop'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);

    // 3) A job that somehow exists is still blocked at the send path.
    await processAutoDmJob(jobPayload({ triggerEventId: 'cmt-after-stop' }), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();

    // 4) A scheduled follow-up for the fan is suppressed too.
    fake.replaceRows('automations', [
      automationRow({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
    ]);
    fake.seed('automation_follow_ups', [followUpRow()]);
    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('skipped');
  });

  it('DM "unsubscribe" records a dm_keyword opt-out that suppresses the next DM trigger', async () => {
    fake.replaceRows('automations', [automationRow({ type: 'dm_reply', keywords: ['LINK'] })]);
    expect(await processWebhookPayload(dmWebhookBody('unsubscribe', 'mid-stop-1'))).toBe(0);
    expect(fake.rows('recipient_opt_outs')).toHaveLength(1);
    expect(fake.rows('recipient_opt_outs')[0]!['reason']).toBe('dm_keyword');

    expect(await processWebhookPayload(dmWebhookBody('LINK', 'mid-after-stop'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('false positive guard: "can\'t stop watching" is NOT an opt-out — the keyword job still enqueues', async () => {
    fake.replaceRows('automations', [automationRow({ type: 'dm_reply', keywords: ['watching'] })]);
    expect(await processWebhookPayload(dmWebhookBody("can't stop watching this", 'mid-fp-1'))).toBe(1);
    expect(fake.rows('recipient_opt_outs')).toHaveLength(0);
    expect(fake.rows('job_queue')).toHaveLength(1);
  });
});

describe('fail-closed at BOTH layers when the suppression lookup itself errors', () => {
  it('ingestion: lookup error → nothing enqueued', async () => {
    forceSuppressionLookupFailure();
    expect(await processWebhookPayload(commentWebhookBody('LINK', 'cmt-fc-1'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('send path: lookup error → no DM, no public reply', async () => {
    forceSuppressionLookupFailure();
    await processAutoDmJob(jobPayload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
    const job = fake.rows('dm_jobs')[0];
    expect(job?.['status']).toBe('skipped');
  });

  it('empty recipient/account ids fail closed at the module boundary', async () => {
    const { isRecipientSuppressed } = await import('@/lib/automation/optOut');
    const db = fake as unknown as Parameters<typeof isRecipientSuppressed>[0];
    expect(await isRecipientSuppressed(db, '', E2E.fanIgsid)).toBe(true);
    expect(await isRecipientSuppressed(db, E2E.accountId, '')).toBe(true);
  });
});
