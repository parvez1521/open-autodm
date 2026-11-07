/**
 * Programme 18 / Phase J — security matrix, job / processor level.
 * Companion to tests/p18-security-matrix.test.ts (route + repository
 * level), using the Phase F+H harness patterns (mocked Meta surface,
 * real crypto with a synthetic key, FakeSupabase only).
 *
 * Covers the brief's job-path cases: forged job-payload workspace,
 * foreign follow-up session unreadable/unmutable via job paths
 * (including the P17 A-1 suppression-ordering variant — this file is
 * the targeted suite for mutation M4), duplicate-job replay, and
 * no-NULL workspace stamping on job writes.
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
  after: (fn: () => Promise<void>) => { afterCallbacks.push(fn); },
}));

import { enqueueJob } from '@/lib/automation/queue';
import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import {
  sendInstagramDm, sendInstagramLinkButtonDm, sendInstagramCardDm, sendAskToFollowDm, replyToComment,
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
  'inbound_webhook_events', 'contacts',
] as const;

function accountRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'acct-A', user_id: OWNER_A, instagram_user_id: 'IG-A', username: 'creator-a',
    is_active: true, access_token_encrypted: encrypt('token-acct-A', TOKEN_KEY),
    paused_until: null, pause_reason: null, traffic_guard_paused: false,
    workspace_id: WS_A, ...overrides,
  };
}

function automationRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-A', user_id: OWNER_A, instagram_account_id: 'acct-A', name: 'Automation A',
    type: 'comment_dm', is_active: true, post_id: null, keywords: ['LINK'],
    comment_reply_options: [], public_reply_enabled: false, public_reply_options: [],
    trigger_config: null, flow_graph: null,
    dm_opening_message_enabled: true, dm_opening_message: 'Opening from A',
    dm_opening_message_button_title: null, dm_opening_message_button_link: null,
    ask_to_follow_enabled: false, ask_to_follow_message: '',
    ask_to_follow_visit_profile_button: '', ask_to_follow_confirm_button: '',
    dm_responses: [{ id: 'r1', type: 'text', content: 'Response from A' }],
    follow_up_enabled: false, follow_up_delay_minutes: 60, follow_up_message: '',
    is_traffic_guard_paused: false, total_dms_sent: 0, ...overrides,
  };
}

function seedTwoTenants(): void {
  fake.replaceRows('instagram_accounts', [
    accountRow(),
    accountRow({
      id: 'acct-B', user_id: OWNER_B, instagram_user_id: 'IG-B', username: 'creator-b',
      workspace_id: WS_B, access_token_encrypted: encrypt('token-acct-B', TOKEN_KEY),
    }),
  ]);
  fake.replaceRows('automations', [
    automationRow(),
    automationRow({
      id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B', name: 'Automation B',
      dm_opening_message: 'Opening from B',
      dm_responses: [{ id: 'r1', type: 'text', content: 'Response from B' }],
    }),
  ]);
}

function sessionRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'sess-B', automation_id: 'auto-B', instagram_account_id: 'acct-B',
    audience_ig_user_id: 'IG-FAN', current_step: 1, completed: false,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...overrides,
  };
}

function jobPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: 'auto-A', instagramAccountId: 'acct-A', igAccountIgsid: 'IG-A',
    triggerType: 'comment', triggerUserId: 'IG-FAN', triggerUsername: 'fan',
    triggerEventId: 'cmt-1', triggerTimestamp: Date.now(), postId: 'post-1',
    commentText: 'LINK', messageText: null, ...overrides,
  };
}

function totalSends(): number {
  return mockSendDm.mock.calls.length + mockSendLink.mock.calls.length +
    mockSendCard.mock.calls.length + mockAsk.mock.calls.length + mockReply.mock.calls.length;
}
function expectNoSends(): void { expect(totalSends()).toBe(0); }

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
  afterCallbacks.length = 0;
  mockSendDm.mockClear(); mockSendLink.mockClear(); mockSendCard.mockClear();
  mockAsk.mockClear(); mockReply.mockClear();
  timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout,
  );
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
  vi.unstubAllGlobals();
});

describe('forged job payload workspace is ignored / refused (restated F+H case)', () => {
  it('enqueueJob: payload claiming WS_B for a WS_A-bound account enqueues NOTHING', async () => {
    seedTwoTenants();
    const id = await enqueueJob('auto_dm', jobPayload({ workspaceId: WS_B }), 'dedupe-j-forged');
    expect(id).toBeNull();
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('processAutoDmJob: payload workspace WS_B against the WS_A binding ⇒ skipped, 0 sends', async () => {
    seedTwoTenants();
    await processAutoDmJob(
      jobPayload({ triggerType: 'dm', messageText: 'LINK', commentText: null, workspaceId: WS_B }), 1,
    );
    expectNoSends();
    const job = fake.rows('dm_jobs')[0];
    expect(job?.['status']).toBe('skipped');
  });
});

describe('foreign follow-up session is unreadable/unmutable via job paths', () => {
  it('plain foreign session: 0 sends, session byte-identical, no dm_logs', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 }),
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
    expect(fake.rows('dm_logs')).toHaveLength(0);
  });

  it('M4 TARGET — P17 A-1 ordering: foreign session + recipient suppressed under the PAYLOAD account ⇒ session stays byte-identical (pair check runs BEFORE the mutating suppression branch)', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-A', recipient_id: 'IG-FAN' },
    ]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 }),
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  it('M4 TARGET variant: foreign session + suppression lookup FAILURE (fail-closed = suppressed) ⇒ session stays byte-identical', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    fake.setRpcHandler('is_recipient_suppressed', async () => ({
      data: null, error: { message: 'rpc unavailable' },
    }));
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 }),
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  it('control: own session + suppressed recipient completes ONLY the own session, 0 sends', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [
      sessionRow({ id: 'sess-A', automation_id: 'auto-A', instagram_account_id: 'acct-A' }),
    ]);
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-A', recipient_id: 'IG-FAN' },
    ]);
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-A', sessionStep: 1 }),
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });
});

describe('duplicate job replay creates no duplicate / cross-tenant state', () => {
  it('replaying B\u2019s own follow-up job: exactly one delivery total; the second run sees the completed session and sends nothing', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    const payload = jobPayload({
      automationId: 'auto-B', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B',
      triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1,
      workspaceId: WS_B,
    });
    await processFollowUpDmJob(payload);
    const sendsAfterFirst = totalSends();
    expect(sendsAfterFirst).toBeGreaterThan(0);
    await processFollowUpDmJob(payload);
    expect(totalSends()).toBe(sendsAfterFirst);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });

  it('replaying a FOREIGN-session job twice: session untouched on both attempts, 0 sends', async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    const payload = jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 });
    await processFollowUpDmJob(payload);
    await processFollowUpDmJob(payload);
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });
});

describe('job writes are stamped — no unintended NULL-workspace rows', () => {
  it('enqueue + successful auto_dm job: queue row and dm_jobs row both carry WS_A (non-null)', async () => {
    seedTwoTenants();
    const id = await enqueueJob('auto_dm', jobPayload(), 'dedupe-j-stamp');
    expect(id).toBeTruthy();
    expect(fake.rows('job_queue')[0]!['workspace_id']).toBe(WS_A);

    await processAutoDmJob(
      jobPayload({ triggerType: 'dm', messageText: 'LINK', commentText: null }), 1,
    );
    expect(totalSends()).toBeGreaterThan(0);
    const jobs = fake.rows('dm_jobs');
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j['workspace_id'], 'dm_jobs row must be stamped').toBe(WS_A);
    }
  });
});
