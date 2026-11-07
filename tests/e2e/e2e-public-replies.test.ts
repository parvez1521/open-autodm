/**
 * Phase 10.3 E2E (Area 6) — manual public replies: the
 * `public_reply_enabled === true` gate, exercised as a retry-aware
 * journey through the REAL job processor.
 *
 * tests/parity-process-job.test.ts (g) proves the gate per single run
 * and parity-reservations proves the public reservation machine. This
 * file EXTENDS both with the journey staging Area 5 cares about: the
 * gate decision must hold across RETRIES (a retried job must not post a
 * second visible reply), and a pre-existing public reservation must
 * suppress the reply while the private DM still flows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import { accountRow, automationRow, jobPayload, E2E } from './fixtures/payloads';
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

import { processAutoDmJob, selectPublicReplyOption } from '@/lib/automation/processJob';
import { sendInstagramDm, replyToComment } from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
const mockReply = vi.mocked(replyToComment);
let restoreJitter: (() => void) | null = null;

const OPTIONS = ['Check your DMs!', 'Sent you a DM'];

function seedWorld(publicEnabled: boolean, options: string[] = OPTIONS): void {
  fake.replaceRows('automations', [
    automationRow({ public_reply_enabled: publicEnabled, public_reply_options: options }),
  ]);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [accountRow()]);
  fake.replaceRows('automations', [automationRow()]);
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

describe('public-reply gate across the full job journey (including retries)', () => {
  it('ENABLED: exactly one public reply + one DM; a RETRY posts neither a second reply nor a second DM', async () => {
    seedWorld(true);
    await processAutoDmJob(jobPayload(), 1);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const [commentId, text] = mockReply.mock.calls[0]! as unknown as [string, string, string];
    expect(commentId).toBe(E2E.commentId);
    expect(OPTIONS).toContain(text);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('comment_public_reply_reservations')[0]!['status']).toBe('sent');

    // Job retry / redelivery: public_reply_sent_at + both reservations
    // and the sent log all refuse a duplicate.
    await processAutoDmJob(jobPayload(), 2);
    expect(mockReply).toHaveBeenCalledTimes(1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('DISABLED with options populated: total silence on the comment across attempts — DM still flows exactly once', async () => {
    seedWorld(false);
    await processAutoDmJob(jobPayload(), 1);
    await processAutoDmJob(jobPayload(), 2);
    expect(mockReply).not.toHaveBeenCalled();
    expect(fake.rows('comment_public_reply_reservations')).toHaveLength(0);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('ENABLED but no reply text configured anywhere: nothing is invented, DM still flows', async () => {
    seedWorld(true, []);
    await processAutoDmJob(jobPayload(), 1);
    expect(mockReply).not.toHaveBeenCalled();
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('a public reservation already SENT (earlier worker) suppresses the reply but NOT the private DM', async () => {
    seedWorld(true);
    fake.seed('comment_public_reply_reservations', [
      {
        id: 'pub-res-1',
        instagram_account_id: E2E.accountId,
        comment_id: E2E.commentId,
        automation_id: E2E.automationId,
        status: 'sent',
        reserved_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        failed_at: null,
        failure_reason: null,
      },
    ]);
    await processAutoDmJob(jobPayload(), 1);
    expect(mockReply).not.toHaveBeenCalled();
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('reply selection is deterministic per comment (a retry would pick the same line)', () => {
    const first = selectPublicReplyOption(OPTIONS, E2E.commentId);
    const second = selectPublicReplyOption(OPTIONS, E2E.commentId);
    expect(first).toBe(second);
    expect(OPTIONS).toContain(first);
    expect(selectPublicReplyOption([], E2E.commentId)).toBe('');
    expect(selectPublicReplyOption(undefined, E2E.commentId)).toBe('');
  });
});
