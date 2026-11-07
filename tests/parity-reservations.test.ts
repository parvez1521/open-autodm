/**
 * Phase 6 parity — pre-send comment reply reservations
 * (src/lib/automation/reservations.ts + processJob.ts integration), with
 * the REAL processor and the FakeSupabase-backed service client. The fake's
 * reservation RPC defaults implement the real SQL semantics (migration
 * 20260730000020): UNIQUE (instagram_account_id, comment_id) conflict,
 * automation/account pair validation, 10-minute fail-closed stale rule.
 * Only the Meta API surface, env and the debug logger are mocked; the
 * account token is encrypted with the REAL AES-256-GCM code under a
 * synthetic test key. Jitter is collapsed via a setTimeout stub.
 *
 * Required coverage:
 *  (1) concurrency — two workers / two automations, one comment, one send
 *  (2) duplicate webhook delivery — no duplicate send
 *  (3) worker crash between reservation and send — stale recovery is
 *      TERMINAL (fail-closed), never a re-authorization
 *  (4) send-success / confirm-failure — at-most-once authorization
 *      survives; the reservation degrades reserved → stale → failed
 *  (5) retry after failure — definitive pre-delivery rejection (Meta 613)
 *      RELEASES the reservation; the retry sends exactly once
 *  (6) stale reservation recovery — an already-sent reply is never resent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { AutoDmJobPayload } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32); // 64 hex chars = 32-byte synthetic test key

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
import {
  reserveCommentPrivateReply,
  confirmCommentPrivateReply,
  reservationDispositionForError,
} from '@/lib/automation/reservations';
import { enqueueJob } from '@/lib/automation/queue';
import {
  MetaApiError,
  NonRetryableMetaError,
  AccountPausedMetaError,
  AmbiguousDeliveryError,
} from '@/lib/instagram/errors';
import { sendInstagramDm, replyToComment } from '@/lib/instagram/api';

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

function privateRows(): FakeRow[] {
  return fake.rows('comment_private_reply_reservations');
}

function agePrivateReservation(minutes: number): void {
  const row = privateRows()[0]!;
  row['reserved_at'] = new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [account()]);
  fake.replaceRows('automations', [automation(), automation({ id: 'auto-2', name: 'Second automation' })]);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('dm_jobs', []);
  fake.replaceRows('dm_logs', []);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('automation_follow_ups', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('comment_private_reply_reservations', []);
  fake.replaceRows('comment_public_reply_reservations', []);
  mockSendDm.mockReset();
  mockSendDm.mockResolvedValue('msg-1');
  mockReply.mockReset();
  mockReply.mockResolvedValue(undefined);
  timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
});

describe('reservation RPC semantics (module level, fake implements the SQL)', () => {
  it('exactly one of two racing reserve calls is authorized', async () => {
    const [a, b] = await Promise.all([
      reserveCommentPrivateReply(db, 'acct-1', 'cmt-1', 'auto-1'),
      reserveCommentPrivateReply(db, 'acct-1', 'cmt-1', 'auto-2'),
    ]);
    expect([a, b].filter((r) => r.authorized)).toHaveLength(1);
    expect(privateRows()).toHaveLength(1);
  });

  it('rejects a mismatched automation/account pair', async () => {
    const res = await reserveCommentPrivateReply(db, 'acct-OTHER', 'cmt-1', 'auto-1');
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe('invalid_automation_account_pair');
    expect(privateRows()).toHaveLength(0);
  });

  it('a reserve RPC error throws (send must not proceed un-authorized)', async () => {
    fake.setRpcHandler('reserve_comment_private_reply', async () => ({
      data: null,
      error: { message: 'rpc unavailable' },
    }));
    await expect(processAutoDmJob(payload(), 1)).rejects.toThrow('Reservation RPC error');
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('confirm is log-and-swallow on RPC error (never throws after a send)', async () => {
    fake.setRpcHandler('confirm_comment_private_reply_sent', async () => ({
      data: null,
      error: { message: 'confirm write failed' },
    }));
    await expect(
      confirmCommentPrivateReply(db, 'acct-1', 'cmt-1', 'auto-1')
    ).resolves.toBeUndefined();
  });
});

describe('(1) concurrency — only one send per comment', () => {
  it('two workers processing the same job concurrently send exactly once', async () => {
    await Promise.all([processAutoDmJob(payload(), 1), processAutoDmJob(payload(), 1)]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(privateRows()).toHaveLength(1);
    expect(privateRows()[0]!['status']).toBe('sent');
  });

  it('two DIFFERENT automations matching the same comment still send only once (account-wide invariant)', async () => {
    await processAutoDmJob(payload(), 1);
    // auto-2 has no dm_sent_log row for this comment — per-automation dedupe
    // alone would let it send. The reservation is what blocks it.
    await processAutoDmJob(payload({ automationId: 'auto-2' }), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    const job2 = fake.rows('dm_jobs').find((r) => r['automation_id'] === 'auto-2');
    expect(job2?.['status']).toBe('skipped');
    expect(String(job2?.['error_message'])).toContain('already received a private reply');
  });
});

describe('(2) duplicate webhook delivery — no duplicate send', () => {
  it('processing the same comment job twice (sequential redelivery) sends exactly once', async () => {
    await processAutoDmJob(payload(), 1);
    await processAutoDmJob(payload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(privateRows()[0]!['status']).toBe('sent');
  });

  it('the queue layer still dedupes the redelivered webhook (dedupe_key 23505 → no second job)', async () => {
    const first = await enqueueJob('auto_dm', payload(), 'event_auto-1_cmt-1');
    expect(first).toBeTruthy();
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    const second = await enqueueJob('auto_dm', payload(), 'event_auto-1_cmt-1');
    expect(second).toBeNull();
    expect(fake.rows('job_queue')).toHaveLength(1);
  });
});

describe('(3) worker crash between reservation and send — stale recovery is terminal', () => {
  it('a fresh orphaned reservation blocks a second worker; after 10 min it fails closed (never re-authorized)', async () => {
    // Worker A reserves, then crashes BEFORE sending/confirming/releasing.
    const first = await reserveCommentPrivateReply(db, 'acct-1', 'cmt-1', 'auto-1');
    expect(first.authorized).toBe(true);

    // Worker B (job reclaim) is refused while the reservation is fresh.
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();

    // The reservation ages past the stale window. The next attempt does NOT
    // get to send: the row transitions to terminal 'failed' — the system
    // cannot distinguish "crashed before send" from "crashed after send",
    // so it sacrifices this comment's DM rather than risk a duplicate.
    agePrivateReservation(11);
    await processAutoDmJob(payload(), 2);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(privateRows()[0]!['status']).toBe('failed');
    expect(privateRows()[0]!['failure_reason']).toBe('stale_unconfirmed_abandoned');

    // And it stays terminal — no later retry is ever authorized.
    const again = await reserveCommentPrivateReply(db, 'acct-1', 'cmt-1', 'auto-1');
    expect(again.authorized).toBe(false);
    expect(again.reason).toBe('previously_failed');
  });
});

describe('(4) send-success / confirm-failure — what guarantee survives', () => {
  it('a failed confirm leaves the reservation blocking: no duplicate is ever authorized', async () => {
    fake.setRpcHandler('confirm_comment_private_reply_sent', async () => ({
      data: null,
      error: { message: 'confirm write failed' },
    }));

    // The send itself succeeds and is dedupe-recorded; only confirm fails.
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
    // Reservation is stuck at 'reserved' (confirm was swallowed by design).
    expect(privateRows()[0]!['status']).toBe('reserved');

    // Replay through a DIFFERENT automation (so dm_sent_log dedupe cannot
    // be what saves us): the still-fresh reservation refuses authorization.
    await processAutoDmJob(payload({ automationId: 'auto-2' }), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);

    // After the stale window the stuck reservation degrades to 'failed' —
    // still never re-authorized. HONEST GUARANTEE: at-most-once SEND
    // AUTHORIZATION survives a confirm failure. What does NOT survive is
    // delivery bookkeeping accuracy: the row never reads 'sent', and this
    // comment can never be (re)sent by any later job.
    agePrivateReservation(11);
    await processAutoDmJob(payload({ automationId: 'auto-2' }), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(privateRows()[0]!['status']).toBe('failed');
    expect(privateRows()[0]!['failure_reason']).toBe('stale_unconfirmed_abandoned');
  });
});

describe('(5) retry after failure — release only when delivery provably did not happen', () => {
  it('Meta rate-limit (613) releases the reservation; the retry re-reserves and sends exactly once', async () => {
    mockSendDm.mockRejectedValueOnce(new MetaApiError('Calls to this api have exceeded the rate limit', 613, undefined));
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(MetaApiError);
    // Released — no row remains to block the retry.
    expect(privateRows()).toHaveLength(0);

    await processAutoDmJob(payload(), 2);
    // Two Meta ATTEMPTS, exactly one DELIVERY (the 613 attempt was rejected
    // by Meta before processing), reservation ends confirmed 'sent'.
    expect(mockSendDm).toHaveBeenCalledTimes(2);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
    expect(privateRows()[0]!['status']).toBe('sent');
  });

  it('a no-send path (opening DM disabled, nothing configured) releases the reservation for a later retry', async () => {
    fake.replaceRows('automations', [
      automation({ dm_opening_message_enabled: false, dm_opening_message: '', dm_responses: [] }),
      automation({ id: 'auto-2' }),
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(privateRows()).toHaveLength(0); // released, not leaked

    fake.replaceRows('automations', [automation(), automation({ id: 'auto-2' })]);
    await processAutoDmJob(payload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(privateRows()[0]!['status']).toBe('sent');
  });

  it('a definitive non-retryable error (190) marks the reservation FAILED — a retry is refused, not released', async () => {
    mockSendDm.mockRejectedValueOnce(new NonRetryableMetaError('Error validating access token', 190, undefined));
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(NonRetryableMetaError);
    expect(privateRows()[0]!['status']).toBe('failed');

    await processAutoDmJob(payload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1); // the failed attempt only
  });
});

describe('ambiguous outcomes fail closed (the original crash window, now covered)', () => {
  it('a network error after send initiation → AmbiguousDeliveryError, reservation failed, replay blocked', async () => {
    mockSendDm.mockRejectedValueOnce(new Error('socket hangup'));
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(AmbiguousDeliveryError);
    expect(privateRows()[0]!['status']).toBe('failed');
    expect(String(privateRows()[0]!['failure_reason'])).toContain('Ambiguous delivery failure');

    // Replay: dm_sent_log has NO row (the record-at-send design would have
    // resent here) — the failed reservation is what blocks the duplicate.
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    await processAutoDmJob(payload(), 2);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('a scheduled follow-up with an ambiguous send outcome surfaces AmbiguousDeliveryError and fails its row', async () => {
    fake.replaceRows('automations', [
      automation({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
      automation({ id: 'auto-2' }),
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
    mockSendDm.mockRejectedValueOnce(new Error('network timeout'));
    const followUpPayload = payload({
      triggerType: 'dm_reply_followup',
      triggerEventId: 'scheduled_evt-qual-1',
      isFollowUp: true,
      isScheduledFollowUp: true,
      sessionStep: 99,
      followUpText: 'Checking in!',
      commentText: null,
      postId: null,
    });
    await expect(processFollowUpDmJob(followUpPayload)).rejects.toBeInstanceOf(AmbiguousDeliveryError);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('failed');
  });
});

describe('(6) stale reservation recovery — already-sent replies are never resent', () => {
  it('a reservation already in sent state blocks any new job for the comment', async () => {
    fake.seed('comment_private_reply_reservations', [
      {
        id: 'res-1',
        instagram_account_id: 'acct-1',
        comment_id: 'cmt-1',
        automation_id: 'auto-1',
        status: 'sent',
        reserved_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        sent_at: new Date(Date.now() - 59 * 60_000).toISOString(),
        failed_at: null,
        failure_reason: null,
      },
    ]);
    await processAutoDmJob(payload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(privateRows()[0]!['status']).toBe('sent');
  });
});

describe('public reply reservations (parallel state machine)', () => {
  function publicAutomation(id: string): FakeRow {
    return automation({
      id,
      public_reply_enabled: true,
      public_reply_options: ['Check your DMs!'],
    });
  }

  it('a confirmed public reply is never reposted, even if the private layer is reset', async () => {
    fake.replaceRows('automations', [publicAutomation('auto-1'), publicAutomation('auto-2')]);
    await processAutoDmJob(payload(), 1);
    expect(mockReply).toHaveBeenCalledTimes(1);
    expect(fake.rows('comment_public_reply_reservations')[0]!['status']).toBe('sent');

    // Synthetic isolation: wipe ONLY the private reservation + dedupe log
    // (simulating their loss). The public reservation alone must still
    // prevent a second visible public reply.
    fake.replaceRows('comment_private_reply_reservations', []);
    fake.replaceRows('dm_sent_log', []);
    fake.replaceRows('dm_jobs', []);
    await processAutoDmJob(payload(), 2);
    expect(mockReply).toHaveBeenCalledTimes(1);
  });

  it('a thrown public-reply send fails its reservation closed but the private DM still sends', async () => {
    fake.replaceRows('automations', [publicAutomation('auto-1'), publicAutomation('auto-2')]);
    mockReply.mockRejectedValueOnce(new Error('network timeout'));
    await processAutoDmJob(payload(), 1);
    expect(fake.rows('comment_public_reply_reservations')[0]!['status']).toBe('failed');
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(privateRows()[0]!['status']).toBe('sent');
  });
});

describe('reservationDispositionForError — the catch taxonomy (pure)', () => {
  it('pre-send errors release', () => {
    expect(reservationDispositionForError(new Error('jitter exploded'), false)).toBe('release');
  });
  it('Meta rate-limit codes release even after initiation (definitive pre-delivery rejection)', () => {
    expect(reservationDispositionForError(new MetaApiError('slow down', 613, undefined), true)).toBe('release');
    expect(reservationDispositionForError(new MetaApiError('slow down', 4, undefined), true)).toBe('release');
  });
  it('account-pause and non-retryable errors mark failed', () => {
    expect(reservationDispositionForError(new AccountPausedMetaError('blocked', 368, undefined), true)).toBe('mark_failed');
    expect(reservationDispositionForError(new NonRetryableMetaError('bad token', 190, undefined), true)).toBe('mark_failed');
  });
  it('anything else after initiation is ambiguous (fail closed)', () => {
    expect(reservationDispositionForError(new Error('socket hangup'), true)).toBe('ambiguous');
    expect(reservationDispositionForError(new MetaApiError('unknown', 2, undefined), true)).toBe('ambiguous');
  });
});
