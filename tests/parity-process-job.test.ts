/**
 * Phase 5 parity — job processing (src/lib/automation/processJob.ts) with
 * the REAL processor, REAL flow engine, REAL follow-up claim and the
 * FakeSupabase-backed service client. Only the Meta API surface (network),
 * env, and the debug logger are mocked; the account token is encrypted with
 * the REAL AES-256-GCM code under a test key. The 2–5s human jitter is
 * collapsed by stubbing setTimeout to fire immediately (timing only — the
 * send assertions are unaffected).
 *
 * Covers: (c) opted-out recipient gets no DM, (d) failed opt-out lookup
 * fails closed, (e) Traffic Guard pause at job level, (g) public-reply
 * gate, (h) scheduled follow-up exactly-once, (k) flow-graph execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { AutoDmJobPayload } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32); // 64 hex chars = 32-byte test key

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  getAppUrl: () => 'https://app.opendm.in',
}));
vi.mock('@/lib/instagram/api', () => ({
  sendInstagramDm: vi.fn(async () => 'msg-1'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'msg-2'),
  sendInstagramCardDm: vi.fn(async () => 'msg-3'),
  sendAskToFollowDm: vi.fn(async () => 'msg-4'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
}));

import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import { claimFollowUpForSending } from '@/lib/automation/followUps';
import { AccountOnTrafficGuardPause } from '@/lib/automation/trafficGuardError';
import { sendInstagramDm, replyToComment } from '@/lib/instagram/api';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockSendDm = vi.mocked(sendInstagramDm);
const mockReply = vi.mocked(replyToComment);
const db = fake as unknown as SupabaseClient;

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

function account(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'acct-1',
    user_id: 'user-1',
    instagram_user_id: 'IG-OWNER',
    username: 'creator',
    is_active: true,
    access_token_encrypted: encrypt('test-access-token', TOKEN_KEY),
    paused_until: null,
    pause_reason: null,
    traffic_guard_paused: false,
    ...overrides,
  };
}

function automation(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-1',
    user_id: 'user-1',
    instagram_account_id: 'acct-1',
    name: 'Synthetic automation',
    type: 'comment_dm',
    is_active: true,
    post_id: null,
    keywords: ['LINK'],
    comment_reply_options: [],
    public_reply_enabled: false,
    public_reply_options: [],
    trigger_config: null,
    flow_graph: null,
    dm_opening_message_enabled: true,
    dm_opening_message: 'Here is your guide',
    dm_opening_message_button_title: null,
    dm_opening_message_button_link: null,
    ask_to_follow_enabled: false,
    ask_to_follow_message: '',
    ask_to_follow_visit_profile_button: '',
    ask_to_follow_confirm_button: '',
    dm_responses: [],
    follow_up_enabled: false,
    follow_up_delay_minutes: 60,
    follow_up_message: '',
    is_traffic_guard_paused: false,
    total_dms_sent: 0,
    ...overrides,
  };
}

function payload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: 'auto-1',
    instagramAccountId: 'acct-1',
    igAccountIgsid: 'IG-OWNER',
    triggerType: 'comment',
    triggerUserId: 'IG-FAN',
    triggerUsername: 'fan',
    triggerEventId: 'cmt-1',
    triggerTimestamp: Date.now(),
    postId: 'post-1',
    commentText: 'LINK',
    messageText: null,
    ...overrides,
  };
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [account()]);
  fake.replaceRows('automations', [automation()]);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('dm_jobs', []);
  fake.replaceRows('dm_logs', []);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('automation_follow_ups', []);
  fake.replaceRows('recipient_opt_outs', []);
  // Phase 6: reservation state is per-test, like dm_sent_log.
  fake.replaceRows('comment_private_reply_reservations', []);
  fake.replaceRows('comment_public_reply_reservations', []);
  mockSendDm.mockClear();
  mockReply.mockClear();
  // Collapse the human-like jitter (2–5s) so the suite stays fast.
  timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
});

describe('(c)+(d) recipient opt-out suppression before any send', () => {
  it('(c) an opted-out recipient receives NO outbound DM', async () => {
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-1', recipient_id: 'IG-FAN' },
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
    const job = fake.rows('dm_jobs')[0];
    expect(job?.['status']).toBe('skipped');
    expect(String(job?.['error_message'])).toContain('opted out');
  });

  it('(d) a FAILED opt-out lookup (RPC + fallback both error) results in NO send — fail closed', async () => {
    fake.setRpcHandler('is_recipient_suppressed', async () => ({
      data: null,
      error: { message: 'rpc unavailable' },
    }));
    fake.failNextQuery('recipient_opt_outs', { message: 'connection reset' });
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });

  it('control: a verifiably non-suppressed recipient DOES receive the DM', async () => {
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });
});

describe('(g) public-reply gate', () => {
  it('public_reply_enabled=false NEVER publishes, even with reply options populated', async () => {
    fake.replaceRows('automations', [
      automation({
        public_reply_enabled: false,
        public_reply_options: ['Check your DMs!', 'Sent you a DM'],
        comment_reply_options: ['Legacy option'],
      }),
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockReply).not.toHaveBeenCalled();
    // The private DM itself is unaffected by the gate:
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('enabled + public_reply_options populated publishes from the public list', async () => {
    const options = ['Check your DMs!', 'Sent you a DM'];
    fake.replaceRows('automations', [
      automation({ public_reply_enabled: true, public_reply_options: options }),
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const [commentId, text] = mockReply.mock.calls[0]! as unknown as [string, string, string];
    expect(commentId).toBe('cmt-1');
    expect(options).toContain(text);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('enabled + empty public list falls back to comment_reply_options', async () => {
    fake.replaceRows('automations', [
      automation({
        public_reply_enabled: true,
        public_reply_options: [],
        comment_reply_options: ['Fallback reply text'],
      }),
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const [, text] = mockReply.mock.calls[0]! as unknown as [string, string, string];
    expect(text).toBe('Fallback reply text');
  });

  it('enabled but NO options anywhere publishes nothing (no invented fallback text)', async () => {
    fake.replaceRows('automations', [
      automation({ public_reply_enabled: true, public_reply_options: [], comment_reply_options: [] }),
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockReply).not.toHaveBeenCalled();
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });
});

describe('(e) Traffic Guard pause at job level', () => {
  it('automation-level pause throws AccountOnTrafficGuardPause and sends nothing', async () => {
    fake.replaceRows('automations', [automation({ is_traffic_guard_paused: true })]);
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(AccountOnTrafficGuardPause);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });

  it('account-level pause throws AccountOnTrafficGuardPause and sends nothing', async () => {
    fake.replaceRows('instagram_accounts', [account({ traffic_guard_paused: true })]);
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(AccountOnTrafficGuardPause);
    expect(mockSendDm).not.toHaveBeenCalled();
  });
});

describe('(k) flow-graph execution', () => {
  it('an automation with a flow_graph executes the graph instead of the linear pipeline', async () => {
    const graph = {
      version: 1 as const,
      nodes: [
        { id: 'n-trigger', type: 'trigger' as const, position: { x: 0, y: 0 }, data: {} },
        { id: 'n-send', type: 'send_dm' as const, position: { x: 0, y: 1 }, data: { messageText: 'Flow graph hello' } },
        { id: 'n-end', type: 'end' as const, position: { x: 0, y: 2 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'n-trigger', target: 'n-send' },
        { id: 'e2', source: 'n-send', target: 'n-end' },
      ],
    };
    fake.replaceRows('automations', [
      automation({ flow_graph: graph, dm_opening_message: 'Linear pipeline hello' }),
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    const sentText = (mockSendDm.mock.calls[0]! as unknown as unknown[])[2];
    expect(sentText).toBe('Flow graph hello');
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });
});

describe('(h) scheduled follow-ups execute exactly once', () => {
  const QUALIFIED_EVENT = 'evt-qual-1';

  function seedFollowUp(status = 'scheduled'): void {
    fake.replaceRows('automations', [
      automation({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
    ]);
    fake.seed('automation_follow_ups', [
      {
        id: 'fu-1',
        automation_id: 'auto-1',
        instagram_account_id: 'acct-1',
        session_id: null,
        recipient_id: 'IG-FAN',
        recipient_username: 'fan',
        qualified_event_id: QUALIFIED_EVENT,
        qualified_timestamp: new Date().toISOString(),
        scheduled_for: new Date().toISOString(),
        status,
        message_snapshot: 'Checking in!',
        error_reason: null,
        sent_at: null,
      },
    ]);
  }

  function scheduledPayload(): AutoDmJobPayload {
    return payload({
      triggerType: 'dm_reply_followup',
      triggerEventId: `scheduled_${QUALIFIED_EVENT}`,
      triggerTimestamp: Date.now(),
      isFollowUp: true,
      isScheduledFollowUp: true,
      sessionId: undefined,
      sessionStep: 99,
      followUpText: 'Checking in!',
      commentText: null,
      postId: null,
    });
  }

  it('processing the same scheduled follow-up twice sends exactly one DM (atomic claim)', async () => {
    seedFollowUp('scheduled');
    await processFollowUpDmJob(scheduledPayload());
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');

    // Duplicate delivery / second worker: the claim is gone, no resend.
    await processFollowUpDmJob(scheduledPayload());
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');
  });

  it('claimFollowUpForSending: first claim wins, second claim returns null', async () => {
    seedFollowUp('scheduled');
    const first = await claimFollowUpForSending(db, 'auto-1', 'IG-FAN', QUALIFIED_EVENT);
    expect(first?.message_snapshot).toBe('Checking in!');
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sending');
    const second = await claimFollowUpForSending(db, 'auto-1', 'IG-FAN', QUALIFIED_EVENT);
    expect(second).toBeNull();
  });

  it('a held follow-up can be claimed after the pause lifts (held is claimable, sent is not)', async () => {
    seedFollowUp('held');
    const claimed = await claimFollowUpForSending(db, 'auto-1', 'IG-FAN', QUALIFIED_EVENT);
    expect(claimed).not.toBeNull();

    fake.replaceRows('automation_follow_ups', [
      { ...fake.rows('automation_follow_ups')[0]!, status: 'sent' },
    ]);
    const afterSent = await claimFollowUpForSending(db, 'auto-1', 'IG-FAN', QUALIFIED_EVENT);
    expect(afterSent).toBeNull();
  });
});
