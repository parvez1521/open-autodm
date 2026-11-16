/**
 * Story Mention trigger (story_mention) — webhook ingestion
 * (src/lib/automation/processWebhook.ts) with the REAL matcher, opt-out
 * gate, queue and FakeSupabase-backed service client. Only the debug
 * logger is mocked (fire-and-forget side channel).
 *
 * Covers the 2026-11-17 story-mention build:
 *  (a) a story_mention attachment enqueues an auto_dm job with
 *      triggerType 'story_mention' and the story's media ID as postId;
 *  (b) the story ID resolves from payload.id OR payload.media_id OR the
 *      shortcode decoded from payload.url;
 *  (c) type isolation: a mention fires ONLY story_mention automations
 *      (never story_reply), and a story reply fires ONLY story_reply
 *      automations (never story_mention);
 *  (d) specific keywords act as an extra filter on the mention's text;
 *      excluded keywords veto;
 *  (e) a mention with no matching story_mention automation is silently
 *      ignored (no generic reply).
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

const STORY_ID = '17901234567890123';
const STORY_SHORTCODE = encodeInstagramShortcode(STORY_ID);
const STORY_URL = `https://www.instagram.com/stories/IG-FAN/${STORY_SHORTCODE}/`;

function mentionAutomation(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-mention',
    instagram_account_id: 'acct-1',
    type: 'story_mention',
    is_active: true,
    is_traffic_guard_paused: false,
    post_id: null,
    keywords: ['*ANY*'],
    trigger_config: null,
    flow_graph: null,
    ...overrides,
  };
}

function storyReplyAutomation(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-story-reply',
    instagram_account_id: 'acct-1',
    type: 'story_reply',
    is_active: true,
    is_traffic_guard_paused: false,
    post_id: null,
    keywords: ['*ANY*'],
    trigger_config: null,
    flow_graph: null,
    ...overrides,
  };
}

function mentionBody(
  attachment: { type: string; payload?: Record<string, string> },
  text?: string,
  mid = 'mid-mention-1',
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
              ...(text ? { text } : {}),
              attachments: [attachment],
            },
          },
        ],
      },
    ],
  };
}

function storyReplyBody(mid = 'mid-reply-1', fromId = 'IG-FAN'): MetaWebhookBody {
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
              text: 'Love this!',
              reply_to: { story: { id: STORY_ID, url: STORY_URL } },
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
  fake.replaceRows('pending_lead_captures', []);
});

describe('story mention → story_mention automation', () => {
  it('a story_mention with payload.id enqueues an auto_dm job with triggerType story_mention', async () => {
    fake.seed('automations', [mentionAutomation()]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { id: STORY_ID } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedJobs()).toHaveLength(1);
    const payload = queuedPayloads()[0]!;
    expect(payload.triggerType).toBe('story_mention');
    expect(payload.automationId).toBe('auto-mention');
    expect(payload.postId).toBe(STORY_ID);
    expect(payload.triggerUserId).toBe('IG-FAN');
  });

  it('the story ID resolves from payload.media_id when id is absent', async () => {
    fake.seed('automations', [mentionAutomation()]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { media_id: STORY_ID } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedPayloads()[0]!.postId).toBe(STORY_ID);
  });

  it('the story ID resolves from the shortcode decoded from payload.url when no id is present', async () => {
    fake.seed('automations', [mentionAutomation()]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { url: STORY_URL } }),
    );
    expect(enqueued).toBe(1);
    expect(queuedPayloads()[0]!.postId).toBe(STORY_ID);
  });

  it('a mention never fires a story_reply automation', async () => {
    fake.seed('automations', [storyReplyAutomation()]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { id: STORY_ID } }),
    );
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });

  it('a story reply never fires a story_mention automation', async () => {
    fake.seed('automations', [mentionAutomation()]);
    const enqueued = await processWebhookPayload(storyReplyBody());
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });

  it('specific keywords filter on the mention text — non-matching text is ignored', async () => {
    fake.seed('automations', [mentionAutomation({ keywords: ['GUIDE'] })]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { id: STORY_ID } }, 'just saying hi'),
    );
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });

  it('specific keywords filter on the mention text — matching text enqueues', async () => {
    fake.seed('automations', [mentionAutomation({ keywords: ['GUIDE'] })]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { id: STORY_ID } }, 'sending GUIDE your way'),
    );
    expect(enqueued).toBe(1);
    expect(queuedPayloads()[0]!.triggerType).toBe('story_mention');
  });

  it('an excluded keyword vetoes the mention', async () => {
    fake.seed('automations', [
      mentionAutomation({ trigger_config: { excluded_keywords: ['SPAM'] } }),
    ]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { id: STORY_ID } }, 'SPAM SPAM'),
    );
    expect(enqueued).toBe(0);
    expect(queuedJobs()).toHaveLength(0);
  });

  it('a mention with no story_mention automation is silently ignored', async () => {
    fake.seed('automations', [storyReplyAutomation()]);
    const enqueued = await processWebhookPayload(
      mentionBody({ type: 'story_mention', payload: { id: STORY_ID } }),
    );
    expect(enqueued).toBe(0);
  });
});
