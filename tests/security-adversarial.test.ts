/**
 * Phase 10.4 §11/§12 — cross-cutting adversarial integration tests
 * (coordinator integration suite).
 *
 * The per-control suites pin each Phase 10.4 control in isolation:
 *   S-02 signup protection      → tests/signup-protection.test.ts
 *   S-03 cron Bearer-only       → tests/cron-auth.test.ts
 *   S-04 outbound fail-closed   → tests/rate-limit-fail-closed.test.ts
 *   S-07 inbound admission      → tests/inbound-rate-limit.test.ts,
 *                                 tests/webhook-inbound-route.test.ts
 *   S-11 logging scrub          → tests/logging-privacy.test.ts
 *   AI adversarial              → tests/ai-adversarial.test.ts
 *   S-08 storage predicates     → local-PG rehearsal (phase10.4-scratch-D)
 *   forged webhook / malformed signed_request / repeated callbacks /
 *   invalid session / retried follow-up / duplicate webhook
 *                               → pre-existing suites (webhook-route,
 *                                 signed-request, meta-callback-lifecycle,
 *                                 ai-generate-route, parity-*, queue-idempotency)
 *
 * This file pins the one property none of those can express alone:
 * FAILURE INDEPENDENCE — the inbound throttle's designed fail-open mode
 * (S-07: a limiter-store outage admits verified ingestion) must NOT weaken
 * the outbound fail-closed control (S-04: a rate-limit RPC outage blocks
 * every send), and a healthy outbound limiter must not be poisoned by an
 * inbound-store outage either.
 *
 * Precise guarantees under test (never stronger than the implementation):
 *  - Inbound admission NEVER throws and, on store failure, returns the
 *    verified body unfiltered with stats.failOpen = true.
 *  - Outbound processing, on rate-limit RPC error, throws
 *    RateLimitUnavailable (a retryable delay) and performs ZERO sends.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { AutoDmJobPayload, MetaWebhookBody } from '@/lib/types';

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

import {
  admitInboundWebhook,
  type InboundEventStore,
} from '@/lib/automation/inboundRateLimit';
import {
  processAutoDmJob,
  RateLimitUnavailable,
} from '@/lib/automation/processJob';
import { sendInstagramDm } from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

/** Inbound limiter store that is completely down. */
const downStore: InboundEventStore = {
  async checkAndRecord() {
    throw new Error('inbound store unavailable (simulated outage)');
  },
};

function commentBody(commentId: string, account = 'IG-OWNER'): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: account,
        time: nowSec,
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: 'IG-FAN', username: 'fan' },
              media: { id: 'post-1' },
              id: commentId,
              text: 'LINK',
              timestamp: nowSec,
            },
          },
        ],
      },
    ],
  };
}

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
  fake.replaceRows('comment_private_reply_reservations', []);
  fake.replaceRows('comment_public_reply_reservations', []);
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

describe('§12 failure independence — inbound fail-open vs outbound fail-closed', () => {
  it('inbound store outage admits ingestion (fail-open) WHILE the outbound limiter outage still blocks the send (fail-closed)', async () => {
    // 1) Inbound: limiter store down → verified body admitted unfiltered.
    const body = commentBody('cmt-1');
    const admission = await admitInboundWebhook(body, { store: downStore });
    expect(admission.stats.failOpen).toBe(true);
    expect(admission.body).toBe(body);

    // 2) Outbound, same simulated database incident: rate-limit RPC errors.
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => ({
      data: null,
      error: { message: 'connection to database lost (simulated outage)' },
    }));

    // The job must be delayed as "limiter unavailable" — never sent.
    await expect(processAutoDmJob(payload(), 1)).rejects.toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
  });

  it('inbound store outage does not poison a healthy outbound limiter: allowed count → send proceeds', async () => {
    const admission = await admitInboundWebhook(commentBody('cmt-2'), { store: downStore });
    expect(admission.stats.failOpen).toBe(true);

    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => ({
      data: [{ allowed: true, current_count: 1, retry_after_seconds: 0 }],
      error: null,
    }));

    await processAutoDmJob(payload({ triggerEventId: 'cmt-2' }), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });

  it('admission never throws, even with a malformed body and a down store', async () => {
    const weird = { object: 'instagram', entry: 'not-an-array' } as unknown as MetaWebhookBody;
    await expect(admitInboundWebhook(weird, { store: downStore })).resolves.toBeDefined();
  });
});
