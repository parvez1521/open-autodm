/**
 * Phase 10.7 §10.7.1 — CONNECTED JOURNEYS A–F.
 *
 * Each journey chains the REAL route handlers + engine together in ONE
 * FakeSupabase world (not isolated units):
 *   A: owner sign-in (mocked auth) → OAuth callback (REAL oauth.ts over
 *      the fetch router; token encrypted at rest) → automation created
 *      through the REAL POST /api/automations route → REAL webhook route
 *      (valid HMAC) → REAL processWebhookPayload → job queue → REAL
 *      processAutoDmJob → reservation + mocked Meta boundary.
 *      Oracle: deliveries-to-real-Meta = 0 (every fetch attempt is an
 *      OAuth-router URL; sends exist only as module-mock calls).
 *   B: manual public replies — TEMPLATE text only; a spying Workers AI
 *      binding proves ZERO AI generation anywhere in the reply path.
 *   C: scheduled follow-up — Meta 613 failure releases the claim →
 *      retry succeeds → a further duplicate execution sends nothing;
 *      an ambiguous failure fails the row closed and never re-sends.
 *      (Guarantee wording per Phase 5/6 docs: the follow-up claim is
 *      atomic — exactly-once execution of the claim; the reservation
 *      system for comment replies is at-most-once authorisation.)
 *   D: Traffic Guard — pause holds the job (throws the hold signal,
 *      nothing sent, nothing recorded sent); resume processes it once.
 *      (Engine-drain variant lives in fault-injection.test.ts.)
 *   E: all four drafting actions as the owner (REAL workersAi over a
 *      mocked binding); non-owner 403 ×4; provider error text never
 *      leaks into responses; ZERO outbound sends in the whole journey.
 *   F: deauthorize + data-deletion + status chain, including the
 *      failure-honesty legs: a downstream DB failure must surface as
 *      500 (deauthorize) or as a 'failed' status record (data
 *      deletion) — never as a false success.
 *
 * Boundaries (same as the Phase 10.3 harness): Supabase is the fake;
 * @/lib/instagram/api is a counting module mock; global fetch is the
 * harness guard. Synthetic data only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT } from 'jose';
import { FakeSupabase, type FakeRow } from '../helpers/fakeSupabase';
import { decrypt } from '@/lib/crypto';
import { buildSignedRequest, metaPayload, IG_SECRET, FB_SECRET } from '../helpers/signedRequest';
import { hmacSha256Hex } from '@/lib/crypto';
import {
  accountRow,
  automationRow,
  followUpRow,
  jobPayload,
  scheduledFollowUpPayload,
  E2E,
  E2E_TOKEN_KEY,
} from './fixtures/payloads';
import {
  collapseJitter,
  createFetchGuard,
  createOAuthFetchRouter,
  stubFetchGuard,
  type FetchGuard,
} from './helpers/harness';
import type { MetaWebhookBody } from '@/lib/types';

const fake = new FakeSupabase();

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/settings', () => ({
  getMetaSettings: async () => ({
    metaAppId: '1586956306036999',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'synthetic-verify-token',
    setupCompleted: true,
  }),
  saveMetaSettings: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: E2E_TOKEN_KEY }),
  getAppUrl: () => 'https://app.opendm.in',
  getDashboardLink: () => ({ href: '/', label: 'x' }),
}));
vi.mock('@/lib/instagram/api', () => ({
  sendInstagramDm: vi.fn(async () => 'msg-j-1'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'msg-j-2'),
  sendInstagramCardDm: vi.fn(async () => 'msg-j-3'),
  sendAskToFollowDm: vi.fn(async () => 'msg-j-4'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
  subscribeToWebhookFields: vi.fn(async () => true),
}));
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

import { GET as oauthCallbackGET } from '@/app/api/instagram/callback/route';
import { POST as automationsPOST } from '@/app/api/automations/route';
import { POST as webhookPOST } from '@/app/api/webhook/route';
import { POST as aiGeneratePOST } from '@/app/api/ai/generate/route';
import { POST as deauthorizePOST } from '@/app/api/meta/deauthorize/route';
import { POST as deletionPOST } from '@/app/api/meta/data-deletion/route';
import { GET as deletionStatusGET } from '@/app/api/meta/data-deletion/status/route';
import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import { AccountOnTrafficGuardPause } from '@/lib/automation/trafficGuardError';
import { MetaApiError, AmbiguousDeliveryError } from '@/lib/instagram/errors';
import {
  sendInstagramDm,
  sendInstagramLinkButtonDm,
  sendInstagramCardDm,
  sendAskToFollowDm,
  replyToComment,
  getAudienceProfile,
  subscribeToWebhookFields,
} from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
const mockReply = vi.mocked(replyToComment);
const mockSubscribe = vi.mocked(subscribeToWebhookFields);
const allSendMocks = [
  vi.mocked(sendInstagramDm),
  vi.mocked(sendInstagramLinkButtonDm),
  vi.mocked(sendInstagramCardDm),
  vi.mocked(sendAskToFollowDm),
  vi.mocked(replyToComment),
  vi.mocked(getAudienceProfile),
];

const OWNER = { id: E2E.ownerUserId, email: 'owner@example.com' };
const OTHER = { id: E2E.otherUserId, email: 'other@example.com' };
const NEW_IG_ID = 'IG-E2E-NEW';

let guard: FetchGuard;
let restoreJitter: (() => void) | null = null;
let savedOwnerEnv: Record<string, string | undefined> = {};

async function signState(userId: string): Promise<string> {
  const key = new TextEncoder().encode(`state:${E2E_TOKEN_KEY}`);
  return new SignJWT({ userId, nonce: 'journey-nonce' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
}

function signWebhook(secret: string, body: string): string {
  return `sha256=${hmacSha256Hex(secret, Buffer.from(body, 'utf8'))}`;
}

async function drainAfter(): Promise<void> {
  const pending = afterCallbacks.splice(0, afterCallbacks.length);
  for (const fn of pending) await fn();
}

function resetWorld(): void {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const table of [
    'instagram_accounts',
    'automations',
    'profiles',
    'job_queue',
    'dm_sent_log',
    'dm_jobs',
    'dm_logs',
    'automation_sessions',
    'automation_follow_ups',
    'recipient_opt_outs',
    'comment_private_reply_reservations',
    'comment_public_reply_reservations',
    'ai_usage_log',
    'contacts',
    'automation_sessions',
    'data_deletion_requests',
  ]) {
    fake.replaceRows(table, []);
  }
  afterCallbacks.length = 0;
  mockGetAuthenticatedUser.mockReset();
  for (const m of allSendMocks) m.mockClear();
  mockSubscribe.mockClear();
  delete (globalThis as any).__WORKERS_AI_BINDING;
}

beforeEach(() => {
  resetWorld();
  savedOwnerEnv = {
    OWNER_USER_ID: process.env['OWNER_USER_ID'],
    OWNER_EMAIL: process.env['OWNER_EMAIL'],
  };
  delete process.env['OWNER_EMAIL'];
  process.env['OWNER_USER_ID'] = OWNER.id;
  guard = createFetchGuard();
  stubFetchGuard(guard);
  restoreJitter = collapseJitter();
});

afterEach(() => {
  for (const key of ['OWNER_USER_ID', 'OWNER_EMAIL'] as const) {
    if (savedOwnerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedOwnerEnv[key];
  }
  delete (globalThis as any).__WORKERS_AI_BINDING;
  restoreJitter?.();
  restoreJitter = null;
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════════
// Journey A — sign-in → connect → create → webhook → process → send
// ═══════════════════════════════════════════════════════════════════════

describe('Journey A — connect → create automation → signed webhook → processing → mocked send', () => {
  it('the full chain: ciphertext at rest, exactly one queued job, one reservation, one mocked send, zero real deliveries', async () => {
    // ── Connect: REAL OAuth code over the fetch router.
    const { router, calls: routerCalls } = createOAuthFetchRouter();
    guard = createFetchGuard(router);
    stubFetchGuard(guard);

    const state = await signState(OWNER.id);
    const connectRes = await oauthCallbackGET(
      new Request(`https://app.opendm.in/api/instagram/callback?code=synthetic-auth-code&state=${state}`)
    );
    expect(connectRes.status).toBe(302);
    expect(connectRes.headers.get('location')).toContain('instagram_connected=true');

    const account = fake.rows('instagram_accounts')[0]!;
    expect(account['user_id']).toBe(OWNER.id);
    expect(account['instagram_user_id']).toBe(NEW_IG_ID);
    const stored = account['access_token_encrypted'] as string;
    expect(stored.split(':')).toHaveLength(3);
    expect(stored).not.toContain('synthetic-long-lived-token');
    expect(decrypt(stored, E2E_TOKEN_KEY)).toBe('synthetic-long-lived-token');
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    const accountId = account['id'] as string;

    // ── Create the automation through the REAL route as the signed-in owner.
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const createRes = await automationsPOST(
      new Request('https://app.opendm.in/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instagramAccountId: accountId,
          name: 'Journey A automation',
          type: 'comment_dm',
          keywords: ['LINK'],
          dmOpeningMessageEnabled: true,
          dmOpeningMessage: 'Here is your guide',
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = ((await createRes.json()) as { automation: { id: string } }).automation;
    expect(created.id).toBeTruthy();

    // Harness fidelity note: the route's INSERT relies on the Postgres
    // column DEFAULT for is_traffic_guard_paused (false); FakeSupabase
    // does not model column defaults, so the stored row is completed
    // with exactly the value the real DB would have supplied.
    const storedAutomation = fake.rows('automations').find((r) => r['id'] === created.id)!;
    expect(storedAutomation['is_traffic_guard_paused']).toBeUndefined();
    storedAutomation['is_traffic_guard_paused'] = false;

    // ── A non-matching comment first: signed webhook, zero jobs.
    const missBody: MetaWebhookBody = {
      object: 'instagram',
      entry: [
        {
          id: NEW_IG_ID,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'comments',
              value: {
                from: { id: E2E.fanIgsid, username: E2E.fanUsername },
                media: { id: E2E.postId },
                id: 'cmt-j-miss',
                text: 'HELLO',
                timestamp: Math.floor(Date.now() / 1000),
              },
            },
          ],
        },
      ],
    } as MetaWebhookBody;
    const missRaw = JSON.stringify(missBody);
    const missRes = await webhookPOST(
      new Request('https://app.opendm.in/api/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signWebhook(IG_SECRET, missRaw) },
        body: missRaw,
      })
    );
    expect(missRes.status).toBe(200);
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(0);

    // ── The matching comment: signed webhook → exactly one queued job.
    const hitBody = JSON.parse(JSON.stringify(missBody)) as MetaWebhookBody;
    (hitBody.entry[0]!.changes![0]!.value as { text: string; id: string }).text = 'LINK';
    (hitBody.entry[0]!.changes![0]!.value as { text: string; id: string }).id = E2E.commentId;
    const hitRaw = JSON.stringify(hitBody);
    const hitRes = await webhookPOST(
      new Request('https://app.opendm.in/api/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signWebhook(IG_SECRET, hitRaw) },
        body: hitRaw,
      })
    );
    expect(hitRes.status).toBe(200);
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(1);
    const payload = fake.rows('job_queue')[0]!['payload'] as Parameters<typeof processAutoDmJob>[0];
    expect(payload.automationId).toBe(created.id);
    expect(payload.triggerEventId).toBe(E2E.commentId);

    // ── Processing: opt-out + rate-limit checks pass (fake defaults),
    //    reservation is created, the mocked boundary is reached once.
    await processAutoDmJob(payload, 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    const [, recipient] = mockSendDm.mock.calls[0]! as unknown as [string, { commentId?: string }, string, string];
    expect(recipient).toEqual({ commentId: E2E.commentId });
    const reservations = fake.rows('comment_private_reply_reservations');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!['status']).toBe('sent');
    expect(fake.rows('dm_sent_log')).toHaveLength(1);

    // ── Zero real deliveries: every fetch attempt was an OAuth-router
    //    URL; nothing ever attempted a Meta send over the network.
    expect(guard.metaAttempts.length).toBeGreaterThan(0);
    expect(guard.metaAttempts.every((u) => routerCalls.includes(u))).toBe(true);
    expect(guard.metaAttempts.some((u) => u.includes('/messages'))).toBe(false);
  });

  it('a forged webhook signature in the same world enqueues nothing and sends nothing', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow()]);
    const raw = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: E2E.ownerIgsid,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'comments',
              value: {
                from: { id: E2E.fanIgsid, username: E2E.fanUsername },
                media: { id: E2E.postId },
                id: E2E.commentId,
                text: 'LINK',
                timestamp: Math.floor(Date.now() / 1000),
              },
            },
          ],
        },
      ],
    });
    const res = await webhookPOST(
      new Request('https://app.opendm.in/api/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signWebhook('attacker-secret', raw) },
        body: raw,
      })
    );
    expect(res.status).toBe(403);
    expect(afterCallbacks).toHaveLength(0);
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(0);
    expect(mockSendDm).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Journey B — manual public replies, AI proven absent
// ═══════════════════════════════════════════════════════════════════════

describe('Journey B — manual public replies send TEMPLATE text; AI is never invoked', () => {
  const OPTIONS = ['Check your DMs!', 'Sent you a DM'];
  let aiRunSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    aiRunSpy = vi.fn(async () => ({ response: 'AI GENERATED TEXT THAT MUST NEVER SHIP' }));
    (globalThis as any).__WORKERS_AI_BINDING = { run: aiRunSpy };
  });

  it('ENABLED: the posted reply is one of the configured templates, verbatim; AI binding untouched; no usage rows', async () => {
    fake.replaceRows('automations', [
      automationRow({ public_reply_enabled: true, public_reply_options: OPTIONS }),
    ]);
    await processAutoDmJob(jobPayload(), 1);
    expect(mockReply).toHaveBeenCalledTimes(1);
    const [, text] = mockReply.mock.calls[0]! as unknown as [string, string, string];
    expect(OPTIONS).toContain(text);
    expect(text).not.toContain('AI GENERATED');
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    // The negative guarantee: no AI generation was invoked anywhere in
    // the public-reply path (the binding is the ONLY way generation
    // could run, and the usage log would record any drafting call).
    expect(aiRunSpy).not.toHaveBeenCalled();
    expect(fake.rows('ai_usage_log')).toHaveLength(0);
  });

  it('DISABLED: no public reply at all; the private DM still flows; AI untouched', async () => {
    fake.replaceRows('automations', [
      automationRow({ public_reply_enabled: false, public_reply_options: OPTIONS }),
    ]);
    await processAutoDmJob(jobPayload(), 1);
    expect(mockReply).not.toHaveBeenCalled();
    expect(fake.rows('comment_public_reply_reservations')).toHaveLength(0);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(aiRunSpy).not.toHaveBeenCalled();
    expect(fake.rows('ai_usage_log')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Journey C — scheduled follow-up: failure → retry → success → dedupe
// ═══════════════════════════════════════════════════════════════════════

describe('Journey C — scheduled follow-up claim → failure → retry → single delivery', () => {
  let delivered = 0;

  beforeEach(() => {
    delivered = 0;
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [
      automationRow({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
    ]);
    fake.seed('automation_follow_ups', [followUpRow()]);
    mockSendDm.mockReset();
    mockSendDm.mockImplementation(async () => {
      delivered += 1;
      return 'msg-j-fu';
    });
  });

  it('Meta 613 releases the claim (row back to scheduled); the retry delivers exactly once; a duplicate execution sends nothing', async () => {
    mockSendDm.mockRejectedValueOnce(
      new MetaApiError('Calls to this api have exceeded the rate limit', 613, undefined)
    );
    await expect(processFollowUpDmJob(scheduledFollowUpPayload())).rejects.toBeInstanceOf(MetaApiError);
    expect(delivered).toBe(0);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');

    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(delivered).toBe(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');

    // Duplicate claim/execution attempt after success: prevented by the
    // atomic claim (status 'sent' is not claimable).
    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(delivered).toBe(1);
    expect(mockSendDm).toHaveBeenCalledTimes(2); // 1 failed attempt + 1 delivery
  });

  it('an ambiguous send failure fails the row closed — no retry is ever authorised to send', async () => {
    mockSendDm.mockRejectedValueOnce(new Error('socket hangup'));
    await expect(processFollowUpDmJob(scheduledFollowUpPayload())).rejects.toBeInstanceOf(
      AmbiguousDeliveryError
    );
    expect(delivered).toBe(0);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('failed');

    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(delivered).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Journey D — Traffic Guard hold / resume at the processor
// ═══════════════════════════════════════════════════════════════════════

describe('Journey D — Traffic Guard pause holds the job; resume processes it exactly once', () => {
  beforeEach(() => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow()]);
  });

  it('account pause: job throws the hold signal, nothing is sent or recorded sent; after resume the SAME job completes once', async () => {
    const row = fake.rows('instagram_accounts')[0]!;
    fake.replaceRows('instagram_accounts', [{ ...row, traffic_guard_paused: true }]);

    await expect(processAutoDmJob(jobPayload(), 1)).rejects.toBeInstanceOf(AccountOnTrafficGuardPause);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('dm_jobs').filter((r) => r['status'] === 'sent')).toHaveLength(0);
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0);

    fake.replaceRows('instagram_accounts', [{ ...row, traffic_guard_paused: false }]);
    await processAutoDmJob(jobPayload(), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });

  it('automation-level pause holds identically', async () => {
    fake.replaceRows('automations', [automationRow({ is_traffic_guard_paused: true })]);
    await expect(processAutoDmJob(jobPayload(), 1)).rejects.toBeInstanceOf(AccountOnTrafficGuardPause);
    expect(mockSendDm).not.toHaveBeenCalled();

    fake.replaceRows('automations', [automationRow({ is_traffic_guard_paused: false })]);
    await processAutoDmJob(jobPayload(), 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Journey E — drafting: owner yes, non-owner no, failures sanitized
// ═══════════════════════════════════════════════════════════════════════

describe('Journey E — the four drafting actions, owner-gated, with zero outbound sends', () => {
  function postRequest(body: unknown): Request {
    return new Request('http://localhost/api/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function installBinding(run: ReturnType<typeof vi.fn>): void {
    (globalThis as any).__WORKERS_AI_BINDING = { run };
  }

  function expectZeroSends(): void {
    for (const m of allSendMocks) expect(m).not.toHaveBeenCalled();
    expect(guard.metaAttempts).toHaveLength(0);
  }

  it('owner: all four actions return drafts through the mocked binding; usage log holds the four truthful features', async () => {
    installBinding(
      vi.fn(async () => ({
        response:
          'Alpha draft one here\nBeta draft two here\nGamma draft three here\nDelta draft four here\nEpsilon draft five here',
      }))
    );
    for (const action of ['opening_variations', 'public_replies', 'response_draft', 'follow_up_draft']) {
      mockGetAuthenticatedUser.mockResolvedValue(OWNER);
      const res = await aiGeneratePOST(postRequest({ action, prompt: 'Warm welcome', count: 5 }));
      expect(res.status).toBe(200);
    }
    expect(fake.rows('ai_usage_log').map((r) => r['feature'])).toEqual([
      'opening_variations',
      'public_reply_draft',
      'response_draft',
      'follow_up_draft',
    ]);
    expectZeroSends();
  });

  it('non-owner: 403 for EACH of the four actions; nothing logged; zero sends', async () => {
    installBinding(vi.fn(async () => ({ response: 'should never be used' })));
    for (const action of ['opening_variations', 'public_replies', 'response_draft', 'follow_up_draft']) {
      mockGetAuthenticatedUser.mockResolvedValue(OTHER);
      const res = await aiGeneratePOST(postRequest({ action, prompt: 'Hi' }));
      expect(res.status).toBe(403);
    }
    expect(fake.rows('ai_usage_log')).toHaveLength(0);
    expectZeroSends();
  });

  it('provider failure is sanitized: the upstream error text never appears in any response body', async () => {
    installBinding(
      vi.fn(async () => {
        throw new Error('provider exploded SECRET-DETAIL-xyz with internal trace');
      })
    );
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const replies = await aiGeneratePOST(postRequest({ action: 'public_replies', prompt: 'Hi' }));
    expect(replies.status).toBe(503);
    expect(await replies.text()).not.toContain('SECRET-DETAIL-xyz');

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const opening = await aiGeneratePOST(postRequest({ action: 'opening_variations', prompt: 'Hi', count: 3 }));
    expect(opening.status).toBe(200); // honest fallback, not a fabricated "AI" success claim
    const openingBody = await opening.text();
    expect(openingBody).not.toContain('SECRET-DETAIL-xyz');
    expect(openingBody).toContain('fallback');
    expectZeroSends();
  });

  it('binding unavailable: drafting degrades honestly (fallbacks / 503), still zero sends', async () => {
    delete (globalThis as any).__WORKERS_AI_BINDING;
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const opening = await aiGeneratePOST(postRequest({ action: 'opening_variations', prompt: 'Hi', count: 3 }));
    expect(opening.status).toBe(200);
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const replies = await aiGeneratePOST(postRequest({ action: 'public_replies', prompt: 'Hi' }));
    expect(replies.status).toBe(503);
    expectZeroSends();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Journey F — Meta lifecycle with failure honesty
// ═══════════════════════════════════════════════════════════════════════

describe('Journey F — deauthorize / data-deletion / status, honest under failure', () => {
  const DEAUTH_URL = 'https://app.opendm.in/api/meta/deauthorize';
  const DELETION_URL = 'https://app.opendm.in/api/meta/data-deletion';

  function formRequest(url: string, signedRequest: string): Request {
    const body = new URLSearchParams();
    body.set('signed_request', signedRequest);
    return new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  function seedLifecycle(): void {
    fake.replaceRows('instagram_accounts', [
      { id: 'acct-jf', user_id: 'op-1', instagram_user_id: 'IG-JF-OWNER', username: 'creator' },
    ]);
    fake.replaceRows('contacts', [
      { id: 'c-fan', audience_ig_user_id: 'IG-JF-FAN' },
      { id: 'c-other', audience_ig_user_id: 'IG-JF-OTHER' },
    ]);
    fake.replaceRows('dm_jobs', [
      { id: 'j-fan', trigger_user_id: 'IG-JF-FAN' },
      { id: 'j-other', trigger_user_id: 'IG-JF-OTHER' },
    ]);
    fake.replaceRows('data_deletion_requests', []);
  }

  beforeEach(() => {
    seedLifecycle();
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.opendm.in';
  });

  it('deauthorize disconnects the account; data-deletion removes ONLY the requester; status returns the documented shape', async () => {
    const deauthSr = buildSignedRequest(metaPayload('IG-JF-OWNER'), IG_SECRET);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, deauthSr))).status).toBe(200);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
    expect(fake.rows('contacts')).toHaveLength(2); // deauthorize ≠ audience deletion

    const delSr = buildSignedRequest(metaPayload('IG-JF-FAN'), FB_SECRET);
    const res = await deletionPOST(formRequest(DELETION_URL, delSr));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toHaveLength(16);
    expect(body.url).toBe(`https://app.opendm.in/data-deletion/status?code=${body.confirmation_code}`);
    expect(fake.rows('contacts').map((r) => r['id'])).toEqual(['c-other']);
    expect(fake.rows('dm_jobs').map((r) => r['id'])).toEqual(['j-other']);

    const statusRes = await deletionStatusGET(
      new Request(`https://app.opendm.in/api/meta/data-deletion/status?code=${body.confirmation_code}`)
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as Record<string, unknown>;
    expect(Object.keys(statusBody).sort()).toEqual(
      ['completed_at', 'confirmation_code', 'status', 'updated_at'].sort()
    );
    expect(statusBody['status']).toBe('completed');
    expect(statusBody['confirmation_code']).toBe(body.confirmation_code);
  });

  it('downstream DB failure during audience deletion: the record is marked FAILED and the status endpoint reports failed — never completed', async () => {
    const delSr = buildSignedRequest(metaPayload('IG-JF-FAN'), IG_SECRET);
    fake.failNextQuery('contacts', { message: 'connection reset (forced)' });
    const res = await deletionPOST(formRequest(DELETION_URL, delSr));
    // The Meta contract response is still owed for a valid signature…
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmation_code: string };
    // …but the recorded truth is failure, and the fan's row survives.
    const record = fake.rows('data_deletion_requests')[0]! as FakeRow;
    expect(record['status']).toBe('failed');
    expect(fake.rows('contacts')).toHaveLength(2);

    const statusRes = await deletionStatusGET(
      new Request(`https://app.opendm.in/api/meta/data-deletion/status?code=${body.confirmation_code}`)
    );
    expect(((await statusRes.json()) as { status: string }).status).toBe('failed');
  });

  it('DB failure in deauthorize: 500 (Meta may retry), account NOT removed, no false success', async () => {
    const deauthSr = buildSignedRequest(metaPayload('IG-JF-OWNER'), IG_SECRET);
    fake.failNextQuery('instagram_accounts', { message: 'connection reset (forced)' });
    const res = await deauthorizePOST(formRequest(DEAUTH_URL, deauthSr));
    expect(res.status).toBe(500);
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
  });

  it('DB failure before the deletion record exists: 500 with NO confirmation code issued', async () => {
    const delSr = buildSignedRequest(metaPayload('IG-JF-FAN'), IG_SECRET);
    fake.failNextQuery('data_deletion_requests', { message: 'connection reset (forced)' });
    const res = await deletionPOST(formRequest(DELETION_URL, delSr));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['confirmation_code']).toBeUndefined();
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
    expect(fake.rows('contacts')).toHaveLength(2);
  });
});
