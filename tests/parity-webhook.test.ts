/**
 * Phase 5 parity — webhook ingestion (src/lib/automation/processWebhook.ts)
 * with the REAL matcher, opt-out gate, queue and FakeSupabase-backed service
 * client. Only the debug logger is mocked (fire-and-forget side channel).
 *
 * Covers: (a) empty/null keywords never trigger, (b) wildcard fires ONLY
 * with an explicit opt-in, (i) duplicate deliveries dedupe, (j) excluded
 * keywords veto, plus the ingestion-side suppression gate and the
 * account-level Traffic Guard pause.
 *
 * NOTE on (i): job dedupe rests on the job_queue.dedupe_key UNIQUE
 * constraint in Postgres. The fake has no unique index, so — exactly as
 * queue-idempotency.test.ts does — the second delivery's constraint
 * violation (23505) is injected to prove the webhook→queue path treats it
 * as "already queued" and creates no second job.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import type { MetaWebhookBody } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import { processWebhookPayload } from '@/lib/automation/processWebhook';

void (fake as unknown as SupabaseClient); // type parity with other suites

const ACCOUNT: FakeRow = {
  id: 'acct-1',
  instagram_user_id: 'IG-OWNER',
  user_id: 'user-1',
  is_active: true,
  traffic_guard_paused: false,
};

function automation(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-1',
    instagram_account_id: 'acct-1',
    type: 'comment_dm',
    is_active: true,
    is_traffic_guard_paused: false,
    post_id: null,
    keywords: ['LINK'],
    trigger_config: null,
    flow_graph: null,
    ...overrides,
  };
}

function commentBody(text: string, commentId = 'cmt-1', fromId = 'IG-FAN'): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: 'IG-OWNER',
        time: nowSec,
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: fromId, username: 'fan' },
              media: { id: 'post-1' },
              id: commentId,
              text,
              timestamp: nowSec,
            },
          },
        ],
      },
    ],
  };
}

function dmBody(text: string, mid = 'mid-1', fromId = 'IG-FAN'): MetaWebhookBody {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'IG-OWNER',
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: fromId },
            recipient: { id: 'IG-OWNER' },
            timestamp: Date.now(),
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [{ ...ACCOUNT }]);
  fake.replaceRows('automations', []);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('automation_follow_ups', []);
});

describe('(a) hardened keyword gate at webhook ingestion', () => {
  it('empty keyword list does NOT trigger a comment automation', async () => {
    fake.seed('automations', [automation({ keywords: [] })]);
    const enqueued = await processWebhookPayload(commentBody('LINK'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('null keywords do NOT trigger a comment automation', async () => {
    fake.seed('automations', [automation({ keywords: null })]);
    const enqueued = await processWebhookPayload(commentBody('LINK'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('null keywords do NOT trigger a DM automation', async () => {
    fake.seed('automations', [
      automation({ type: 'dm_reply', keywords: null }),
    ]);
    const enqueued = await processWebhookPayload(dmBody('hello there'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('comment matching is exact-standalone: "send LINK please" does not fire a LINK funnel', async () => {
    fake.seed('automations', [automation()]);
    expect(await processWebhookPayload(commentBody('send LINK please'))).toBe(0);
    expect(await processWebhookPayload(commentBody('LINK'))).toBe(1);
  });
});

describe('(b) wildcard fires ONLY with intentional configuration', () => {
  it('an explicit *ANY* keyword token opts the automation into any-comment mode', async () => {
    fake.seed('automations', [automation({ keywords: ['*ANY*'] })]);
    const enqueued = await processWebhookPayload(commentBody('totally unrelated words'));
    expect(enqueued).toBe(1);
    expect(fake.rows('job_queue')).toHaveLength(1);
  });

  it('trigger_config trigger_mode="any" opts in even with null keywords', async () => {
    fake.seed('automations', [
      automation({ keywords: null, trigger_config: { trigger_mode: 'any' } }),
    ]);
    const enqueued = await processWebhookPayload(commentBody('anything at all'));
    expect(enqueued).toBe(1);
  });

  it('trigger_config keywords_any_mode=true opts a DM automation in', async () => {
    fake.seed('automations', [
      automation({ type: 'dm_reply', keywords: null, trigger_config: { keywords_any_mode: true } }),
    ]);
    const enqueued = await processWebhookPayload(dmBody('random hello'));
    expect(enqueued).toBe(1);
  });

  it('a non-opt-in trigger_config does NOT create wildcard behaviour', async () => {
    fake.seed('automations', [
      automation({ keywords: null, trigger_config: { trigger_mode: 'keyword' } }),
    ]);
    const enqueued = await processWebhookPayload(commentBody('anything at all'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });
});

describe('(j) excluded keywords veto', () => {
  it('a comment matching an excluded keyword is vetoed even when the trigger matches', async () => {
    fake.seed('automations', [
      automation({ trigger_config: { excluded_keywords: ['link'] } }),
    ]);
    const enqueued = await processWebhookPayload(commentBody('LINK'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('a non-matching excluded list does not block a genuine trigger (control)', async () => {
    fake.seed('automations', [
      automation({ trigger_config: { excluded_keywords: ['spamword'] } }),
    ]);
    const enqueued = await processWebhookPayload(commentBody('LINK'));
    expect(enqueued).toBe(1);
  });
});

describe('(i) duplicate webhook deliveries', () => {
  it('the same comment delivered twice enqueues exactly one job (dedupe_key 23505 path)', async () => {
    fake.seed('automations', [automation()]);
    const first = await processWebhookPayload(commentBody('LINK', 'cmt-dup'));
    expect(first).toBe(1);
    expect(fake.rows('job_queue')).toHaveLength(1);
    expect(fake.rows('job_queue')[0]!['dedupe_key']).toBe('event_auto-1_cmt-dup');

    // Meta retries the delivery; Postgres rejects the second insert on the
    // dedupe_key UNIQUE constraint — simulated as in queue-idempotency.
    fake.failNextInsert('job_queue', {
      message: 'duplicate key value violates unique constraint "job_queue_dedupe_key_key"',
      code: '23505',
    });
    const second = await processWebhookPayload(commentBody('LINK', 'cmt-dup'));
    expect(second).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(1);
  });
});

describe('ingestion-side suppression + Traffic Guard', () => {
  it('an opted-out commenter enqueues nothing', async () => {
    fake.seed('recipient_opt_outs', [
      { id: 'oo-1', instagram_account_id: 'acct-1', recipient_id: 'IG-FAN' },
    ]);
    fake.seed('automations', [automation()]);
    const enqueued = await processWebhookPayload(commentBody('LINK'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('a FAILED suppression lookup at ingestion fails closed (nothing enqueued)', async () => {
    fake.setRpcHandler('is_recipient_suppressed', async () => ({
      data: null,
      error: { message: 'rpc unavailable' },
    }));
    fake.failNextQuery('recipient_opt_outs', { message: 'connection reset' });
    fake.seed('automations', [automation()]);
    const enqueued = await processWebhookPayload(commentBody('LINK'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('an account paused by Traffic Guard dispatches no comment automations', async () => {
    fake.replaceRows('instagram_accounts', [{ ...ACCOUNT, traffic_guard_paused: true }]);
    fake.seed('automations', [automation()]);
    const enqueued = await processWebhookPayload(commentBody('LINK'));
    expect(enqueued).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });
});
