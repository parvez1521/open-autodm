/**
 * Phase 10.4 Workstream C (S-07) — inbound webhook admission control
 * (src/lib/automation/inboundRateLimit.ts).
 *
 * The limiter store is the FakeSupabase RPC `check_and_record_inbound_event`
 * with a handler that mirrors migration 20260730000022's SQL semantics
 * (window cleanup → existing-row classification → admitted-count check →
 * insert). The SQL itself is rehearsed against real PostgreSQL in the
 * Phase 10.4 migration rehearsal; here the TypeScript composition —
 * keying, classification, filtering, fail-open — is under test.
 *
 * Covered: bursty legitimate traffic passes; duplicates deduped and never
 * counted against the limit; one abusive account throttled while a second
 * is unaffected; shed events recorded and idempotent on retry; limiter-
 * store failure fails open; a Meta retry storm yields a single job when
 * admission feeds the real processWebhookPayload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import type { MetaWebhookBody } from '@/lib/types';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import {
  admitInboundWebhook,
  extractActionableEvents,
  INBOUND_LIMIT_PER_HOUR,
  INBOUND_WINDOW_SECONDS,
  type InboundEventStore,
} from '@/lib/automation/inboundRateLimit';
import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { debugLog } from '@/lib/debugLog';

const mockDebugLog = vi.mocked(debugLog);

let rpcCalls = 0;

/** Mirrors 20260730000022's check_and_record_inbound_event semantics. */
function installRpcHandler(): void {
  fake.setRpcHandler('check_and_record_inbound_event', async (params, f) => {
    rpcCalls += 1;
    const acct = params['p_ig_account_id'] as string;
    const key = params['p_event_key'] as string;
    const limit = params['p_limit'] as number;
    const windowMs = (params['p_window_seconds'] as number) * 1000;
    const cutoff = Date.now() - windowMs;
    // Opportunistic window cleanup for this account (as the SQL does).
    f.replaceRows(
      'inbound_webhook_events',
      f.rows('inbound_webhook_events').filter(
        (r) => !(r['ig_account_id'] === acct && new Date(r['received_at'] as string).getTime() < cutoff)
      )
    );
    const rows = f.rows('inbound_webhook_events');
    const existing = rows.find((r) => r['ig_account_id'] === acct && r['event_key'] === key);
    const count = rows.filter(
      (r) =>
        r['ig_account_id'] === acct &&
        r['decision'] === 'admitted' &&
        new Date(r['received_at'] as string).getTime() > cutoff
    ).length;
    if (existing) {
      return {
        data: [{ decision: existing['decision'] === 'admitted' ? 'duplicate' : 'shed', window_count: count }],
        error: null,
      };
    }
    if (count >= limit) {
      rows.push({ ig_account_id: acct, event_key: key, decision: 'shed', received_at: new Date().toISOString() });
      return { data: [{ decision: 'shed', window_count: count }], error: null };
    }
    rows.push({ ig_account_id: acct, event_key: key, decision: 'admitted', received_at: new Date().toISOString() });
    return { data: [{ decision: 'admitted', window_count: count + 1 }], error: null };
  });
}

function commentBody(commentIds: string[], account = 'IG-OWNER'): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: account,
        time: nowSec,
        changes: commentIds.map((id) => ({
          field: 'comments',
          value: {
            from: { id: 'IG-FAN', username: 'fan' },
            media: { id: 'post-1' },
            id,
            text: 'LINK',
            timestamp: nowSec,
          },
        })),
      },
    ],
  };
}

