/**
 * Phase 10.4 §3 — S-04: DM rate limiter must FAIL CLOSED.
 *
 * The REAL processor (processJob.ts) against the FakeSupabase-backed
 * service client, following tests/parity-process-job.test.ts. Only the
 * Meta API surface, env and the debug logger are mocked; the account
 * token is encrypted with the REAL AES-256-GCM code under a test key.
 * The 2–5s human jitter is collapsed by stubbing setTimeout.
 *
 * Contract under test (check_and_record_dm_rate_limit RPC):
 *  - success row allowed=true  → the send proceeds (one slot recorded
 *    by the RPC itself before returning).
 *  - success row allowed=false → RateLimitDelay; the RPC recorded NO
 *    slot; the engine reschedules without counting an attempt.
 *  - RPC error / thrown transport error (incl. timeout abort) / empty
 *    or malformed result → the decision is UNKNOWN. Zero rows can never
 *    come from the real function (it RETURNs exactly one row), so an
 *    empty result is a malfunction, not "count = 0". UNKNOWN must mean
 *    NO send: RateLimitUnavailable (a RateLimitDelay subclass, so the
 *    engine's existing reschedule-without-attempt path applies) and
 *    zero deliveries.
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

import {
  processAutoDmJob,
  processFollowUpDmJob,
  RateLimitDelay,
  RateLimitUnavailable,
  RATE_LIMIT_UNAVAILABLE_RETRY_MS,
} from '@/lib/automation/processJob';
import { AccountOnTrafficGuardPause } from '@/lib/automation/trafficGuardError';
import { sendInstagramDm, replyToComment } from '@/lib/instagram/api';
import { debugLog } from '@/lib/debugLog';

const mockSendDm = vi.mocked(sendInstagramDm);
const mockReply = vi.mocked(replyToComment);
const mockDebugLog = vi.mocked(debugLog);

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

const RPC_ERROR = { message: 'connection to database lost SENTINEL-DETAIL-12345' };

function rpcError(): void {
  fake.setRpcHandler('check_and_record_dm_rate_limit', async () => ({
    data: null,
    error: { ...RPC_ERROR },
  }));
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
  fake.replaceRows('comment_private_reply_reservations', []);
  fake.replaceRows('comment_public_reply_reservations', []);
  mockSendDm.mockClear();
  mockReply.mockClear();
  mockDebugLog.mockClear();
  timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
});

describe('RateLimitUnavailable — typed delay signal for the engine', () => {
  it('is a RateLimitDelay subclass (engine reschedules it without counting an attempt)', () => {
    const err = new RateLimitUnavailable();
    expect(err).toBeInstanceOf(RateLimitDelay);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimitUnavailable');
    expect(err.retryAfterMs).toBe(RATE_LIMIT_UNAVAILABLE_RETRY_MS);
    expect(RATE_LIMIT_UNAVAILABLE_RETRY_MS).toBe(60_000);
    // currentCount -1 marks "unknown" — distinct from a real count of 0.
    expect(err.currentCount).toBe(-1);
    expect(err.message).not.toContain('Rate limit reached');
  });
});

describe('S-04 fail-closed rate limiting (processAutoDmJob)', () => {
  it('control: RPC valid + allowed → the send proceeds exactly once', async () => {
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });

  it('RPC limit-exceeded → RateLimitDelay with the RPC retry-after, zero deliveries', async () => {
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => ({
      data: [{ allowed: false, current_count: 180, retry_after_seconds: 600 }],
      error: null,
    }));
    const err = await processAutoDmJob(payload(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitDelay);
    expect(err).not.toBeInstanceOf(RateLimitUnavailable);
    expect((err as RateLimitDelay).retryAfterMs).toBe(600_000);
    expect((err as RateLimitDelay).currentCount).toBe(180);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
  });

  it('KEY PROOF — RPC error → RateLimitUnavailable and ZERO deliveries', async () => {
    rpcError();
    const err = await processAutoDmJob(payload(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitUnavailable);
    expect(err).toBeInstanceOf(RateLimitDelay); // engine reschedule path
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    // The limiter runs BEFORE the private-reply reservation: a limiter
    // outage must not leak/consume a reservation.
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0);
  });

  it('RPC error → thrown error and logs carry no message content and no raw upstream detail', async () => {
    rpcError();
    const err = await processAutoDmJob(payload(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('SENTINEL-DETAIL-12345');
    expect((err as Error).message).not.toContain('Here is your guide');
    for (const call of mockDebugLog.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('Here is your guide');
    }
  });

  it('RPC transport throw / timeout abort → RateLimitUnavailable, zero deliveries', async () => {
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => {
      const abort = new Error('The operation was aborted due to timeout');
      abort.name = 'AbortError';
      throw abort;
    });
    const err = await processAutoDmJob(payload(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
  });

  it('RPC empty result (zero rows) is UNKNOWN, not count=0 → blocked, zero deliveries', async () => {
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => ({ data: [], error: null }));
    const err = await processAutoDmJob(payload(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('RPC null data with no error is UNKNOWN → blocked, zero deliveries', async () => {
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => ({ data: null, error: null }));
    const err = await processAutoDmJob(payload(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('retry after a transient RPC failure succeeds and sends exactly once', async () => {
    rpcError();
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();

    fake.clearRpcHandlers(); // limiter healthy again (fake default: allowed)
    await processAutoDmJob(payload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
    expect(fake.rows('comment_private_reply_reservations')[0]!['status']).toBe('sent');
  });

  it('duplicate webhook delivery does not double-send (healthy limiter)', async () => {
    await processAutoDmJob(payload(), 1);
    await processAutoDmJob(payload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });

  it('concurrent events respect the limit: first admitted, second delayed, exactly one send', async () => {
    let calls = 0;
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => {
      calls += 1;
      return calls === 1
        ? { data: [{ allowed: true, current_count: 1, retry_after_seconds: 0 }], error: null }
        : { data: [{ allowed: false, current_count: 180, retry_after_seconds: 900 }], error: null };
    });
    const results = await Promise.allSettled([
      processAutoDmJob(payload({ triggerEventId: 'cmt-A', triggerUserId: 'IG-FAN-A' }), 1),
      processAutoDmJob(payload({ triggerEventId: 'cmt-B', triggerUserId: 'IG-FAN-B' }), 1),
    ]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RateLimitDelay);
  });

  it('Traffic Guard paused → blocked before the limiter, zero deliveries', async () => {
    fake.replaceRows('automations', [automation({ is_traffic_guard_paused: true })]);
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(AccountOnTrafficGuardPause);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });

  it('opt-out registered → blocked, zero deliveries (ordering intact)', async () => {
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-1', recipient_id: 'IG-FAN' },
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('dm_jobs')[0]?.['status']).toBe('skipped');
  });

  it('circuit breaker paused account → AccountOnPause, zero deliveries', async () => {
    fake.replaceRows('instagram_accounts', [
      account({ paused_until: new Date(Date.now() + 3600_000).toISOString(), pause_reason: 'policy block' }),
    ]);
    await expect(processAutoDmJob(payload(), 1)).rejects.toThrow('paused by the safety circuit breaker');
    expect(mockSendDm).not.toHaveBeenCalled();
  });
});

describe('S-04 fail-closed on the other two limiter call sites', () => {
  it('follow-up (button tap) path: RPC error → RateLimitUnavailable, zero deliveries', async () => {
    fake.replaceRows('automations', [
      automation({ dm_responses: [{ type: 'text', content: 'Here is the link' }] }),
    ]);
    fake.replaceRows('automation_sessions', [
      {
        id: 'sess-1',
        automation_id: 'auto-1',
        instagram_account_id: 'acct-1',
        audience_ig_user_id: 'IG-FAN',
        current_step: 1,
        completed: false,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    ]);
    rpcError();
    const followUpPayload = payload({
      triggerType: 'dm',
      triggerEventId: 'evt-tap-1',
      sessionId: 'sess-1',
      sessionStep: 1,
    });
    await expect(processFollowUpDmJob(followUpPayload)).rejects.toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('scheduled follow-up path: RPC error → blocked BEFORE the atomic claim; retry after recovery sends exactly once', async () => {
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
        qualified_event_id: 'evt-qual-1',
        qualified_timestamp: new Date().toISOString(),
        scheduled_for: new Date().toISOString(),
        status: 'scheduled',
        message_snapshot: 'Checking in!',
        error_reason: null,
        sent_at: null,
      },
    ]);
    const scheduledPayload = payload({
      triggerType: 'dm_reply_followup',
      triggerEventId: 'scheduled_evt-qual-1',
      isFollowUp: true,
      isScheduledFollowUp: true,
      sessionStep: 99,
      followUpText: 'Checking in!',
      commentText: null,
      postId: null,
    });

    rpcError();
    await expect(processFollowUpDmJob(scheduledPayload)).rejects.toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
    // The claim runs AFTER the limiter, so the row is still claimable.
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');

    fake.clearRpcHandlers();
    await processFollowUpDmJob(scheduledPayload);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');

    // Exactly-once: a duplicate processing cannot resend.
    await processFollowUpDmJob(scheduledPayload);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });
});
