/**
 * Programme 19 / WS-3 — B-F3 DEFENSE-IN-DEPTH (interactive follow-up pair check).
 *
 * Programme 17 finding B-F3: processFollowUpDmJob (the INTERACTIVE,
 * non-scheduled follow-up processor in src/lib/automation/processJob.ts)
 * had NO direct automation↔account pair validation. It loaded the
 * automation without even selecting instagram_account_id, so the only
 * cross-tenant protection was indirect: the session-ownership check
 * (session.automation_id / session.instagram_account_id vs the payload).
 * That backstop does not prove the AUTOMATION belongs to the payload
 * account — a session whose (automation_id, instagram_account_id) pair
 * was crafted to match the payload, or an automation rebound to another
 * account after its session was created, passes the session check and
 * would then deliver the automation owner's dm_responses under the
 * payload account's token, completing the session.
 *
 * Fix under test (mirrors the scheduled processor's A-2 pre-check):
 *   1. an early pair pre-check at the top of processFollowUpDmJob —
 *      BEFORE the session fetch, BEFORE the suppression branch and
 *      before any session mutation or send (A-1 ordering lesson);
 *   2. a defense-in-depth repeat of the check on the automation row
 *      actually loaded for delivery (instagram_account_id is now in
 *      its select), which returns WITHOUT completing the session.
 * Mismatch outcome for this processor is its established convention:
 * a tenant_context_mismatch debug event and the job is dropped
 * (return) — this processor never writes a dm_jobs row.
 *
 * The decisive construction in every mismatch case below: the session
 * row CLAIMS the payload's automation+account pair, so the pre-existing
 * session-ownership check PASSES. Only the new direct pair check can
 * stop these jobs. (The older foreign-session cases, where the session
 * itself mismatches, are covered by p17-processjob-reverify /
 * tenancy-security-matrix / p18-security-jobs and must stay green.)
 *
 * Harness mirrors tests/p17-processjob-reverify.test.ts: FakeSupabase
 * only, Meta surface mocked, jitter collapsed — zero real Meta calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { AutoDmJobPayload } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32);
const WS_A = 'workspace-A';
const WS_B = 'workspace-B';
const OWNER_A = 'user-owner-a';
const OWNER_B = 'user-owner-b';

const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  getAppUrl: () => 'https://app.opendm.in',
}));
vi.mock('@/lib/instagram/api', () => ({
  META_API_VERSION: 'v23.0',
  sendInstagramDm: vi.fn(async () => 'msg-1'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'msg-2'),
  sendInstagramCardDm: vi.fn(async () => 'msg-3'),
  sendAskToFollowDm: vi.fn(async () => 'msg-4'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
  subscribeToWebhookFields: vi.fn(async () => ({ ok: true })),
}));
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

import { processFollowUpDmJob } from '@/lib/automation/processJob';
import {
  sendInstagramDm,
  sendInstagramLinkButtonDm,
  sendInstagramCardDm,
  sendAskToFollowDm,
  replyToComment,
} from '@/lib/instagram/api';

const mockSendDm = vi.mocked(sendInstagramDm);
const mockSendLink = vi.mocked(sendInstagramLinkButtonDm);
const mockSendCard = vi.mocked(sendInstagramCardDm);
const mockAsk = vi.mocked(sendAskToFollowDm);
const mockReply = vi.mocked(replyToComment);

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

const TABLES = [
  'instagram_accounts', 'automations', 'job_queue', 'dm_sent_log', 'dm_jobs',
  'dm_logs', 'automation_sessions', 'automation_follow_ups', 'recipient_opt_outs',
  'comment_private_reply_reservations', 'comment_public_reply_reservations',
  'workspace_memberships', 'workspace_instagram_accounts', 'profiles',
  'debug_events', 'ai_usage_log', 'app_settings', 'platform_config',
  'inbound_webhook_events',
] as const;

function accountRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'acct-A',
    user_id: OWNER_A,
    instagram_user_id: 'IG-A',
    username: 'creator-a',
    is_active: true,
    access_token_encrypted: encrypt('token-acct-A', TOKEN_KEY),
    paused_until: null,
    pause_reason: null,
    traffic_guard_paused: false,
    workspace_id: WS_A,
    ...overrides,
  };
}

function automationRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-A',
    user_id: OWNER_A,
    instagram_account_id: 'acct-A',
    name: 'Automation A',
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
    dm_opening_message: 'Opening from A',
    dm_opening_message_button_title: null,
    dm_opening_message_button_link: null,
    ask_to_follow_enabled: false,
    ask_to_follow_message: '',
    ask_to_follow_visit_profile_button: '',
    ask_to_follow_confirm_button: '',
    dm_responses: [{ id: 'r1', type: 'text', content: 'Response from A' }],
    follow_up_enabled: false,
    follow_up_delay_minutes: 60,
    follow_up_message: '',
    is_traffic_guard_paused: false,
    total_dms_sent: 0,
    ...overrides,
  };
}

function seedTwoTenants(): void {
  fake.replaceRows('instagram_accounts', [
    accountRow(),
    accountRow({
      id: 'acct-B', user_id: OWNER_B, instagram_user_id: 'IG-B',
      username: 'creator-b', workspace_id: WS_B,
      access_token_encrypted: encrypt('token-acct-B', TOKEN_KEY),
    }),
  ]);
  fake.replaceRows('automations', [
    automationRow(),
    automationRow({
      id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B',
      name: 'Automation B', dm_opening_message: 'Opening from B',
      dm_responses: [{ id: 'r1', type: 'text', content: 'Response from B' }],
    }),
  ]);
}

function jobPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: 'auto-A',
    instagramAccountId: 'acct-A',
    igAccountIgsid: 'IG-A',
    triggerType: 'dm_reply_followup',
    triggerUserId: 'IG-FAN',
    triggerUsername: 'fan',
    triggerEventId: 'tap-1',
    triggerTimestamp: Date.now(),
    postId: 'post-1',
    commentText: null,
    messageText: null,
    isFollowUp: true,
    sessionId: 'sess-A',
    sessionStep: 1,
    ...overrides,
  };
}

/**
 * A session that CLAIMS the payload pair (auto-B + acct-A) — it passes
 * the pre-existing session-ownership check even though auto-B really
 * belongs to acct-B. Only the direct pair check can refuse this job.
 */
function craftedSessionRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'sess-X',
    automation_id: 'auto-B',
    instagram_account_id: 'acct-A',
    audience_ig_user_id: 'IG-FAN',
    current_step: 1,
    completed: false,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function totalSends(): number {
  return (
    mockSendDm.mock.calls.length +
    mockSendLink.mock.calls.length +
    mockSendCard.mock.calls.length +
    mockAsk.mock.calls.length +
    mockReply.mock.calls.length
  );
}

function expectNoSends(): void {
  expect(totalSends(), 'external sends').toBe(0);
}

async function flushDebugLog(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

async function expectMismatchEvent(): Promise<void> {
  await flushDebugLog();
  expect(
    fake.rows('debug_events').some((r) => r['event_type'] === 'tenant_context_mismatch'),
    'tenant_context_mismatch debug event',
  ).toBe(true);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
  afterCallbacks.length = 0;
  mockSendDm.mockClear();
  mockSendLink.mockClear();
  mockSendCard.mockClear();
  mockAsk.mockClear();
  mockReply.mockClear();
  timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
  vi.unstubAllGlobals();
});

// ── (1) Direct pair mismatch — session check alone would PASS ─────────────

describe('B-F3: interactive follow-up direct automation↔account pair check', () => {
  it('(1) foreign automation (auto-B) + payload account acct-A, session claiming the payload pair: 0 sends, session byte-identical, tenant_context_mismatch outcome', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [craftedSessionRow()]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ automationId: 'auto-B', sessionId: 'sess-X' }),
    );
    expectNoSends();
    // No session mutation of any kind: not completed, not advanced, not expired.
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(false);
    expect(fake.rows('dm_logs')).toHaveLength(0);
    await expectMismatchEvent();
  });

  it('(1b) automation rebound to acct-B after its session was created (payload + session both claim the old acct-A pair): 0 sends, session byte-identical', async () => {
    seedTwoTenants();
    // Rebinding: auto-A's row now belongs to acct-B; the session still
    // carries the original (auto-A, acct-A) pair the payload claims.
    const autoA = fake.rows('automations').find((r) => r['id'] === 'auto-A')!;
    autoA['instagram_account_id'] = 'acct-B';
    fake.seed('automation_sessions', [
      craftedSessionRow({ id: 'sess-A', automation_id: 'auto-A', instagram_account_id: 'acct-A' }),
    ]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(jobPayload({ sessionId: 'sess-A' }));
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
    expect(fake.rows('dm_logs')).toHaveLength(0);
    await expectMismatchEvent();
  });

  it('(1c) reverse direction: foreign automation (auto-A) + payload account acct-B, session claiming the payload pair: 0 sends, session byte-identical', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [
      craftedSessionRow({ automation_id: 'auto-A', instagram_account_id: 'acct-B' }),
    ]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({
        automationId: 'auto-A', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B',
        sessionId: 'sess-X', workspaceId: WS_B,
      }),
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
    await expectMismatchEvent();
  });

  // ── (2) Legitimate matched control ──────────────────────────────────────

  it('(2) control: legitimate matched pair (auto-B + acct-B + B session) delivers the response and completes the session', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [
      craftedSessionRow({ automation_id: 'auto-B', instagram_account_id: 'acct-B' }),
    ]);
    await processFollowUpDmJob(
      jobPayload({
        automationId: 'auto-B', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B',
        sessionId: 'sess-X', workspaceId: WS_B,
      }),
    );
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(totalSends()).toBe(1);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });

  it('(2b) control: legitimate matched pair for tenant A (auto-A + acct-A + A session) delivers and completes', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [
      craftedSessionRow({ id: 'sess-A', automation_id: 'auto-A', instagram_account_id: 'acct-A' }),
    ]);
    await processFollowUpDmJob(jobPayload({ sessionId: 'sess-A' }));
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(totalSends()).toBe(1);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });

  // ── (3) Suppression-branch regression ───────────────────────────────────

  it('(3) suppression regression: mismatched pair + recipient suppressed under the payload account — session must NOT be completed/mutated (validation precedes suppression)', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [craftedSessionRow()]);
    // Recipient opted out under acct-A, so the suppression branch WOULD
    // complete the session if it ran before the pair validation.
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-A', recipient_id: 'IG-FAN' },
    ]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ automationId: 'auto-B', sessionId: 'sess-X' }),
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(false);
    await expectMismatchEvent();
  });

  it('(3b) suppression regression, fail-closed variant: mismatched pair + suppression lookup FAILURE (= suppressed) — session stays byte-identical', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [craftedSessionRow()]);
    fake.setRpcHandler('is_recipient_suppressed', async () => ({
      data: null,
      error: { message: 'rpc unavailable' },
    }));
    fake.failNextQuery('recipient_opt_outs', { message: 'connection reset' });
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ automationId: 'auto-B', sessionId: 'sess-X' }),
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  // ── (4) Legitimate suppression control ──────────────────────────────────

  it('(4) control: own matched session + suppressed recipient still completes OWN session with 0 sends (legitimate suppression preserved)', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [
      craftedSessionRow({ id: 'sess-A', automation_id: 'auto-A', instagram_account_id: 'acct-A' }),
    ]);
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-A', recipient_id: 'IG-FAN' },
    ]);
    await processFollowUpDmJob(jobPayload({ sessionId: 'sess-A' }));
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });
});
