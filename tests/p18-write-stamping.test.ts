/**
 * Programme 18 / Phase H — new-write workspace stamping.
 *
 * For every tenant write path in the automation territory, a record
 * created under a workspace-BOUND parent must carry the parent's
 * workspace_id (derived server-side), and the same write under an
 * UNBOUND parent must stay in the legacy shape (no workspace_id key) —
 * the legacy path is explicit, never silently stamped.
 *
 * RPC-created rows (contacts / opt-outs / reservations / traffic events /
 * inbound events) are stamped by the code-side post-RPC stamp; the RPC
 * handlers here simulate the real functions' row creation in the fake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutoDmJobPayload, MetaWebhookBody } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32);
const WS_A = 'workspace-A';
const OWNER_A = 'user-owner-a';

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

import { processAutoDmJob } from '@/lib/automation/processJob';
import { scheduleFollowUpMessage, recordWaitingResponseFollowUp } from '@/lib/automation/followUps';
import { recordContactInteraction } from '@/lib/automation/contacts';
import { recordRecipientOptOut } from '@/lib/automation/optOut';
import { reserveCommentPrivateReply } from '@/lib/automation/reservations';
import { recordAndEvaluateCommentTraffic } from '@/lib/trafficGuard/tracker';
import { admitInboundWebhook } from '@/lib/automation/inboundRateLimit';
import { debugLog } from '@/lib/debugLog';

const db = fake as unknown as SupabaseClient;
const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

const TABLES = [
  'instagram_accounts', 'automations', 'job_queue', 'dm_sent_log', 'dm_jobs',
  'dm_logs', 'automation_sessions', 'automation_follow_ups', 'recipient_opt_outs',
  'comment_private_reply_reservations', 'comment_public_reply_reservations',
  'debug_events', 'inbound_webhook_events', 'contacts', 'comment_traffic_events',
  'dm_rate_events',
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
    dm_opening_message_button_title: 'Send me the link', dm_opening_message_button_link: null,
    ask_to_follow_enabled: false, ask_to_follow_message: '',
    ask_to_follow_visit_profile_button: '', ask_to_follow_confirm_button: '',
    dm_responses: [{ id: 'r1', type: 'text', content: 'Response from A' }],
    follow_up_enabled: false, follow_up_delay_minutes: 60, follow_up_message: '',
    is_traffic_guard_paused: false, total_dms_sent: 0, ...overrides,
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

async function flush(ms = 40): Promise<void> {
  await new Promise((r) => realSetTimeout(r, ms));
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
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

// ── processJob write paths ─────────────────────────────────────────────────

describe('processAutoDmJob writes under a BOUND parent carry workspace_id', () => {
  it('session + dm_logs + dm_sent_log + dm_jobs + debug_events all stamped WS_A (2-step flow)', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow()]);
    await processAutoDmJob(jobPayload(), 1);
    expect(fake.rows('automation_sessions')[0]!['workspace_id']).toBe(WS_A);
    expect(fake.rows('dm_logs')[0]!['workspace_id']).toBe(WS_A);
    expect(fake.rows('dm_sent_log')[0]!['workspace_id']).toBe(WS_A);
    expect(fake.rows('dm_jobs')[0]!['workspace_id']).toBe(WS_A);
    await flush();
    const events = fake.rows('debug_events').filter((r) => r['event_type'] === 'job_completed');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!['workspace_id']).toBe(WS_A);
  });

  it('1-step flow (no button): dm_sent_log + dm_jobs stamped WS_A', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow({ dm_opening_message_button_title: null })]);
    await processAutoDmJob(jobPayload(), 1);
    expect(fake.rows('dm_sent_log')[0]!['workspace_id']).toBe(WS_A);
    expect(fake.rows('dm_jobs')[0]!['workspace_id']).toBe(WS_A);
    expect(fake.rows('automation_sessions')).toHaveLength(0);
  });
});

describe('processAutoDmJob writes under an UNBOUND parent stay legacy (no workspace_id)', () => {
  it('session + dm_logs + dm_sent_log + dm_jobs carry no workspace_id key', async () => {
    fake.replaceRows('instagram_accounts', [accountRow({ workspace_id: null })]);
    fake.replaceRows('automations', [automationRow()]);
    await processAutoDmJob(jobPayload(), 1);
    for (const table of ['automation_sessions', 'dm_logs', 'dm_sent_log', 'dm_jobs'] as const) {
      const row = fake.rows(table)[0]!;
      expect(row, table).toBeTruthy();
      expect('workspace_id' in row, table).toBe(false);
    }
  });
});

// ── Follow-ups ─────────────────────────────────────────────────────────────

describe('automation_follow_ups stamping', () => {
  const params = {
    automationId: 'auto-A', instagramAccountId: 'acct-A', igAccountIgsid: 'IG-A',
    recipientId: 'IG-FAN', qualifiedEventId: 'evt-1', qualifiedTimestamp: Date.now(),
    delayMinutes: 60, message: 'Checking in!',
  };

  it('scheduled follow-up row + its job_queue row stamped WS_A under a bound account', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    const ok = await scheduleFollowUpMessage(db, params);
    expect(ok).toBe(true);
    expect(fake.rows('automation_follow_ups')[0]!['workspace_id']).toBe(WS_A);
    expect(fake.rows('job_queue')[0]!['workspace_id']).toBe(WS_A);
  });

  it('waiting-response follow-up row stamped WS_A under a bound account', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    await recordWaitingResponseFollowUp(db, {
      automationId: 'auto-A', instagramAccountId: 'acct-A', recipientId: 'IG-FAN',
      commentId: 'cmt-1', commentTimestamp: Date.now(), delayMinutes: 60, message: 'Checking in!',
    });
    expect(fake.rows('automation_follow_ups')[0]!['workspace_id']).toBe(WS_A);
  });

  it('unbound account: follow-up rows keep the legacy shape', async () => {
    fake.replaceRows('instagram_accounts', [accountRow({ workspace_id: null })]);
    await scheduleFollowUpMessage(db, params);
    expect('workspace_id' in fake.rows('automation_follow_ups')[0]!).toBe(false);
    await recordWaitingResponseFollowUp(db, {
      automationId: 'auto-A', instagramAccountId: 'acct-A', recipientId: 'IG-FAN',
      commentId: 'cmt-9', commentTimestamp: Date.now(), delayMinutes: 60, message: 'Checking in!',
    });
    for (const row of fake.rows('automation_follow_ups')) {
      expect('workspace_id' in row).toBe(false);
    }
  });
});

// ── RPC-created rows: post-RPC stamps ──────────────────────────────────────

describe('RPC-created rows stamped from the parent binding', () => {
  it('contacts: row created by record_contact_interaction RPC is stamped WS_A; unbound stays NULL', async () => {
    fake.setRpcHandler('record_contact_interaction', (p, f) => {
      f.rows('contacts').push({
        instagram_account_id: p['p_account_id'], audience_ig_user_id: p['p_audience_id'],
      });
      return { data: null, error: null };
    });
    fake.replaceRows('instagram_accounts', [accountRow()]);
    recordContactInteraction({
      instagramAccountId: 'acct-A', audienceIgUserId: 'IG-FAN', triggerType: 'comment', automationId: 'auto-A',
    });
    await flush(60);
    expect(fake.rows('contacts')[0]!['workspace_id']).toBe(WS_A);

    fake.replaceRows('contacts', []);
    fake.replaceRows('instagram_accounts', [accountRow({ workspace_id: null })]);
    recordContactInteraction({
      instagramAccountId: 'acct-A', audienceIgUserId: 'IG-FAN', triggerType: 'comment', automationId: 'auto-A',
    });
    await flush(60);
    expect('workspace_id' in fake.rows('contacts')[0]!).toBe(false);
  });

  it('recipient_opt_outs: RPC-created row stamped WS_A; unbound stays unstamped', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    const ok = await recordRecipientOptOut(db, {
      instagramAccountId: 'acct-A', recipientId: 'IG-FAN', triggerEventId: 'cmt-1', reason: 'keyword',
    });
    expect(ok).toBe(true);
    expect(fake.rows('recipient_opt_outs')[0]!['workspace_id']).toBe(WS_A);

    fake.replaceRows('recipient_opt_outs', []);
    fake.replaceRows('instagram_accounts', [accountRow({ workspace_id: null })]);
    await recordRecipientOptOut(db, {
      instagramAccountId: 'acct-A', recipientId: 'IG-FAN2', triggerEventId: 'cmt-2', reason: 'keyword',
    });
    expect('workspace_id' in fake.rows('recipient_opt_outs')[0]!).toBe(false);
  });

  it('comment_private_reply_reservations: newly reserved row stamped WS_A', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow()]);
    const res = await reserveCommentPrivateReply(db, 'acct-A', 'cmt-1', 'auto-A');
    expect(res.authorized).toBe(true);
    expect(fake.rows('comment_private_reply_reservations')[0]!['workspace_id']).toBe(WS_A);
  });

  it('comment_traffic_events: rows created by the record RPC are stamped WS_A', async () => {
    fake.setRpcHandler('record_comment_traffic_events', (p, f) => {
      for (const cid of p['p_comment_ids'] as string[]) {
        f.rows('comment_traffic_events').push({
          instagram_account_id: p['p_instagram_account_id'], comment_id: cid,
        });
      }
      return { data: null, error: null };
    });
    fake.replaceRows('instagram_accounts', [accountRow()]);
    await recordAndEvaluateCommentTraffic('acct-A', ['c1', 'c2']);
    expect(fake.rows('comment_traffic_events')).toHaveLength(2);
    for (const row of fake.rows('comment_traffic_events')) {
      expect(row['workspace_id']).toBe(WS_A);
    }
  });

  it('inbound_webhook_events: row created by the admission RPC is stamped WS_A (by IGSID binding)', async () => {
    fake.setRpcHandler('check_and_record_inbound_event', (p, f) => {
      f.rows('inbound_webhook_events').push({
        ig_account_id: p['p_ig_account_id'], event_key: p['p_event_key'], decision: 'admitted',
      });
      return { data: [{ decision: 'admitted', window_count: 1 }], error: null };
    });
    fake.replaceRows('instagram_accounts', [accountRow()]);
    const nowSec = Math.floor(Date.now() / 1000);
    const body: MetaWebhookBody = {
      object: 'instagram',
      entry: [{
        id: 'IG-A', time: nowSec,
        changes: [{
          field: 'comments',
          value: { from: { id: 'IG-FAN' }, media: { id: 'post-1' }, id: 'cmt-1', text: 'LINK', timestamp: nowSec },
        } as never],
      }],
    };
    const result = await admitInboundWebhook(body);
    expect(result.stats.admitted).toBe(1);
    expect(fake.rows('inbound_webhook_events')[0]!['workspace_id']).toBe(WS_A);
  });
});

// ── debugLog conditional stamping (TW-14) ──────────────────────────────────

describe('debug_events stamping is caller-context conditional', () => {
  it('with a derived workspaceId in metadata: row stamped; without: legacy shape', async () => {
    debugLog('worker', 'info', 'p18_probe', 'ok', 'bound event', { workspaceId: WS_A, userId: OWNER_A });
    debugLog('worker', 'info', 'p18_probe', 'ok', 'unbound event', { userId: OWNER_A });
    await flush(60);
    const rows = fake.rows('debug_events');
    expect(rows).toHaveLength(2);
    expect(rows[0]!['workspace_id']).toBe(WS_A);
    expect('workspace_id' in rows[1]!).toBe(false);
  });
});
