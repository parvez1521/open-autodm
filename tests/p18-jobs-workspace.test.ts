/**
 * Programme 18 / Phase F — job workspace integration fault injection.
 *
 * Proves, against the FakeSupabase harness (no real DB):
 *  - enqueueJob derives the workspace server-side from the account
 *    binding: a forged payload workspaceId fails closed (nothing
 *    enqueued), a missing one is stamped from the binding, and an
 *    unbound account keeps the legacy unstamped shape.
 *  - A rebound account (binding changed between enqueue and execution)
 *    fails closed at execution: 0 sends, 0 foreign mutations.
 *  - The claim-time row/payload cross-check in the engine fails a
 *    tampered job without processing it.
 *  - P16/P17 guarantees restated: mismatched automation↔account pair
 *    (0 sends / 0 sent-log), foreign session (no completion, 0 sends),
 *    foreign scheduled follow-up (no status mutation), foreign webhook
 *    session tap (no job creation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutoDmJobPayload, JobQueueRow, MetaWebhookBody } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32);
const WS_A = 'workspace-A';
const WS_B = 'workspace-B';
const OWNER_A = 'user-owner-a';
const OWNER_B = 'user-owner-b';

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
vi.mock('next/server', () => ({ after: () => {} }));

import { enqueueJob } from '@/lib/automation/queue';
import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import { processDueJobs } from '@/lib/automation/engine';
import { processWebhookPayload } from '@/lib/automation/processWebhook';
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
void (fake as unknown as SupabaseClient);

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

const TABLES = [
  'instagram_accounts', 'automations', 'job_queue', 'dm_sent_log', 'dm_jobs',
  'dm_logs', 'automation_sessions', 'automation_follow_ups', 'recipient_opt_outs',
  'comment_private_reply_reservations', 'comment_public_reply_reservations',
  'workspace_memberships', 'debug_events', 'inbound_webhook_events', 'contacts',
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
    }),
  ]);
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

async function flush(): Promise<void> {
  await new Promise((r) => realSetTimeout(r, 30));
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
  mockSendDm.mockClear(); mockSendLink.mockClear(); mockSendCard.mockClear();
  mockAsk.mockClear(); mockReply.mockClear();
  timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout
  );
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
  vi.unstubAllGlobals();
});

// ── enqueueJob derivation ──────────────────────────────────────────────────

describe('enqueueJob: workspace derived server-side, payload never trusted alone', () => {
  it('forged payload workspaceId (WS_B) for a WS_A-bound account: refused, 0 rows enqueued', async () => {
    seedTwoTenants();
    const id = await enqueueJob('auto_dm', jobPayload({ workspaceId: WS_B }), 'dedupe-forged');
    expect(id).toBeNull();
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('payload asserting a workspace for an UNBOUND account: refused, 0 rows', async () => {
    fake.replaceRows('instagram_accounts', [accountRow({ workspace_id: null })]);
    const id = await enqueueJob('auto_dm', jobPayload({ workspaceId: WS_A }), 'dedupe-unbound-forge');
    expect(id).toBeNull();
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('no payload workspace + bound account: row AND payload stamped with the derived WS_A', async () => {
    seedTwoTenants();
    const id = await enqueueJob('auto_dm', jobPayload(), 'dedupe-derive');
    expect(id).toBeTruthy();
    const row = fake.rows('job_queue')[0]!;
    expect(row['workspace_id']).toBe(WS_A);
    expect((row['payload'] as AutoDmJobPayload).workspaceId).toBe(WS_A);
  });

  it('matching payload workspace + bound account: enqueued and stamped', async () => {
    seedTwoTenants();
    const id = await enqueueJob('auto_dm', jobPayload({ workspaceId: WS_A }), 'dedupe-match');
    expect(id).toBeTruthy();
    expect(fake.rows('job_queue')[0]!['workspace_id']).toBe(WS_A);
  });

  it('unbound account + no payload workspace: legacy shape (no workspace_id key)', async () => {
    fake.replaceRows('instagram_accounts', [accountRow({ workspace_id: null })]);
    fake.replaceRows('automations', [automationRow()]);
    const id = await enqueueJob('auto_dm', jobPayload(), 'dedupe-legacy');
    expect(id).toBeTruthy();
    expect('workspace_id' in fake.rows('job_queue')[0]!).toBe(false);
  });
});

// ── Execution-time revalidation ────────────────────────────────────────────

describe('processAutoDmJob: forged / rebound workspace fails closed', () => {
  it('forged payload workspaceId: 0 sends, 0 sent-log, dm_jobs audit row stamped with the ACTUAL workspace', async () => {
    seedTwoTenants();
    await processAutoDmJob(jobPayload({ workspaceId: WS_B }), 1);
    expect(totalSends()).toBe(0);
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    const job = fake.rows('dm_jobs')[0]!;
    expect(job['status']).toBe('skipped');
    // markJobStatus derives from the account binding — the forged WS_B
    // must never appear as the row's workspace.
    expect(job['workspace_id']).toBe(WS_A);
    await flush();
    const mismatch = fake.rows('debug_events').find((r) => r['event_type'] === 'tenant_context_mismatch');
    expect(mismatch).toBeTruthy();
    expect(mismatch!['workspace_id']).toBe(WS_B); // audit records the CLAIMED workspace on the event itself
  });

  it('rebound between enqueue and execution: enqueued under WS_A, account rebound to WS_B ⇒ 0 sends', async () => {
    seedTwoTenants();
    const id = await enqueueJob('auto_dm', jobPayload({ workspaceId: WS_A }), 'dedupe-rebound');
    expect(id).toBeTruthy();
    const enqueuedPayload = fake.rows('job_queue')[0]!['payload'] as AutoDmJobPayload;
    // Rebind the account to another workspace before the job runs.
    fake.rows('instagram_accounts').find((r) => r['id'] === 'acct-A')!['workspace_id'] = WS_B;
    await processAutoDmJob(enqueuedPayload, 1);
    expect(totalSends()).toBe(0);
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });

  it('unbound after enqueue (binding removed, payload claims WS_A): 0 sends', async () => {
    seedTwoTenants();
    fake.rows('instagram_accounts').find((r) => r['id'] === 'acct-A')!['workspace_id'] = null;
    await processAutoDmJob(jobPayload({ workspaceId: WS_A }), 1);
    expect(totalSends()).toBe(0);
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });
});

// ── Claim-time cross-check (engine) ────────────────────────────────────────

describe('engine claim cross-check: job_queue row vs payload workspace', () => {
  it('row stamped WS_B but payload claims WS_A: job failed closed, never processed, 0 sends', async () => {
    seedTwoTenants();
    fake.seed('job_queue', [{ id: 'job-tampered', status: 'processing' }]);
    const row: JobQueueRow = {
      id: 'job-tampered', job_type: 'auto_dm', workspace_id: WS_B,
      payload: jobPayload({ workspaceId: WS_A }), dedupe_key: 'dk-tampered',
      status: 'processing', run_after: new Date().toISOString(), attempts: 0,
      max_attempts: 3, last_error: null, locked_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    fake.setRpcHandler('claim_due_jobs', () => ({ data: [row], error: null }));
    const result = await processDueJobs(10);
    expect(result.failed).toBe(1);
    expect(result.done).toBe(0);
    expect(totalSends()).toBe(0);
    expect(fake.rows('job_queue')[0]!['status']).toBe('failed');
  });

  it('row-only workspace is adopted into the payload and the matched job still delivers', async () => {
    seedTwoTenants();
    const row: JobQueueRow = {
      id: 'job-adopt', job_type: 'auto_dm', workspace_id: WS_A,
      payload: jobPayload(), dedupe_key: 'dk-adopt',
      status: 'processing', run_after: new Date().toISOString(), attempts: 0,
      max_attempts: 3, last_error: null, locked_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    fake.setRpcHandler('claim_due_jobs', () => ({ data: [row], error: null }));
    const result = await processDueJobs(10);
    expect(result.done).toBe(1);
    expect(totalSends()).toBe(2); // opening + 1-step response
    expect(row.payload.workspaceId).toBe(WS_A);
  });
});

// ── P16/P17 guarantees restated ────────────────────────────────────────────

describe('P16/P17 guarantees restated', () => {
  it('mismatched automation↔account pair: 0 sends, 0 sent-log rows', async () => {
    seedTwoTenants();
    await processAutoDmJob(jobPayload({ automationId: 'auto-B' }), 1);
    expect(totalSends()).toBe(0);
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });

  it('foreign session in follow-up job: session NOT completed, 0 sends (A-1 ordering intact)', async () => {
    seedTwoTenants();
    fake.replaceRows('automation_sessions', [{
      id: 'sess-B', automation_id: 'auto-B', instagram_account_id: 'acct-B',
      audience_ig_user_id: 'IG-FAN', current_step: 1, completed: false,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }]);
    // Recipient suppressed under A's account: pre-P17 ordering would have
    // completed B's session in the suppression branch.
    fake.replaceRows('recipient_opt_outs', [{
      id: 'oo-1', instagram_account_id: 'acct-A', recipient_id: 'IG-FAN',
    }]);
    await processFollowUpDmJob(jobPayload({
      triggerType: 'dm_reply_followup', isFollowUp: true,
      sessionId: 'sess-B', sessionStep: 1,
    }));
    expect(totalSends()).toBe(0);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(false);
  });

  it('foreign scheduled follow-up: B follow-up row status NOT mutated, 0 sends (A-2 intact)', async () => {
    seedTwoTenants();
    fake.replaceRows('automation_follow_ups', [{
      id: 'fu-B', automation_id: 'auto-B', instagram_account_id: 'acct-B',
      recipient_id: 'IG-FAN', qualified_event_id: 'evt-1', status: 'scheduled',
      message_snapshot: 'B follow-up text',
    }]);
    await processFollowUpDmJob(jobPayload({
      automationId: 'auto-B', triggerType: 'dm_reply_followup', isFollowUp: true,
      isScheduledFollowUp: true, sessionStep: 99, followUpText: 'B follow-up text',
      triggerEventId: 'scheduled_evt-1',
      // Window-expired variant: pre-P17 this branch marked B's row expired.
      triggerTimestamp: Date.now() - 48 * 3_600_000,
    }));
    expect(totalSends()).toBe(0);
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
  });

  it('foreign webhook session tap: no job created, session untouched (B-F2 intact)', async () => {
    seedTwoTenants();
    fake.replaceRows('automation_sessions', [{
      id: 'sess-B', automation_id: 'auto-B', instagram_account_id: 'acct-B',
      audience_ig_user_id: 'IG-FAN', current_step: 1, completed: false,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }]);
    const now = Date.now();
    const body: MetaWebhookBody = {
      object: 'instagram',
      entry: [{
        id: 'IG-A', time: Math.floor(now / 1000),
        messaging: [{
          sender: { id: 'IG-FAN' }, recipient: { id: 'IG-A' }, timestamp: now,
          postback: { payload: 'SESSION_sess-B_STEP_1', title: 'Send me the link' },
        } as never],
      }],
    };
    const enqueued = await processWebhookPayload(body);
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(false);
    expect(totalSends()).toBe(0);
  });
});
