/**
 * Phase 10.3 §9 — Performance & reliability guarantees (EXTENSION suite).
 *
 * This file deliberately does NOT re-prove what earlier suites already pin
 * down; it covers only the gaps they leave (see
 * phase10.3-reliability-report.md for the full guarantee → coverage map):
 *
 *  (a) Concurrent duplicate events for the same comment: the existing
 *      concurrency tests race the SAME automation (parity-reservations) or
 *      run cross-automation races SEQUENTIALLY. Here two/three workers for
 *      DIFFERENT automations race the same comment concurrently, and two
 *      duplicate enqueues race at the queue layer.
 *  (b) Retry exhaustion as a full lifecycle: queue-idempotency proves one
 *      counted reschedule landing exactly on max_attempts; here a job is
 *      driven drain-by-drain to its terminal 'failed' state, the backoff
 *      progression is asserted end-to-end, non-counted (rate-limit style)
 *      reschedules are shown to NEVER exhaust, and the max_attempts=1
 *      boundary fails on the first counted attempt.
 *  (c) Database unavailable on the send path: existing fail-closed tests
 *      cover the reservation RPC and the opt-out lookup. Here the account
 *      fetch itself errors, the queue claim RPC errors, and the follow-up
 *      claim statement errors — in each case NO Meta send may occur and no
 *      record may claim a send happened.
 *  (d) AI binding unavailable → drafting route 503 with no fabricated
 *      defaults: ALREADY COVERED by tests/ai-generate-route.test.ts
 *      ("returns a clear 503 failure and does NOT fabricate static defaults
 *      when AI binding is unavailable" + the provider-error twin) and the
 *      lib-level timeout fallbacks in tests/workers-ai.test.ts. Cited, not
 *      duplicated — see the report.
 *  (e) getEnv fail-closed: every other suite MOCKS @/lib/env, so the REAL
 *      validator has never been exercised. This file does NOT mock it —
 *      processJob runs against the real getEnv() with a valid synthetic
 *      environment, and the (e) block loads a FRESH copy of the module
 *      (vi.resetModules + dynamic import, so its cache starts empty) per
 *      scenario. Synthetic values only; assertions check that error
 *      messages name the variable and never contain any configured value.
 *  (f) Follow-up double-claim race: parity-process-job proves the claim
 *      sequentially (first wins, second null; double processing sends
 *      once). Here both claims — and both full processors — run
 *      CONCURRENTLY (Promise.all).
 *
 * Style mirrors parity-reservations.test.ts: REAL processors / queue /
 * follow-up claim against FakeSupabase; only the Meta API surface and the
 * debug logger are mocked; jitter collapsed via a setTimeout stub.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { AutoDmJobPayload, JobQueueRow } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32); // 64 hex chars = 32-byte synthetic test key
const db = fake as unknown as SupabaseClient;

// ── Synthetic environment for the REAL getEnv() (this file never mocks it) ──
const SYNTH_ENV: Record<string, string> = {
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-key-0001',
  TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
  CRON_SECRET: 'synthetic-cron-secret-0001',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-anon-key-00000001',
  NEXT_PUBLIC_APP_URL: 'https://app.opendm.in',
};
const savedProcessEnv: Record<string, string | undefined> = {};
for (const key of Object.keys(SYNTH_ENV)) {
  savedProcessEnv[key] = process.env[key];
  process.env[key] = SYNTH_ENV[key]!;
}
afterAll(() => {
  for (const key of Object.keys(SYNTH_ENV)) {
    if (savedProcessEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProcessEnv[key]!;
  }
});

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/instagram/api', () => ({
  sendInstagramDm: vi.fn(async () => 'msg-1'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'msg-2'),
  sendInstagramCardDm: vi.fn(async () => 'msg-3'),
  sendAskToFollowDm: vi.fn(async () => 'msg-4'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
}));

import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import { enqueueJob, claimDueJobs, rescheduleJob, retryBackoffMs } from '@/lib/automation/queue';
import { claimFollowUpForSending } from '@/lib/automation/followUps';
import { sendInstagramDm, replyToComment } from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
const mockReply = vi.mocked(replyToComment);

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

function jobRow(overrides: Partial<JobQueueRow> = {}): JobQueueRow {
  return {
    id: 'job-1',
    job_type: 'auto_dm',
    payload: payload(),
    dedupe_key: 'event_auto-1_cmt-1',
    status: 'processing',
    run_after: new Date().toISOString(),
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    locked_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const QUALIFIED_EVENT = 'evt-qual-1';

function seedFollowUp(status = 'scheduled'): void {
  fake.replaceRows('automations', [
    automation({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
    automation({ id: 'auto-2', name: 'Second automation' }),
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

// ═══════════════════════════════════════════════════════════════════════════
// (a) Concurrent duplicate events for the same comment
// ═══════════════════════════════════════════════════════════════════════════

describe('(a) concurrent duplicate events — exactly one send authorization', () => {
  it('two workers for DIFFERENT automations racing the same comment concurrently send exactly once', async () => {
    await Promise.all([
      processAutoDmJob(payload({ automationId: 'auto-1' }), 1),
      processAutoDmJob(payload({ automationId: 'auto-2' }), 1),
    ]);
    // The account-wide reservation — not per-automation dm_sent_log dedupe —
    // is what authorizes exactly one of the two racers.
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    const rows = fake.rows('comment_private_reply_reservations');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['status']).toBe('sent');
    // The loser was explicitly skipped, not failed.
    const statuses = fake.rows('dm_jobs').map((r) => r['status']).sort();
    expect(statuses).toEqual(['sent', 'skipped']);
  });

  it('a three-way race (two automations + a redelivered retry) still authorizes exactly one send', async () => {
    await Promise.all([
      processAutoDmJob(payload({ automationId: 'auto-1' }), 1),
      processAutoDmJob(payload({ automationId: 'auto-2' }), 1),
      processAutoDmJob(payload({ automationId: 'auto-1' }), 2),
    ]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(1);
    expect(fake.rows('comment_private_reply_reservations')[0]!['status']).toBe('sent');
    expect(fake.rows('dm_sent_log')).toHaveLength(1);
  });

  it('two concurrent duplicate enqueues for the same dedupe key create exactly one job', async () => {
    // Postgres enforces job_queue.dedupe_key UNIQUE; exactly one of the two
    // racing inserts must lose with 23505 (injected here, the established
    // suite pattern — FakeSupabase has no unique index). Whichever call
    // loses, the observable contract is identical: one row, one id.
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    const [a, b] = await Promise.all([
      enqueueJob('auto_dm', payload(), 'event_auto-1_cmt-1'),
      enqueueJob('auto_dm', payload(), 'event_auto-1_cmt-1'),
    ]);
    expect([a, b].filter((id) => id !== null)).toHaveLength(1);
    expect([a, b].filter((id) => id === null)).toHaveLength(1);
    expect(fake.rows('job_queue')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) Retry exhaustion — terminal state, never retried forever
// ═══════════════════════════════════════════════════════════════════════════

describe('(b) retry exhaustion — a persistently failing job terminates', () => {
  it('counted reschedules walk 5s → 25s → 125s and the job is FAILED at max_attempts (default 3)', async () => {
    // Default max_attempts = 3 comes from the job_queue schema
    // (migration 20260729000003: max_attempts INTEGER NOT NULL DEFAULT 3);
    // rescheduleJob reads it from the claimed row on every drain.
    let current = jobRow({ attempts: 0, max_attempts: 3 });
    fake.seed('job_queue', [{ ...current }]);

    const delays: number[] = [];
    const statuses: unknown[] = [];
    for (let drain = 0; drain < 3; drain++) {
      const delay = retryBackoffMs(current.attempts + 1);
      delays.push(delay);
      await rescheduleJob(current, delay, 'transient boom', true);
      const row = fake.rows('job_queue')[0]!;
      statuses.push(row['status']);
      current = { ...current, attempts: row['attempts'] as number };
    }

    expect(delays).toEqual([5_000, 25_000, 125_000]);
    // Pending below the cap, terminally failed exactly AT the cap — and a
    // 'failed' row is never selected by claim_due_jobs (pending-only), so
    // no fourth drain can resurrect it.
    expect(statuses).toEqual(['pending', 'pending', 'failed']);
    const finalRow = fake.rows('job_queue')[0]!;
    // Bookkeeping nuance, pinned as-is: the exhausting call delegates to
    // markJobFailed(), which writes status/last_error but does NOT persist
    // the final attempts increment — the terminal row reads max_attempts-1.
    // Termination is unaffected (claim selects on status, not attempts).
    expect(finalRow['attempts']).toBe(2);
    expect(finalRow['last_error']).toBe('transient boom');
    expect(finalRow['locked_at']).toBeNull();
  });

  it('non-counted reschedules (rate-limit / pause style) NEVER exhaust the job', async () => {
    const job = jobRow({ attempts: 1, max_attempts: 3 });
    fake.seed('job_queue', [{ ...job }]);
    for (let i = 0; i < 5; i++) {
      await rescheduleJob(job, 900_000, null, false);
    }
    const row = fake.rows('job_queue')[0]!;
    expect(row['status']).toBe('pending');
    expect(row['attempts']).toBe(1); // waiting out a window is not a failure
  });

  it('boundary: max_attempts=1 fails terminally on the FIRST counted attempt', async () => {
    const job = jobRow({ attempts: 0, max_attempts: 1 });
    fake.seed('job_queue', [{ ...job }]);
    await rescheduleJob(job, retryBackoffMs(1), 'boom', true);
    const row = fake.rows('job_queue')[0]!;
    expect(row['status']).toBe('failed');
    expect(row['last_error']).toBe('boom');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) Database unavailable on the send path — no send, no false "sent"
// ═══════════════════════════════════════════════════════════════════════════

describe('(c) DB unavailable on the send path — fail safe, never mark sent', () => {
  it('account-fetch DB errors abort the job BEFORE any Meta call; nothing is recorded as sent', async () => {
    // processAutoDmJob touches instagram_accounts twice before the send:
    // the owner lookup (degrades gracefully to a null owner) and the
    // account fetch itself (must abort). Both statements error here.
    fake.failNextQuery('instagram_accounts', { message: 'connection reset by peer', code: '08006' });
    fake.failNextQuery('instagram_accounts', { message: 'connection reset by peer', code: '08006' });

    await expect(processAutoDmJob(payload(), 1)).rejects.toThrow('Instagram account not found or inactive');

    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    expect(fake.rows('dm_jobs')).toHaveLength(0); // no status row at all — certainly not 'sent'
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0);
  });

  it('a failing claim_due_jobs RPC drains nothing and does not throw (jobs stay pending for the next drain)', async () => {
    fake.setRpcHandler('claim_due_jobs', async () => ({
      data: null,
      error: { message: 'db unavailable' },
    }));
    await expect(claimDueJobs(5)).resolves.toEqual([]);
    expect(mockSendDm).not.toHaveBeenCalled();
  });

  it('a DB error at the follow-up claim aborts the send and leaves the row claimable (still scheduled)', async () => {
    seedFollowUp('scheduled');
    // The claim's conditional UPDATE is the first automation_follow_ups
    // statement on the happy path — make exactly that statement fail.
    fake.failNextQuery('automation_follow_ups', { message: 'connection reset by peer', code: '08006' });

    await processFollowUpDmJob(scheduledPayload());

    expect(mockSendDm).not.toHaveBeenCalled();
    // Safe state: NOT 'sending' (no worker owns it), NOT 'sent'/'failed' —
    // a later drain can still claim and deliver it exactly once.
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
    const job = fake.rows('dm_jobs')[0];
    expect(job?.['status']).toBe('skipped');
    expect(job?.['status']).not.toBe('sent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (f) Follow-up double-claim race — concurrent form
// ═══════════════════════════════════════════════════════════════════════════

describe('(f) follow-up double-claim race — exactly one winner under concurrency', () => {
  it('two CONCURRENT claims for the same follow-up: exactly one wins', async () => {
    seedFollowUp('scheduled');
    const [a, b] = await Promise.all([
      claimFollowUpForSending(db, 'auto-1', 'IG-FAN', QUALIFIED_EVENT),
      claimFollowUpForSending(db, 'auto-1', 'IG-FAN', QUALIFIED_EVENT),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sending');
  });

  it('two CONCURRENT scheduled-follow-up processors send exactly one DM', async () => {
    seedFollowUp('scheduled');
    await Promise.all([
      processFollowUpDmJob(scheduledPayload()),
      processFollowUpDmJob(scheduledPayload()),
    ]);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (e) getEnv fail-closed — the REAL validator (never exercised elsewhere:
//     every other suite mocks @/lib/env). Each scenario loads a FRESH module
//     copy (resetModules + dynamic import) so the module-level cache starts
//     empty; the statically imported copy used by processJob above keeps its
//     own already-validated cache and is unaffected.
// ═══════════════════════════════════════════════════════════════════════════

describe('(e) getEnv fail-closed at first access (real module)', () => {
  function applyEnv(vars: Record<string, string | undefined>): void {
    for (const key of Object.keys(SYNTH_ENV)) {
      if (vars[key] === undefined) delete process.env[key];
      else process.env[key] = vars[key]!;
    }
  }

  async function freshGetEnv(): Promise<() => Record<string, unknown>> {
    vi.resetModules();
    const mod = (await import('@/lib/env')) as { getEnv: () => Record<string, unknown> };
    return mod.getEnv;
  }

  function thrownMessage(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected getEnv to throw, but it returned');
  }

  afterEach(() => {
    applyEnv(SYNTH_ENV); // restore the valid synthetic set for other suites
  });

  it('missing TOKEN_ENCRYPTION_KEY throws, naming the variable and leaking NO configured value', async () => {
    applyEnv({ ...SYNTH_ENV, TOKEN_ENCRYPTION_KEY: undefined });
    const getEnv = await freshGetEnv();
    const message = thrownMessage(() => getEnv());
    expect(message).toContain('TOKEN_ENCRYPTION_KEY');
    expect(message).not.toContain(SYNTH_ENV['SUPABASE_SERVICE_ROLE_KEY']!);
    expect(message).not.toContain(SYNTH_ENV['CRON_SECRET']!);
    expect(message).not.toContain(SYNTH_ENV['NEXT_PUBLIC_SUPABASE_ANON_KEY']!);
  });

  it('missing SUPABASE_SERVICE_ROLE_KEY throws, naming the variable', async () => {
    applyEnv({ ...SYNTH_ENV, SUPABASE_SERVICE_ROLE_KEY: undefined });
    const getEnv = await freshGetEnv();
    expect(thrownMessage(() => getEnv())).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('missing CRON_SECRET throws, naming the variable', async () => {
    applyEnv({ ...SYNTH_ENV, CRON_SECRET: undefined });
    const getEnv = await freshGetEnv();
    expect(thrownMessage(() => getEnv())).toContain('CRON_SECRET');
  });

  it('missing NEXT_PUBLIC_SUPABASE_URL throws, naming the variable', async () => {
    applyEnv({ ...SYNTH_ENV, NEXT_PUBLIC_SUPABASE_URL: undefined });
    const getEnv = await freshGetEnv();
    expect(thrownMessage(() => getEnv())).toContain('NEXT_PUBLIC_SUPABASE_URL');
  });

  it('a MALFORMED TOKEN_ENCRYPTION_KEY (not 64 hex chars) also fails closed, naming the variable', async () => {
    applyEnv({ ...SYNTH_ENV, TOKEN_ENCRYPTION_KEY: 'synthetic-but-not-hex' });
    const getEnv = await freshGetEnv();
    const message = thrownMessage(() => getEnv());
    expect(message).toContain('TOKEN_ENCRYPTION_KEY');
    expect(message).not.toContain('synthetic-but-not-hex'); // the bad value is not echoed
  });

  it('control: a complete valid environment parses and returns the values', async () => {
    applyEnv(SYNTH_ENV);
    const getEnv = await freshGetEnv();
    const env = getEnv();
    expect(env['TOKEN_ENCRYPTION_KEY']).toBe(TOKEN_KEY);
    expect(env['NEXT_PUBLIC_SUPABASE_URL']).toBe(SYNTH_ENV['NEXT_PUBLIC_SUPABASE_URL']);
  });
});
