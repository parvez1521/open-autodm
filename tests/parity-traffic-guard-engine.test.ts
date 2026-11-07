/**
 * Phase 5 parity — Traffic Guard hold/resume through the REAL queue engine
 * (src/lib/automation/engine.ts) driving the REAL job processor
 * (processJob.ts). Only the queue's claim/mark functions (the Postgres
 * claim RPC layer), the Meta API surface, env and the debug logger are
 * mocked; the pause decision, the AccountOnTrafficGuardPause signal and
 * the engine's held handling are all production code.
 *
 * Covers (e)+(f): a paused account's job is HELD — not failed, not
 * dropped, no send — and after the pause lifts the same job completes
 * with exactly one send.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { JobQueueRow } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32);

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
vi.mock('@/lib/automation/queue', () => ({
  claimDueJobs: vi.fn(),
  markJobDone: vi.fn(async () => {}),
  markJobFailed: vi.fn(async () => {}),
  markJobHeld: vi.fn(async () => {}),
  rescheduleJob: vi.fn(async () => {}),
  retryBackoffMs: (attempts: number) => 5000 * Math.pow(5, Math.max(0, attempts - 1)),
}));

import { processDueJobs } from '@/lib/automation/engine';
import { claimDueJobs, markJobDone, markJobFailed, markJobHeld } from '@/lib/automation/queue';
import { sendInstagramDm } from '@/lib/instagram/api';

const mockClaim = vi.mocked(claimDueJobs);
const mockDone = vi.mocked(markJobDone);
const mockFailed = vi.mocked(markJobFailed);
const mockHeld = vi.mocked(markJobHeld);
const mockSendDm = vi.mocked(sendInstagramDm);

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

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
      triggerUsername: 'fan',
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

function seedAll(accountPaused: boolean): void {
  const accountRow: FakeRow = {
    id: 'acct-1',
    user_id: 'user-1',
    instagram_user_id: 'IG-OWNER',
    username: 'creator',
    is_active: true,
    access_token_encrypted: encrypt('test-access-token', TOKEN_KEY),
    paused_until: null,
    pause_reason: null,
    traffic_guard_paused: accountPaused,
  };
  const automationRow: FakeRow = {
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
  };
  fake.replaceRows('instagram_accounts', [accountRow]);
  fake.replaceRows('automations', [automationRow]);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('dm_jobs', []);
  // Phase 6: each seed is a fresh world, reservation state included.
  fake.replaceRows('comment_private_reply_reservations', []);
  fake.replaceRows('comment_public_reply_reservations', []);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('recipient_opt_outs', []);
  mockClaim.mockReset();
  mockDone.mockClear();
  mockFailed.mockClear();
  mockHeld.mockClear();
  mockSendDm.mockClear();
  timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
});

describe('(e)+(f) Traffic Guard: held under pause, completed after resume', () => {
  it('pause → job HELD (not failed/done, no send); pause lifted → same job completes with exactly one send', async () => {
    // ── Drain 1: account paused by Traffic Guard ──────────────────────
    seedAll(true);
    mockClaim.mockResolvedValue([makeJob()]);
    const held = await processDueJobs(5);
    expect(held).toMatchObject({ claimed: 1, held: 1, done: 0, failed: 0, rescheduled: 0 });
    expect(mockHeld).toHaveBeenCalledTimes(1);
    expect(mockHeld).toHaveBeenCalledWith('job-1', expect.stringContaining('Traffic Guard'));
    expect(mockFailed).not.toHaveBeenCalled();
    expect(mockDone).not.toHaveBeenCalled();
    expect(mockSendDm).not.toHaveBeenCalled();

    // ── Drain 2: guard lifts the pause; the held job returns to pending
    // (the resume RPC's job in production) and is claimed again ────────
    fake.replaceRows('instagram_accounts', [
      { ...fake.rows('instagram_accounts')[0]!, traffic_guard_paused: false },
    ]);
    mockClaim.mockResolvedValue([makeJob()]);
    const done = await processDueJobs(5);
    expect(done).toMatchObject({ claimed: 1, done: 1, held: 0, failed: 0 });
    expect(mockDone).toHaveBeenCalledWith('job-1');
    // Exactly one send across BOTH drains — the held attempt sent nothing.
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });
});
