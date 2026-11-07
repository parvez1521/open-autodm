/**
 * Programme 17 / Workstream A — CLAIM 1 RE-VERIFICATION (processJob pair checks).
 *
 * Re-verifies the three Programme 16 Phase E fixes in
 * src/lib/automation/processJob.ts from execution, with mismatch variants
 * the Phase E suite did not construct:
 *   (a) automation↔account pair validation in processAutoDmJob — swept
 *       across EVERY trigger type that reaches it (comment / dm /
 *       story_reply / reel_dm share one code path; pinned per type);
 *   (b) session-ownership validation in processFollowUpDmJob — including
 *       the suppression-ordering variant (see DEFECT hunt below);
 *   (c) the same pair check in the scheduled follow-up processor —
 *       including variants where an EARLIER branch (workspace mismatch /
 *       window expiry / follow-up disabled) writes the follow-up row
 *       before the pair check is reached.
 * Plus: legitimate pair-matched controls, account rebinding/unbinding
 * between enqueue and execution, forged payload workspaceId, and
 * retry/duplicate replays of mismatched jobs.
 *
 * REQUIREMENT under test: 0 external sends AND 0 cross-tenant state
 * mutation in every mismatch case. "Cross-tenant state mutation" means a
 * change to a row owned by the OTHER tenant (B's session row, B's
 * follow-up row). The job's own dm_jobs status row (keyed by the
 * payload's own automation/event) is the processor's audit convention
 * and is asserted separately, not counted as cross-tenant mutation.
 *
 * Harness mirrors tests/tenancy-security-matrix.test.ts (real debugLog
 * against FakeSupabase; Meta surface mocked; jitter collapsed).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
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

import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
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
const db = fake as unknown as SupabaseClient;
void db;

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

function sessionRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'sess-B',
    automation_id: 'auto-B',
    instagram_account_id: 'acct-B',
    audience_ig_user_id: 'IG-FAN',
    current_step: 1,
    completed: false,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function followUpRowB(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'fu-B',
    automation_id: 'auto-B',
    instagram_account_id: 'acct-B',
    recipient_id: 'IG-FAN',
    qualified_event_id: 'evt-1',
    status: 'scheduled',
    message_snapshot: 'B follow-up text',
    ...overrides,
  };
}

function scheduledPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return jobPayload({
    automationId: 'auto-B',
    triggerType: 'dm_reply_followup',
    isFollowUp: true,
    isScheduledFollowUp: true,
    sessionStep: 99,
    followUpText: 'B follow-up text',
    triggerEventId: 'scheduled_evt-1',
    ...overrides,
  });
}

/** Total external sends across every Meta surface. */
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

// ── (a) processAutoDmJob pair check — per trigger type ─────────────────────