function dmBody(mid: string, account = 'IG-OWNER'): MetaWebhookBody {
  return {
    object: 'instagram',
    entry: [
      {
        id: account,
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: 'IG-FAN' },
            recipient: { id: account },
            timestamp: Date.now(),
            message: { mid, text: 'hello' },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('inbound_webhook_events', []);
  fake.replaceRows('instagram_accounts', []);
  fake.replaceRows('automations', []);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('automation_follow_ups', []);
  rpcCalls = 0;
  installRpcHandler();
  mockDebugLog.mockClear();
});

describe('proposed-default thresholds (single documented place)', () => {
  it('pins the owner-approval-pending constants', () => {
    expect(INBOUND_LIMIT_PER_HOUR).toBe(3600);
    expect(INBOUND_WINDOW_SECONDS).toBe(3600);
  });
});

describe('bursty legitimate traffic', () => {
  it('admits a 50-event burst in one delivery, untouched body', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `cmt-burst-${i}`);
    const body = commentBody(ids);
    const result = await admitInboundWebhook(body, { limit: 100 });
    expect(result.stats.admitted).toBe(50);
    expect(result.stats.duplicates).toBe(0);
    expect(result.stats.shed).toBe(0);
    expect(result.stats.failOpen).toBe(false);
    expect(result.body).toBe(body); // nothing removed → original reference
  });

  it('extracts comment + DM identities and ignores receipts/echoes/other fields', () => {
    const body = dmBody('mid-1');
    body.entry[0]!.messaging!.push(
      { sender: { id: 'IG-FAN' }, recipient: { id: 'IG-OWNER' }, timestamp: Date.now(), read: { watermark: 1 } },
      {
        sender: { id: 'IG-OWNER' },
        recipient: { id: 'IG-FAN' },
        timestamp: Date.now(),
        message: { mid: 'mid-echo', text: 'ours', is_echo: true },
      }
    );
    body.entry[0]!.changes = [
      { field: 'mentions', value: { from: { id: 'IG-FAN' }, media: { id: 'p' }, id: 'm-1', text: 'x' } },
    ];
    const events = extractActionableEvents(body);
    expect(events.map((e) => e.eventKey)).toEqual(['mid:mid-1']);
  });
});

describe('duplicates are deduped, never throttled', () => {
  it('repeated deliveries of one event consume exactly one quota slot', async () => {
    const opts = { limit: 3 };
    const first = await admitInboundWebhook(commentBody(['cmt-1']), opts);
    expect(first.stats.admitted).toBe(1);

    for (let i = 0; i < 4; i++) {
      const retry = await admitInboundWebhook(commentBody(['cmt-1']), opts);
      expect(retry.stats.duplicates).toBe(1);
      expect(retry.stats.shed).toBe(0);
      expect(retry.body).toBeNull(); // nothing new to process
    }

    // The 4 retries did not touch the quota: two more distinct events fit.
    const more = await admitInboundWebhook(commentBody(['cmt-2', 'cmt-3']), opts);
    expect(more.stats.admitted).toBe(2);
    // …and only NOW is the account at its limit.
    const over = await admitInboundWebhook(commentBody(['cmt-4']), opts);
    expect(over.stats.shed).toBe(1);
  });
});

describe('excessive valid traffic is shed per-account', () => {
  it('throttles the flooding account while a second account is unaffected', async () => {
    const opts = { limit: 2 };
    const flood = await admitInboundWebhook(
      commentBody(['a-1', 'a-2', 'a-3', 'a-4'], 'IG-ABUSIVE'),
      opts
    );
    expect(flood.stats.admitted).toBe(2);
    expect(flood.stats.shed).toBe(2);
    expect(flood.stats.shedByAccount).toEqual({ 'IG-ABUSIVE': 2 });
    // The filtered body carries exactly the admitted events.
    expect(flood.body?.entry[0]?.changes?.map((c) => c.value.id)).toEqual(['a-1', 'a-2']);
    // Shed events are RECORDED (metadata only), not silently dropped.
    const shedRows = fake
      .rows('inbound_webhook_events')
      .filter((r) => r['ig_account_id'] === 'IG-ABUSIVE' && r['decision'] === 'shed');
    expect(shedRows.map((r) => r['event_key'])).toEqual(['comment:a-3', 'comment:a-4']);
    // …and surfaced as a counts-only debug event.
    expect(mockDebugLog).toHaveBeenCalledWith(
      'webhook',
      'warn',
      'inbound_rate_limit_shed',
      'skipped',
      expect.stringContaining('shed 2'),
      expect.objectContaining({ igAccountId: 'IG-ABUSIVE', shedCount: 2 })
    );

    const other = await admitInboundWebhook(commentBody(['b-1', 'b-2'], 'IG-OTHER'), opts);
    expect(other.stats.admitted).toBe(2);
    expect(other.stats.shed).toBe(0);
  });

  it('a retry of a shed event stays shed (idempotent shed, no quota change)', async () => {
    const opts = { limit: 1 };
    await admitInboundWebhook(commentBody(['x-1']), opts);
    const shed1 = await admitInboundWebhook(commentBody(['x-2']), opts);
    expect(shed1.stats.shed).toBe(1);
    const shed2 = await admitInboundWebhook(commentBody(['x-2']), opts);
    expect(shed2.stats.shed).toBe(1);
    expect(shed2.stats.duplicates).toBe(0);
    expect(
      fake.rows('inbound_webhook_events').filter((r) => r['decision'] === 'admitted')
    ).toHaveLength(1);
  });
});

