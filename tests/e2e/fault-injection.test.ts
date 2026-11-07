/**
 * Phase 10.7 §10.7.2 — ADVERSARIAL FAULT INJECTION across connected
 * workflows.
 *
 * Each scenario injects one fault into a REAL chained workflow
 * (webhook route → ingestion → processor, engine drain, AI route,
 * Meta callbacks, automation CRUD) and asserts the fail-closed /
 * fail-honest outcome PLUS tenant isolation: a second account's rows
 * are seeded in the same world and must be byte-identical afterwards.
 *
 * Boundaries: FakeSupabase world; @/lib/instagram/api is a counting
 * module mock; the queue claim/mark layer is mocked at the same
 * boundary as the parity engine suite (enqueue keeps real dedupe
 * semantics against the fake); global fetch is the harness guard.
 * Synthetic data only; no real Meta delivery is possible.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from '../helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import { hmacSha256Hex } from '@/lib/crypto';
import { buildSignedRequest, metaPayload, IG_SECRET, FB_SECRET } from '../helpers/signedRequest';
import {
  accountRow,
  automationRow,
  followUpRow,
  jobPayload,
  scheduledFollowUpPayload,
  E2E,
  E2E_TOKEN_KEY,
} from './fixtures/payloads';
import { collapseJitter, createFetchGuard, stubFetchGuard, type FetchGuard } from './helpers/harness';
import type { JobQueueRow } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();
const db = fake as unknown as SupabaseClient;

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: E2E_TOKEN_KEY }),
  getAppUrl: () => 'https://app.opendm.in',
  getDashboardLink: () => ({ href: '/', label: 'x' }),
}));
vi.mock('@/lib/instagram/api', () => ({
  sendInstagramDm: vi.fn(async () => 'msg-fi-1'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'msg-fi-2'),
  sendInstagramCardDm: vi.fn(async () => 'msg-fi-3'),
  sendAskToFollowDm: vi.fn(async () => 'msg-fi-4'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
  subscribeToWebhookFields: vi.fn(async () => true),
}));
vi.mock('@/lib/automation/queue', () => ({
  enqueueJob: vi.fn(
    async (
      _jobType: string,
      payload: Record<string, unknown>,
      dedupeKey: string
    ): Promise<string | null> => {
      if (fake.rows('job_queue').some((r) => r['dedupe_key'] === dedupeKey)) return null;
      const res = (await fake
        .from('job_queue')
        .insert({ job_type: _jobType, payload, dedupe_key: dedupeKey })
        .select('id')
        .maybeSingle()) as { data: { id: string } | null };
      return res.data?.id ?? null;
    }
  ),
  claimDueJobs: vi.fn(),
  markJobDone: vi.fn(async () => {}),
  markJobFailed: vi.fn(async () => {}),
  markJobHeld: vi.fn(async () => {}),
  rescheduleJob: vi.fn(async () => {}),
  retryBackoffMs: (attempts: number) => 5000 * Math.pow(5, Math.max(0, attempts - 1)),
}));
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

import { POST as webhookPOST } from '@/app/api/webhook/route';
import { POST as aiGeneratePOST } from '@/app/api/ai/generate/route';
import { POST as deauthorizePOST } from '@/app/api/meta/deauthorize/route';
import { POST as deletionPOST } from '@/app/api/meta/data-deletion/route';
import {
  GET as automationsGET,
  POST as automationsPOST,
} from '@/app/api/automations/route';
import {
  PUT as automationPUT,
  DELETE as automationDELETE,
} from '@/app/api/automations/[id]/route';
import { getMetaSettings } from '@/lib/settings';
import { processAutoDmJob, processFollowUpDmJob, RateLimitUnavailable } from '@/lib/automation/processJob';
import { processDueJobs } from '@/lib/automation/engine';
import { reserveCommentPrivateReply } from '@/lib/automation/reservations';
import { claimDueJobs, markJobDone, markJobHeld } from '@/lib/automation/queue';
import { generateResponseDraft, type WorkersAiBinding } from '@/lib/ai/workersAi';
import { sendInstagramDm, replyToComment } from '@/lib/instagram/api';

const mockGetMetaSettings = vi.mocked(getMetaSettings);
const mockSendDm = vi.mocked(sendInstagramDm);
const mockReply = vi.mocked(replyToComment);
const mockClaim = vi.mocked(claimDueJobs);
const mockDone = vi.mocked(markJobDone);
const mockHeld = vi.mocked(markJobHeld);

const USER_A = 'user-fi-a';
const USER_B = 'user-fi-b';
const ACCT_A_UUID = '11111111-1111-4111-8111-111111111111';
const ACCT_B_UUID = '33333333-3333-4333-8333-333333333333';
const AUTO_A_UUID = '22222222-2222-4222-8222-222222222222';
const AUTO_B_UUID = '44444444-4444-4444-8444-444444444444';

const OTHER_ACCOUNT_ID = 'acct-fi-other';
const OTHER_AUTOMATION_ID = 'auto-fi-other';

let guard: FetchGuard;
let restoreJitter: (() => void) | null = null;
let savedOwnerEnv: Record<string, string | undefined> = {};

function seedOtherTenant(): FakeRow[] {
  const account = accountRow({
    id: OTHER_ACCOUNT_ID,
    user_id: 'user-fi-other',
    instagram_user_id: 'IG-FI-OTHER',
    username: 'other_creator',
  });
  const automation = automationRow({ id: OTHER_AUTOMATION_ID, instagram_account_id: OTHER_ACCOUNT_ID });
  fake.seed('instagram_accounts', [account]);
  fake.seed('automations', [automation]);
  return [account, automation];
}

function expectOtherTenantUntouched(snapshot: FakeRow[]): void {
  const accounts = fake.rows('instagram_accounts').filter((r) => r['id'] === OTHER_ACCOUNT_ID);
  const automations = fake.rows('automations').filter((r) => r['id'] === OTHER_AUTOMATION_ID);
  expect(accounts).toEqual([snapshot[0]]);
  expect(automations).toEqual([snapshot[1]]);
}

function seedMainWorld(): void {
  fake.replaceRows('instagram_accounts', [accountRow()]);
  fake.replaceRows('automations', [automationRow()]);
}

function resetTables(): void {
  for (const table of [
    'instagram_accounts',
    'automations',
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
    'data_deletion_requests',
    'profiles',
  ]) {
    fake.replaceRows(table, []);
  }
}

async function drainAfter(): Promise<void> {
  const pending = afterCallbacks.splice(0, afterCallbacks.length);
  for (const fn of pending) await fn();
}

function signedWebhook(raw: string, secret: string = IG_SECRET): Request {
  return new Request('https://app.opendm.in/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${hmacSha256Hex(secret, Buffer.from(raw, 'utf8'))}`,
    },
    body: raw,
  });
}

function commentRaw(text: string, commentId: string, entryId: string = E2E.ownerIgsid): string {
  return JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: entryId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: E2E.fanIgsid, username: E2E.fanUsername },
              media: { id: E2E.postId },
              id: commentId,
              text,
              timestamp: Math.floor(Date.now() / 1000),
            },
          },
        ],
      },
    ],
  });
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  resetTables();
  afterCallbacks.length = 0;
  mockGetAuthenticatedUser.mockReset();
  mockGetMetaSettings.mockReset();
  mockGetMetaSettings.mockResolvedValue({
    metaAppId: '1586956306036999',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'synthetic-verify-token',
    setupCompleted: true,
  });
  mockSendDm.mockReset();
  mockSendDm.mockResolvedValue('msg-fi-1');
  mockReply.mockClear();
  mockClaim.mockReset();
  mockClaim.mockResolvedValue([]);
  mockDone.mockClear();
  mockHeld.mockClear();
  savedOwnerEnv = {
    OWNER_USER_ID: process.env['OWNER_USER_ID'],
    OWNER_EMAIL: process.env['OWNER_EMAIL'],
  };
  delete process.env['OWNER_EMAIL'];
  process.env['OWNER_USER_ID'] = USER_A;
  delete (globalThis as any).__WORKERS_AI_BINDING;
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
// Database / RPC faults on the send path
// ═══════════════════════════════════════════════════════════════════════

describe('database and RPC faults — no send, other tenant untouched', () => {
  it('DB failure mid-processing (automations fetch errors): job is skipped, zero sends, other tenant untouched', async () => {
    seedMainWorld();
    const snapshot = seedOtherTenant();
    fake.failNextQuery('automations', { message: 'connection reset (forced)' });
    await processAutoDmJob(jobPayload(), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    expectOtherTenantUntouched(snapshot);
  });

  it('rate-limit RPC returns an error (timeout class): RateLimitUnavailable, zero sends, NO reservation consumed', async () => {
    seedMainWorld();
    const snapshot = seedOtherTenant();
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => ({
      data: null,
      error: { message: 'rpc timeout (forced)' },
    }));
    await expect(processAutoDmJob(jobPayload(), 1)).rejects.toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0);
    expectOtherTenantUntouched(snapshot);
  });

  it('rate-limit RPC throws at transport level: same fail-closed outcome', async () => {
    seedMainWorld();
    fake.setRpcHandler('check_and_record_dm_rate_limit', async () => {
      throw new Error('socket timeout (forced)');
    });
    await expect(processAutoDmJob(jobPayload(), 1)).rejects.toBeInstanceOf(RateLimitUnavailable);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
  });

  it('token undecryptable (wrong key material at rest): processing throws before any send or reservation', async () => {
    fake.replaceRows('instagram_accounts', [
      accountRow({ access_token_encrypted: encrypt('synthetic-token', 'ff'.repeat(32)) }),
    ]);
    fake.replaceRows('automations', [automationRow()]);
    const snapshot = seedOtherTenant();
    await expect(processAutoDmJob(jobPayload(), 1)).rejects.toThrow('Token decryption failed');
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0);
    expectOtherTenantUntouched(snapshot);
  });

  it('follow-up claim statement errors: claim returns nothing, zero sends, row stays scheduled for a later attempt', async () => {
    seedMainWorld();
    fake.replaceRows('automations', [
      automationRow({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
    ]);
    fake.seed('automation_follow_ups', [followUpRow()]);
    fake.failNextQuery('automation_follow_ups', { message: 'claim boom (forced)' });
    await processFollowUpDmJob(scheduledFollowUpPayload());
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Configuration / secret absence — fail closed
// ═══════════════════════════════════════════════════════════════════════

describe('missing configuration fails closed', () => {
  it('webhook with NO Meta settings configured: 403, no background work, zero jobs', async () => {
    seedMainWorld();
    mockGetMetaSettings.mockResolvedValue(null);
    const raw = commentRaw('LINK', E2E.commentId);
    const res = await webhookPOST(signedWebhook(raw));
    expect(res.status).toBe(403);
    expect(afterCallbacks).toHaveLength(0);
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(0);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('owner identity unconfigured: even the owner identity gets 403 from the drafting endpoint', async () => {
    delete process.env['OWNER_USER_ID'];
    delete process.env['OWNER_EMAIL'];
    mockGetAuthenticatedUser.mockResolvedValue({ id: USER_A, email: 'a@example.com' });
    const res = await aiGeneratePOST(
      new Request('http://localhost/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'response_draft', prompt: 'Hi' }),
      })
    );
    expect(res.status).toBe(403);
    expect(fake.rows('ai_usage_log')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AI faults
// ═══════════════════════════════════════════════════════════════════════

describe('AI faults — sanitized, never fabricated, never sent', () => {
  it('AI binding missing at the route: public_replies 503 with the designed message and no internals', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: USER_A, email: 'a@example.com' });
    const res = await aiGeneratePOST(
      new Request('http://localhost/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'public_replies', prompt: 'Hi' }),
      })
    );
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('at ');
    expect(text).not.toContain('SECRET');
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(guard.metaAttempts).toHaveLength(0);
  });

  it('AI provider hangs: the 5s deadline yields an honest fallback draft, not a hang and not a send', async () => {
    const hanging: WorkersAiBinding = { run: () => new Promise(() => {}) };
    vi.useFakeTimers();
    try {
      const pending = generateResponseDraft('Explain the program', {}, hanging);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(result.status).toBe('fallback');
      expect(result.data.length).toBeGreaterThan(5);
    } finally {
      vi.useRealTimers();
    }
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('AI provider throws with sensitive detail: generator falls back and the detail appears nowhere in the output', async () => {
    const exploding: WorkersAiBinding = {
      run: async () => {
        throw new Error('upstream SECRET-DETAIL-zzz');
      },
    };
    const result = await generateResponseDraft('Hi', {}, exploding);
    expect(result.status).toBe('fallback');
    expect(result.data).not.toContain('SECRET-DETAIL-zzz');
    expect(mockSendDm).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Webhook adversaries: duplicates, malformation, concurrency, retries
// ═══════════════════════════════════════════════════════════════════════

describe('webhook adversaries', () => {
  beforeEach(() => {
    seedMainWorld();
  });

  it('duplicate webhook deliveries (Meta retries) ⇒ one queued job ⇒ one processing ⇒ one send', async () => {
    const snapshot = seedOtherTenant();
    const raw = commentRaw('LINK', E2E.commentId);
    for (let i = 0; i < 3; i++) {
      const res = await webhookPOST(signedWebhook(raw));
      expect(res.status).toBe(200);
      await drainAfter();
    }
    expect(fake.rows('job_queue')).toHaveLength(1);
    const payload = fake.rows('job_queue')[0]!['payload'] as Parameters<typeof processAutoDmJob>[0];
    await processAutoDmJob(payload, 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expectOtherTenantUntouched(snapshot);
  });

  it('malformed payloads are rejected safely: signed-but-unparseable ⇒ 200 ignored; unknown account ⇒ 200, zero jobs; bad signature ⇒ 403', async () => {
    const broken = '{"object":"instagram","entry":[{broken';
    const brokenRes = await webhookPOST(signedWebhook(broken));
    expect(brokenRes.status).toBe(200);
    expect(((await brokenRes.json()) as { status: string }).status).toBe('ignored');
    await drainAfter();

    const unknownRaw = commentRaw('LINK', 'cmt-unknown', 'IG-DOES-NOT-EXIST');
    const unknownRes = await webhookPOST(signedWebhook(unknownRaw));
    expect(unknownRes.status).toBe(200);
    await drainAfter();

    const badSigRes = await webhookPOST(signedWebhook(commentRaw('LINK', 'cmt-bad'), 'attacker-secret'));
    expect(badSigRes.status).toBe(403);
    await drainAfter();

    expect(fake.rows('job_queue')).toHaveLength(0);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('concurrent processing of the same comment by three workers ⇒ at most one send', async () => {
    await Promise.all([
      processAutoDmJob(jobPayload(), 1),
      processAutoDmJob(jobPayload(), 1),
      processAutoDmJob(jobPayload(), 1),
    ]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(1);
    expect(fake.rows('comment_private_reply_reservations')[0]!['status']).toBe('sent');
  });

  it('repeated sequential retries of the same job ⇒ no duplicate delivery', async () => {
    await processAutoDmJob(jobPayload(), 1);
    await processAutoDmJob(jobPayload(), 2);
    await processAutoDmJob(jobPayload(), 3);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });

  it('reservation conflict: a second automation on the same account+comment is refused authorisation', async () => {
    fake.seed('automations', [automationRow({ id: E2E.automation2Id })]);
    const first = await reserveCommentPrivateReply(db, E2E.accountId, 'cmt-conflict', E2E.automationId);
    expect(first.authorized).toBe(true);
    const second = await reserveCommentPrivateReply(db, E2E.accountId, 'cmt-conflict', E2E.automation2Id);
    expect(second.authorized).toBe(false);
    const third = await reserveCommentPrivateReply(db, E2E.accountId, 'cmt-conflict', E2E.automationId);
    expect(third.authorized).toBe(false);
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Traffic Guard transition DURING a queue drain
// ═══════════════════════════════════════════════════════════════════════

describe('Traffic Guard engages mid-drain', () => {
  it('pause flips after the first job sends: the second job is HELD (not sent, not failed, not done)', async () => {
    seedMainWorld();
    const makeJob = (id: string, eventId: string, fan: string): JobQueueRow =>
      ({
        id,
        job_type: 'auto_dm',
        payload: jobPayload({ triggerEventId: eventId, triggerUserId: fan }),
        dedupe_key: `event_${E2E.automationId}_${eventId}`,
        status: 'processing',
        run_after: new Date().toISOString(),
        attempts: 0,
        max_attempts: 3,
        last_error: null,
        locked_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }) as JobQueueRow;

    mockSendDm.mockImplementationOnce(async () => {
      // The guard engages while the drain is in flight.
      const row = fake.rows('instagram_accounts')[0]!;
      fake.replaceRows('instagram_accounts', [
        { ...row, traffic_guard_paused: true },
        ...fake.rows('instagram_accounts').slice(1),
      ]);
      return 'msg-fi-1';
    });
    mockClaim.mockResolvedValue([makeJob('job-fi-1', 'cmt-fi-1', E2E.fanIgsid), makeJob('job-fi-2', 'cmt-fi-2', 'IG-FI-FAN2')]);

    const result = await processDueJobs(5);
    expect(result).toMatchObject({ claimed: 2, done: 1, held: 1, failed: 0 });
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(mockDone).toHaveBeenCalledTimes(1);
    expect(mockHeld).toHaveBeenCalledTimes(1);
    expect(mockHeld).toHaveBeenCalledWith('job-fi-2', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Callback forgery — zero writes
// ═══════════════════════════════════════════════════════════════════════

describe('invalid signed_request ⇒ 401 with zero DB writes', () => {
  it('both callbacks reject a forged signature; no insert/update/delete is recorded; all rows intact', async () => {
    fake.replaceRows('instagram_accounts', [
      { id: 'acct-fi-cb', user_id: 'op-1', instagram_user_id: 'IG-FI-CB', username: 'creator' },
    ]);
    fake.replaceRows('contacts', [{ id: 'c-1', audience_ig_user_id: 'IG-FI-CB' }]);
    const callsBefore = fake.calls.length;

    const form = (url: string, sr: string): Request => {
      const body = new URLSearchParams();
      body.set('signed_request', sr);
      return new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    };
    const forged = buildSignedRequest(metaPayload('IG-FI-CB'), 'wrong-secret');
    expect((await deauthorizePOST(form('https://app.opendm.in/api/meta/deauthorize', forged))).status).toBe(401);
    expect((await deletionPOST(form('https://app.opendm.in/api/meta/data-deletion', forged))).status).toBe(401);

    const writes = fake.calls
      .slice(callsBefore)
      .filter((c) => c.op === 'insert' || c.op === 'update' || c.op === 'delete' || c.op === 'upsert');
    expect(writes).toHaveLength(0);
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
    expect(fake.rows('contacts')).toHaveLength(1);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-account access — user B against user A's routes
// ═══════════════════════════════════════════════════════════════════════

describe('cross-account access attempts are denied and A\'s data is unchanged', () => {
  const userA = { id: USER_A, email: 'a@example.com' };
  const userB = { id: USER_B, email: 'b@example.com' };
  let snapshotA: string;

  beforeEach(() => {
    fake.replaceRows('instagram_accounts', [
      { id: ACCT_A_UUID, user_id: USER_A, instagram_user_id: 'IG-FI-A', username: 'creator_a', is_active: true, access_token_encrypted: 'x', traffic_guard_paused: false },
      { id: ACCT_B_UUID, user_id: USER_B, instagram_user_id: 'IG-FI-B', username: 'creator_b', is_active: true, access_token_encrypted: 'y', traffic_guard_paused: false },
    ]);
    fake.replaceRows('automations', [
      automationRow({ id: AUTO_A_UUID, user_id: USER_A, instagram_account_id: ACCT_A_UUID, name: 'A automation' }),
      automationRow({ id: AUTO_B_UUID, user_id: USER_B, instagram_account_id: ACCT_B_UUID, name: 'B automation' }),
    ]);
    snapshotA = JSON.stringify(fake.rows('automations').find((r) => r['id'] === AUTO_A_UUID));
    void userA;
  });

  function jsonRequest(url: string, method: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('B cannot list-scope, create-onto, update, or delete A\'s automations; A\'s row is byte-identical afterwards', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(userB);
    const scoped = await automationsGET(
      new Request(`https://app.opendm.in/api/automations?accountId=${ACCT_A_UUID}`)
    );
    expect(scoped.status).toBe(404);

    mockGetAuthenticatedUser.mockResolvedValue(userB);
    const list = await automationsGET(new Request('https://app.opendm.in/api/automations'));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { automations: Array<{ id: string }> };
    expect(listBody.automations.map((a) => a.id)).toEqual([AUTO_B_UUID]);

    mockGetAuthenticatedUser.mockResolvedValue(userB);
    const create = await automationsPOST(
      jsonRequest('https://app.opendm.in/api/automations', 'POST', {
        instagramAccountId: ACCT_A_UUID,
        name: ' hostile',
        type: 'comment_dm',
      })
    );
    expect(create.status).toBe(403);
    expect(fake.rows('automations')).toHaveLength(2);

    mockGetAuthenticatedUser.mockResolvedValue(userB);
    const put = await automationPUT(
      jsonRequest(`https://app.opendm.in/api/automations/${AUTO_A_UUID}`, 'PUT', { name: 'pwned' }),
      { params: Promise.resolve({ id: AUTO_A_UUID }) }
    );
    expect(put.status).toBe(404);

    mockGetAuthenticatedUser.mockResolvedValue(userB);
    const del = await automationDELETE(
      new Request(`https://app.opendm.in/api/automations/${AUTO_A_UUID}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: AUTO_A_UUID }) }
    );
    expect(del.status).toBe(404);

    expect(JSON.stringify(fake.rows('automations').find((r) => r['id'] === AUTO_A_UUID))).toBe(snapshotA);
    expect(fake.rows('instagram_accounts')).toHaveLength(2);
  });

  it('sanity: B CAN create an automation on B\'s own account (the denials above are ownership, not breakage)', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(userB);
    const create = await automationsPOST(
      jsonRequest('https://app.opendm.in/api/automations', 'POST', {
        instagramAccountId: ACCT_B_UUID,
        name: 'B new automation',
        type: 'comment_dm',
        keywords: ['LINK'],
      })
    );
    expect(create.status).toBe(201);
    expect(fake.rows('automations')).toHaveLength(3);
    expect(JSON.stringify(fake.rows('automations').find((r) => r['id'] === AUTO_A_UUID))).toBe(snapshotA);
  });
});