describe('(a) auto_dm pair mismatch: automation WS-B + account WS-A, per trigger type', () => {
  const triggerCases: Array<{ name: string; overrides: Partial<AutoDmJobPayload> }> = [
    { name: 'comment', overrides: { triggerType: 'comment' } },
    { name: 'dm', overrides: { triggerType: 'dm', messageText: 'LINK', commentText: null } },
    { name: 'story_reply', overrides: { triggerType: 'story_reply', messageText: 'LINK', commentText: null } },
    { name: 'reel_dm', overrides: { triggerType: 'reel_dm', messageText: 'LINK', commentText: null } },
  ];

  for (const tc of triggerCases) {
    it(`${tc.name}: 0 sends, 0 sent-log rows, job skipped with pair-mismatch reason`, async () => {
      seedTwoTenants();
      await processAutoDmJob(jobPayload({ automationId: 'auto-B', ...tc.overrides }), 1);
      expectNoSends();
      expect(fake.rows('dm_sent_log')).toHaveLength(0);
      expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0);
      const job = fake.rows('dm_jobs')[0]!;
      expect(job['status']).toBe('skipped');
      expect(String(job['error_message'])).toContain('automation does not belong to payload account');
      await flushDebugLog();
      expect(fake.rows('debug_events').some((r) => r['event_type'] === 'tenant_context_mismatch')).toBe(true);
    });
  }

  it('reverse direction (automation A + account B) also refuses: 0 sends', async () => {
    seedTwoTenants();
    await processAutoDmJob(
      jobPayload({ automationId: 'auto-A', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B', triggerType: 'dm', messageText: 'LINK', commentText: null }),
      1
    );
    expectNoSends();
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });

  it('retry/duplicate replay of a mismatched job: second attempt still 0 sends', async () => {
    seedTwoTenants();
    const p = jobPayload({ automationId: 'auto-B', triggerType: 'dm', messageText: 'LINK', commentText: null });
    await processAutoDmJob(p, 1);
    await processAutoDmJob(p, 2);
    expectNoSends();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
  });
});

describe('(a) controls: legitimate pair-matched jobs still deliver', () => {
  it('comment trigger, matched pair: opening DM + 1 configured response = 2 sends, job sent', async () => {
    seedTwoTenants();
    await processAutoDmJob(jobPayload(), 1);
    // Opening DM plus the single configured 1-step response — the same
    // "2 DMs" the Phase E hole-1 narrative counted for the mismatched job.
    expect(mockSendDm).toHaveBeenCalledTimes(2);
    expect(totalSends()).toBe(2);
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('sent');
  });

  it('dm trigger, matched pair (tenant B own job): opening + response = 2 sends', async () => {
    seedTwoTenants();
    await processAutoDmJob(
      jobPayload({
        automationId: 'auto-B', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B',
        triggerType: 'dm', messageText: 'LINK', commentText: null, workspaceId: WS_B,
      }),
      1
    );
    expect(mockSendDm).toHaveBeenCalledTimes(2);
    expect(totalSends()).toBe(2);
  });
});

// ── Rebinding / unbinding between enqueue and execution ────────────────────

describe('account/automation rebinding between enqueue and execution', () => {
  it('account rebound WS_A → WS_B after enqueue (payload still claims WS_A): 0 sends, skipped', async () => {
    seedTwoTenants();
    // Simulate rebinding: A's account row now bound to WS_B.
    const acctA = fake.rows('instagram_accounts').find((r) => r['id'] === 'acct-A')!;
    acctA['workspace_id'] = WS_B;
    await processAutoDmJob(jobPayload({ workspaceId: WS_A }), 1);
    expectNoSends();
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
    expect(String(fake.rows('dm_jobs')[0]!['error_message'])).toContain('workspace does not match');
  });

  it('account unbound after enqueue (workspace_id → null, payload claims WS_A): 0 sends, skipped', async () => {
    seedTwoTenants();
    const acctA = fake.rows('instagram_accounts').find((r) => r['id'] === 'acct-A')!;
    acctA['workspace_id'] = null;
    await processAutoDmJob(jobPayload({ workspaceId: WS_A }), 1);
    expectNoSends();
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });

  it('automation rebound to acct-B after enqueue (payload still acct-A): pair check refuses, 0 sends', async () => {
    seedTwoTenants();
    const autoA = fake.rows('automations').find((r) => r['id'] === 'auto-A')!;
    autoA['instagram_account_id'] = 'acct-B';
    await processAutoDmJob(jobPayload({ triggerType: 'dm', messageText: 'LINK', commentText: null }), 1);
    expectNoSends();
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });

  it('forged queue payload workspaceId (WS_B) on an otherwise matched A job: 0 sends, skipped', async () => {
    seedTwoTenants();
    await processAutoDmJob(jobPayload({ workspaceId: WS_B }), 1);
    expectNoSends();
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
    await flushDebugLog();
    expect(fake.rows('debug_events').some((r) => r['event_type'] === 'tenant_context_mismatch')).toBe(true);
  });
});

// ── (b) processFollowUpDmJob session-ownership validation ──────────────────

describe('(b) follow-up session ownership', () => {
  it('session automation mismatch only (account matches payload): 0 sends, session byte-identical', async () => {
    seedTwoTenants();
    // Session claims A's account but B's automation — pair check must catch the automation half.
    fake.seed('automation_sessions', [sessionRow({ instagram_account_id: 'acct-A' })]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 })
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
    expect(fake.rows('dm_logs')).toHaveLength(0);
  });

  it('session account mismatch only (automation matches payload): 0 sends, session byte-identical', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow({ automation_id: 'auto-A' })]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 })
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  it('REGRESSION (P17 defect 1): foreign session + recipient suppressed under the PAYLOAD account — session must stay byte-identical', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    // The fan opted out under A's account, so the payload-account suppression
    // check returns true. Pre-fix, the suppression branch ran BEFORE the
    // session pair check and completed B's session by bare id.
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-A', recipient_id: 'IG-FAN' },
    ]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 })
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  it('REGRESSION (P17 defect 1, fail-closed variant): foreign session + suppression lookup FAILURE (fail-closed = suppressed) — session must stay byte-identical', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    fake.setRpcHandler('is_recipient_suppressed', async () => ({
      data: null,
      error: { message: 'rpc unavailable' },
    }));
    fake.failNextQuery('recipient_opt_outs', { message: 'connection reset' });
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 })
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  it('retry/duplicate replay of a foreign-session follow-up: session untouched on both attempts', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    const p = jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 });
    await processFollowUpDmJob(p);
    await processFollowUpDmJob(p);
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  it('control: own session + suppressed recipient still completes OWN session with 0 sends (legitimate suppression behaviour preserved)', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [
      sessionRow({ id: 'sess-A', automation_id: 'auto-A', instagram_account_id: 'acct-A' }),
    ]);
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-A', recipient_id: 'IG-FAN' },
    ]);
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-A', sessionStep: 1 })
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });

  it("control: B's own follow-up with B's session delivers exactly once and completes it", async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    await processFollowUpDmJob(
      jobPayload({
        automationId: 'auto-B', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B',
        triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1,
        workspaceId: WS_B,
      })
    );
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });
});