describe('limiter-store failure fails OPEN on the throttle only', () => {
  it('RPC error → original body admitted unfiltered, failOpen flagged, one error log', async () => {
    fake.setRpcHandler('check_and_record_inbound_event', async () => ({
      data: null,
      error: { message: 'function does not exist (migration not applied)' },
    }));
    const body = commentBody(['c-1', 'c-2', 'c-3']);
    const result = await admitInboundWebhook(body, { limit: 1 });
    expect(result.stats.failOpen).toBe(true);
    expect(result.body).toBe(body);
    expect(mockDebugLog).toHaveBeenCalledWith(
      'webhook',
      'error',
      'inbound_rate_limit_error',
      'error',
      expect.stringContaining('failing open'),
      expect.anything()
    );
  });

  it('a throwing custom store also fails open and never throws to the caller', async () => {
    const throwingStore: InboundEventStore = {
      checkAndRecord: async () => {
        throw new Error('connection reset');
      },
    };
    const body = dmBody('mid-failopen');
    await expect(admitInboundWebhook(body, { store: throwingStore })).resolves.toMatchObject({
      stats: { failOpen: true },
    });
  });
});

describe('retry storm → single job (admission + real processWebhookPayload)', () => {
  const ACCOUNT: FakeRow = {
    id: 'acct-1',
    instagram_user_id: 'IG-OWNER',
    user_id: 'user-1',
    is_active: true,
    traffic_guard_paused: false,
  };

  it('the same comment delivered 5 times enqueues exactly one job', async () => {
    fake.replaceRows('instagram_accounts', [{ ...ACCOUNT }]);
    fake.seed('automations', [
      {
        id: 'auto-1',
        instagram_account_id: 'acct-1',
        type: 'comment_dm',
        is_active: true,
        is_traffic_guard_paused: false,
        post_id: null,
        keywords: ['LINK'],
        trigger_config: null,
        flow_graph: null,
      },
    ]);

    let totalEnqueued = 0;
    for (let i = 0; i < 5; i++) {
      const admission = await admitInboundWebhook(commentBody(['cmt-storm']));
      if (admission.body) {
        totalEnqueued += await processWebhookPayload(admission.body);
      }
    }
    expect(totalEnqueued).toBe(1);
    expect(fake.rows('job_queue')).toHaveLength(1);
    expect(fake.rows('job_queue')[0]!['dedupe_key']).toBe('event_auto-1_cmt-storm');
  });
});

describe('pass-through behaviour', () => {
  it('non-instagram objects and receipt-only bodies never touch the store', async () => {
    const pageBody = { object: 'page', entry: [] } as unknown as MetaWebhookBody;
    const r1 = await admitInboundWebhook(pageBody);
    expect(r1.body).toBe(pageBody);

    const receiptOnly = dmBody('unused');
    receiptOnly.entry[0]!.messaging = [
      { sender: { id: 'IG-FAN' }, recipient: { id: 'IG-OWNER' }, timestamp: Date.now(), read: { watermark: 7 } },
    ];
    const r2 = await admitInboundWebhook(receiptOnly);
    expect(r2.body).toBe(receiptOnly);
    expect(r2.stats.passthrough).toBe(1);
    expect(rpcCalls).toBe(0);
  });
});
