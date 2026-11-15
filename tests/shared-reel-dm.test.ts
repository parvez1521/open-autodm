/**
 * Shared-Reel DM trigger (reel_dm) — webhook ingestion
 * (src/lib/automation/processWebhook.ts) with the REAL matcher, opt-out
 * gate, queue and FakeSupabase-backed service client. Only the debug
 * logger is mocked (fire-and-forget side channel).
 *
 * Covers the 2026-11-15 reel_dm build:
 *  (a) a shared Reel matching a reel_dm automation's post_id enqueues
 *      an auto_dm job with triggerType 'reel_dm';
 *  (b) the shared Reel's media ID resolves from payload.id OR
 *      payload.reel_video_id OR the shortcode decoded from payload.url
 *      — Meta does not reliably send `id`, so the reel_video_id-only
 *      and permalink-only variants are the regression tests for the
 *      2026-11-15 resolveSharedReelId fix (with `id` alone, both would
 *      silently match nothing);
 *  (c) an unmapped Reel (no automation for that post_id) is silently
 *      ignored — one reply per user per automation, no generic reply;
 *  (d) specific keywords on a reel_dm automation act as an extra
 *      filter on the share's text/title.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import type { MetaWebhookBody, AutoDmJobPayload } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encodeInstagramShortcode } from '@/lib/instagram/postUrl';

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

// A realistic numeric IG media ID (17 digits — beyond MAX_SAFE_INTEGER,
// which is why the shortcode round-trip uses BigInt).
const REEL_ID = '17895695668004541';
const OTHER_REEL_ID = '17912345678901234';
const REEL_SHORTCODE = encodeInstagramShortcode(REEL_ID);
const REEL_URL = `https://www.instagram.com/reel/${REEL_SHORTCODE}/`;

function reelAutomation(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-reel',
    instagram_account_id: 'acct-1',
    type: 'reel_dm',
    is_active: true,
    is_traffic_guard_paused: false,
    post_id: REEL_ID,
    keywords: null,
    trigger_config: null,
    flow_graph: null,
    ...overrides,
  };
}

function sharedReelBody(
  attachment: { type: string; payload?: Record<string, string> },
  mid = 'mid-reel-1',
  fromId = 'IG-FAN',
): MetaWebhookBody {
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
            message: {
              mid,
              attachments: [attachment],
            },
          },
        ],
      },
    ],
  };
}

function queuedJobs(): Array<Record<string, unknown>> {
  return fake.rows('job_queue') as Array<Record<string, unknown>>;
}

function queuedPayloads(): AutoDmJobPayload[] {
  return queuedJobs().map((row) => row['payload'] as AutoDmJobPayload);
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

describe('shared Reel → reel_dm automation', () => {
  it('an ig_reel share with payload.id matching the automation enqueues an auto_dm job', async () => {
    fake.seed('automations', [reelAutomation()]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { id: REEL_ID, url: REEL_URL, title: 'My reel' } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedJobs()).toHaveLength(1);
    const job = queuedJobs()[0]!;
    expect(job['job_type']).toBe('auto_dm');
    expect(job['dedupe_key']).toBe('event_auto-reel_mid-reel-1');
    const payload = queuedPayloads()[0]!;
    expect(payload.triggerType).toBe('reel_dm');
    expect(payload.automationId).toBe('auto-reel');
    expect(payload.postId).toBe(REEL_ID);
    expect(payload.sharedReelId).toBe(REEL_ID);
    expect(payload.sharedReelUrl).toBe(REEL_URL);
    expect(payload.triggerUserId).toBe('IG-FAN');
  });

  it('a reel_video_id-only delivery (no payload.id) still matches the automation', async () => {
    fake.seed('automations', [reelAutomation()]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { reel_video_id: REEL_ID, url: REEL_URL, title: 'My reel' } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedPayloads()[0]!.sharedReelId).toBe(REEL_ID);
    expect(queuedPayloads()[0]!.triggerType).toBe('reel_dm');
  });

  it('a permalink-only delivery (no id at all) resolves via the shortcode', async () => {
    expect(REEL_SHORTCODE.length).toBeGreaterThan(0);
    fake.seed('automations', [reelAutomation()]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { url: REEL_URL } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedPayloads()[0]!.sharedReelId).toBe(REEL_ID);
  });

  it('a "share"-type attachment corroborated by a /reel/ URL also triggers', async () => {
    fake.seed('automations', [reelAutomation()]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'share', payload: { id: REEL_ID, url: REEL_URL, title: 'Reel' } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedPayloads()[0]!.triggerType).toBe('reel_dm');
  });

  it('only the automation for the shared reel fires when several reel_dm automations exist', async () => {
    fake.seed('automations', [
      reelAutomation(),
      reelAutomation({ id: 'auto-reel-2', post_id: OTHER_REEL_ID }),
    ]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { id: REEL_ID, url: REEL_URL, title: 'My reel' } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedJobs()).toHaveLength(1);
    expect(queuedPayloads()[0]!.automationId).toBe('auto-reel');
  });
});

describe('unmapped shares are silently ignored', () => {
  it('a shared Reel with no automation for its post_id enqueues nothing', async () => {
    fake.seed('automations', [reelAutomation()]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { id: OTHER_REEL_ID, url: 'https://www.instagram.com/reel/AAAAAAA/', title: 'Someone else' } }),
    );
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });

  it('a shared Reel with no reel_dm automations at all enqueues nothing', async () => {
    fake.seed('automations', []);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { id: REEL_ID, url: REEL_URL, title: 'My reel' } }),
    );
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });

  it('an inactive reel_dm automation does not fire', async () => {
    fake.seed('automations', [reelAutomation({ is_active: false })]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { id: REEL_ID, url: REEL_URL, title: 'My reel' } }),
    );
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });
});

describe('keyword filter on reel_dm automations', () => {
  it('specific keywords veto a share whose text/title does not match', async () => {
    fake.seed('automations', [reelAutomation({ keywords: ['GUIDE'] })]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { id: REEL_ID, url: REEL_URL, title: 'Just a dance reel' } }),
    );
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });

  it('a share whose title matches the keyword fires', async () => {
    fake.seed('automations', [reelAutomation({ keywords: ['GUIDE'] })]);
    const enqueued = await processWebhookPayload(
      sharedReelBody({ type: 'ig_reel', payload: { id: REEL_ID, url: REEL_URL, title: 'My GUIDE to reels' } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedJobs()).toHaveLength(1);
  });
});