// ── (c) Scheduled follow-up processor pair validation ──────────────────────

describe('(c) scheduled follow-up pair validation', () => {
  beforeEach(() => {
    seedTwoTenants();
    fake.replaceRows('automations', [
      automationRow(),
      automationRow({
        id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B', name: 'Automation B',
        follow_up_enabled: true, follow_up_message: 'B follow-up text',
      }),
    ]);
    fake.seed('automation_follow_ups', [followUpRowB()]);
  });

  it('pair mismatch, no workspace claim: 0 sends, B follow-up row stays scheduled (P16 pin re-verified)', async () => {
    await processFollowUpDmJob(scheduledPayload());
    expectNoSends();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });

  it('REGRESSION (P17 defect 2): pair mismatch + forged workspaceId — workspace-mismatch branch must NOT mutate B\u2019s follow-up row', async () => {
    // Payload: A's account (bound WS_A) + B's automation + claim of WS_B.
    // Pre-fix the workspace-mismatch branch called markFollowUpStatus on
    // B's (automation, recipient, event) triple before the pair check.
    await processFollowUpDmJob(scheduledPayload({ workspaceId: WS_B }));
    expectNoSends();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
  });

  it('REGRESSION (P17 defect 2): pair mismatch + expired 24h window — window branch must NOT mutate B\u2019s follow-up row', async () => {
    await processFollowUpDmJob(
      scheduledPayload({ triggerTimestamp: Date.now() - 25 * 3600_000 })
    );
    expectNoSends();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
  });

  it('REGRESSION (P17 defect 2): pair mismatch + follow-up disabled on the foreign automation — inactive branch must NOT mutate B\u2019s follow-up row', async () => {
    const autoB = fake.rows('automations').find((r) => r['id'] === 'auto-B')!;
    autoB['follow_up_enabled'] = false;
    await processFollowUpDmJob(scheduledPayload());
    expectNoSends();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
  });

  it('control: legitimate scheduled follow-up (matched pair) delivers exactly once and marks its own row sent', async () => {
    await processFollowUpDmJob(
      scheduledPayload({ instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B', workspaceId: WS_B })
    );
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(totalSends()).toBe(1);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('sent');
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('sent');
  });
});
