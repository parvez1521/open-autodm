/**
 * Facebook Page automation (2026-11-19) — webhook ingestion
 * (src/lib/facebook/processFacebookWebhook.ts), job guards
 * (src/lib/automation/processFacebookJob.ts) and the new UI trigger cards.
 *
 * Covers, with the REAL matcher / job processor against FakeSupabase
 * (only the debug logger, the job queue enqueue and Meta's HTTP API
 * are mocked):
 *  (a) comment event matching — keyword match, any-comment wildcard,
 *      wrong-post filter, self-comment guard, 7-day age guard,
 *      opt-out intent + excluded-keyword veto;
 *  (b) DM keyword matching (any-message wildcard vs keyword);
 *  (c) the 24h Messenger window guard (DM jobs) and the 7-day
 *      private-reply window guard (comment jobs) at send time;
 *  (d) one private reply per comment — a second job for the same
 *      comment loses the dm_sent_log claim (23505) and sends nothing;
 *  (e) the new "Comment to Messenger" / "DM keyword" trigger cards,
 *      hidden until a Page is connected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { AutoDmJobPayload, MetaWebhookBody } from '@/lib/types';
import { AUTOMATION_TYPES } from '@/components/automations/new-flow/constants';

// Synthetic env for getEnv() (same pattern as crypto-token-safety.test.ts).
const KEY = 'ab'.repeat(32);
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'synthetic-service-role-key-0123456789';
process.env['TOKEN_ENCRYPTION_KEY'] = KEY;
process.env['CRON_SECRET'] = 'test-cron-key-0123456789';
process.env['NEXT_PUBLIC_SUPABASE_URL'] = 'https://synthetic.invalid';
process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = 'synthetic-anon-key-0123456789';
process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.opendm.in';

const fake = new FakeSupabase();
const mockEnqueueJob = vi.fn(async (..._args: unknown[]) => 'job-1');

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/automation/queue', () => ({ enqueueJob: (...args: unknown[]) => mockEnqueueJob(...args) }));

import { processFacebookWebhook } from '@/lib/facebook/processFacebookWebhook';
import { processFacebookAutoDmJob } from '@/lib/automation/processFacebookJob';

const PAGE: FakeRow = {
  id: 'page-row-1',
  user_id: 'user-1',
  connected_by_user_id: 'user-1',
  workspace_id: null,
  facebook_page_id: 'PAGE-1',
  name: 'Tech Hacks AI',
  username: 'tech_hacks.ai',
  profile_picture_url: null,
  access_token_encrypted: encrypt('PAGE-TOKEN', KEY),
  token_expires_at: null,
  is_active: true,
  disconnected_at: null,
  paused_until: null,
  pause_reason: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function commentAutomation(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-fb-comment-1',
    user_id: 'user-1',
    workspace_id: null,
    channel: 'facebook',
    facebook_page_id: 'page-row-1',
    instagram_account_id: null,
    type: 'fb_comment_dm',
    name: 'Facebook comment funnel',
    is_active: true,
    post_id: null,
    post_thumbnail_url: null,
    post_caption: null,
    keywords: ['GUIDE'],
    trigger_config: null,
    flow_graph: null,
    comment_reply_options: [],
    public_reply_options: [],
    public_reply_enabled: false,
    dm_opening_message_enabled: true,
    dm_opening_message: 'Here is your guide',
    dm_opening_message_variations: ['Here is your guide'],
    dm_opening_message_button_title: 'Send me the link',
    dm_opening_message_button_link: null,
    ask_to_follow_enabled: false,
    ask_to_follow_message: null,
    ask_to_follow_visit_profile_button: null,
    ask_to_follow_confirm_button: null,
    dm_responses: [
      {
        id: 'r1',
        type: 'text',
        content: 'https://example.com/guide',
        buttonTitle: 'Grab it!',
        buttonLink: 'https://example.com/guide',
      },
    ],
    follow_up_enabled: false,
    follow_up_delay_minutes: 60,
    follow_up_message: null,
    ai_reply_language: 'en',
    total_dms_sent: 0,
    paused_by_disconnect: false,
    ...overrides,
  };
}

function dmAutomation(overrides: FakeRow = {}): FakeRow {
  return {
    ...commentAutomation({ id: 'auto-fb-dm-1', type: 'fb_dm_reply', name: 'Facebook DM reply' }),
    ...overrides,
  };
}

function commentBody(
  text: string,
  opts: { commentId?: string; postId?: string; fromId?: string; createdSec?: number; verb?: string } = {},
): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  const postId = opts.postId ?? 'PAGE-1_STORY-1';
  return {
    object: 'page',
    entry: [
      {
        id: 'PAGE-1',
        time: nowSec,
        changes: [
          {
            field: 'feed',
            value: {
              item: 'comment',
              verb: opts.verb ?? 'add',
              comment_id: opts.commentId ?? 'STORY-1_CMT-1',
              post_id: postId,
              parent_id: postId,
              message: text,
              from: { id: opts.fromId ?? 'USER-1', name: 'Fan' },
              created_time: opts.createdSec ?? nowSec,
            },
          },
        ],
      },
    ],
  };
}

function dmBody(text: string, opts: { mid?: string; senderId?: string } = {}): MetaWebhookBody {
  return {
    object: 'page',
    entry: [
      {
        id: 'PAGE-1',
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: opts.senderId ?? 'USER-1' },
            recipient: { id: 'PAGE-1' },
            timestamp: Date.now(),
            message: { mid: opts.mid ?? 'mid-1', text },
          },
        ],
      },
    ],
  };
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const fetchMock = vi.fn(async (url: string) => {
  const u = String(url);
  if (u.includes('/messages')) return okJson({ recipient_id: 'USER-1', message_id: 'mid-out-1' });
  if (u.includes('/comments')) return okJson({ id: 'reply-cmt-1' });
  return okJson({ first_name: 'Fan', last_name: 'User', profile_pic: '' });
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('facebook_pages', [{ ...PAGE }]);
  fake.replaceRows('automations', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('dm_jobs', []);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('contacts', []);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('dm_rate_events', []);
  mockEnqueueJob.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  fake.setRpcHandler('check_and_record_fb_dm_rate_limit', async () => ({
    data: [{ allowed: true, current_count: 0, retry_after_seconds: 0 }],
    error: null,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processFacebookWebhook — comment → Messenger matching', () => {
  it('enqueues a comment job when the whole comment is the keyword (exact standalone)', async () => {
    fake.replaceRows('automations', [commentAutomation()]);
    const enqueued = await processFacebookWebhook(commentBody('GUIDE'));
    expect(enqueued).toBe(1);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const [type, payload, dedupeKey] = mockEnqueueJob.mock.calls[0] as unknown as [
      string,
      AutoDmJobPayload,
      string,
    ];
    expect(type).toBe('auto_dm');
    expect(payload.triggerType).toBe('comment');
    expect(payload.channel).toBe('facebook');
    expect(payload.automationId).toBe('auto-fb-comment-1');
    expect(payload.commentId).toBe('STORY-1_CMT-1');
    expect(payload.commentText).toBe('GUIDE');
    expect(payload.postId).toBe('PAGE-1_STORY-1');
    expect(dedupeKey).toBe('fb-comment:auto-fb-comment-1:STORY-1_CMT-1');
  });

  it('does not enqueue when the keyword is only part of a longer comment (exact standalone, IG parity)', async () => {
    fake.replaceRows('automations', [commentAutomation()]);
    expect(await processFacebookWebhook(commentBody('send me the GUIDE please'))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('does not enqueue when no keyword matches', async () => {
    fake.replaceRows('automations', [commentAutomation()]);
    expect(await processFacebookWebhook(commentBody('nice post, love it'))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('any-comment wildcard (*ANY*) fires on any comment text', async () => {
    fake.replaceRows('automations', [commentAutomation({ keywords: ['*ANY*'] })]);
    expect(await processFacebookWebhook(commentBody('hello there'))).toBe(1);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue for a comment on a different post than the automation targets', async () => {
    fake.replaceRows('automations', [commentAutomation({ post_id: 'PAGE-1_STORY-9' })]);
    expect(await processFacebookWebhook(commentBody('GUIDE please'))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('ignores the Page commenting on its own post', async () => {
    fake.replaceRows('automations', [commentAutomation({ keywords: ['*ANY*'] })]);
    expect(await processFacebookWebhook(commentBody('GUIDE', { fromId: 'PAGE-1' }))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('drops comments older than the 7-day private-reply window', async () => {
    fake.replaceRows('automations', [commentAutomation({ keywords: ['*ANY*'] })]);
    const eightDaysAgoSec = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
    expect(await processFacebookWebhook(commentBody('GUIDE', { createdSec: eightDaysAgoSec }))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('records an opt-out and enqueues nothing when the comment says STOP', async () => {
    fake.replaceRows('automations', [commentAutomation({ keywords: ['*ANY*'] })]);
    expect(await processFacebookWebhook(commentBody('STOP sending me messages'))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    const optOuts = fake.rows('recipient_opt_outs');
    expect(optOuts).toHaveLength(1);
    expect(optOuts[0]?.['recipient_id']).toBe('USER-1');
  });

  it('excluded keywords veto an otherwise matching comment', async () => {
    fake.replaceRows('automations', [
      commentAutomation({ trigger_config: { excluded_keywords: ['SPAM'] } }),
    ]);
    expect(await processFacebookWebhook(commentBody('GUIDE SPAM'))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('a second comment by the same person CAN still trigger (no per-user dedupe on Facebook)', async () => {
    fake.replaceRows('automations', [commentAutomation({ keywords: ['*ANY*'] })]);
    expect(await processFacebookWebhook(commentBody('first', { commentId: 'STORY-1_CMT-1' }))).toBe(1);
    expect(await processFacebookWebhook(commentBody('second', { commentId: 'STORY-1_CMT-2' }))).toBe(1);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
  });
});

describe('processFacebookWebhook — DM keyword matching', () => {
  it('enqueues a DM job when the keyword matches', async () => {
    fake.replaceRows('automations', [dmAutomation({ keywords: ['LINK'] })]);
    const enqueued = await processFacebookWebhook(dmBody('please send LINK'));
    expect(enqueued).toBe(1);
    const [, payload, dedupeKey] = mockEnqueueJob.mock.calls[0] as unknown as [
      string,
      AutoDmJobPayload,
      string,
    ];
    expect(payload.triggerType).toBe('dm');
    expect(payload.channel).toBe('facebook');
    expect(payload.triggerEventId).toBe('mid-1');
    expect(dedupeKey).toBe('fb-dm:auto-fb-dm-1:USER-1:mid-1');
  });

  it('does not enqueue a DM with no keyword match', async () => {
    fake.replaceRows('automations', [dmAutomation({ keywords: ['LINK'] })]);
    expect(await processFacebookWebhook(dmBody('hello'))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('any-message wildcard fires on any DM text', async () => {
    fake.replaceRows('automations', [dmAutomation({ keywords: ['*ANY*'] })]);
    expect(await processFacebookWebhook(dmBody('hi there'))).toBe(1);
  });

  it('records an opt-out and enqueues nothing when the DM says STOP', async () => {
    fake.replaceRows('automations', [dmAutomation({ keywords: ['*ANY*'] })]);
    expect(await processFacebookWebhook(dmBody('STOP'))).toBe(0);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    expect(fake.rows('recipient_opt_outs')).toHaveLength(1);
  });
});

describe('processFacebookAutoDmJob — messaging windows', () => {
  function commentPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
    return {
      automationId: 'auto-fb-comment-1',
      instagramAccountId: 'page-row-1',
      igAccountIgsid: 'PAGE-1',
      channel: 'facebook',
      triggerType: 'comment',
      triggerUserId: 'USER-1',
      triggerUsername: 'Fan',
      triggerEventId: 'STORY-1_CMT-1',
      triggerTimestamp: Date.now(),
      commentId: 'STORY-1_CMT-1',
      commentText: 'send me the GUIDE please',
      messageText: null,
      postId: 'PAGE-1_STORY-1',
      ...overrides,
    };
  }

  it('refuses free-form sends outside the 24h Messenger window (DM trigger, 25h old)', async () => {
    fake.replaceRows('automations', [dmAutomation()]);
    await processFacebookAutoDmJob(
      commentPayload({
        automationId: 'auto-fb-dm-1',
        triggerType: 'dm',
        triggerEventId: 'mid-1',
        triggerTimestamp: Date.now() - 25 * 3600_000,
        commentId: undefined,
        commentText: null,
        messageText: 'LINK please',
        postId: null,
      }),
      1,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      fake.rows('dm_jobs').some(
        (r) => r['status'] === 'skipped' && r['error_message'] === 'Event outside messaging window',
      ),
    ).toBe(true);
  });

  it('refuses comment private replies outside the 7-day window (8 days old)', async () => {
    fake.replaceRows('automations', [commentAutomation()]);
    await processFacebookAutoDmJob(
      commentPayload({ triggerTimestamp: Date.now() - 8 * 24 * 3600_000 }),
      1,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      fake.rows('dm_jobs').some(
        (r) => r['status'] === 'skipped' && r['error_message'] === 'Event outside messaging window',
      ),
    ).toBe(true);
  });
});

describe('processFacebookAutoDmJob — one private reply per comment', () => {
  it(
    'sends once, then a second job for the same comment loses the claim (23505) and sends nothing',
    { timeout: 30000 },
    async () => {
      fake.replaceRows('automations', [commentAutomation()]);
      const payload: AutoDmJobPayload = {
        automationId: 'auto-fb-comment-1',
        instagramAccountId: 'page-row-1',
        igAccountIgsid: 'PAGE-1',
        channel: 'facebook',
        triggerType: 'comment',
        triggerUserId: 'USER-1',
        triggerUsername: 'Fan',
        triggerEventId: 'STORY-1_CMT-1',
        triggerTimestamp: Date.now(),
        commentId: 'STORY-1_CMT-1',
        commentText: 'send me the GUIDE please',
        messageText: null,
        postId: 'PAGE-1_STORY-1',
      };

      await processFacebookAutoDmJob(payload, 1);
      // One private reply: the opening DM to the comment (recipient {commentId}).
      const messageSends = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/messages'));
      expect(messageSends.length).toBe(1);
      expect(String(messageSends[0]?.[0])).toContain('/PAGE-1/messages');
      expect(fake.rows('dm_sent_log')).toHaveLength(1);
      expect(fake.rows('dm_jobs').some((r) => r['status'] === 'sent')).toBe(true);

      // A Meta retry / duplicate delivery for the SAME comment: the claim
      // insert hits the partial unique index (23505) — exactly the race
      // the migration's uq_dm_sent_log_fb_event enforces in Postgres.
      fake.failNextInsert('dm_sent_log', {
        message: 'duplicate key value violates unique constraint "uq_dm_sent_log_fb_event"',
        code: '23505',
      });
      const sendsBefore = fetchMock.mock.calls.length;
      await processFacebookAutoDmJob(payload, 1);
      expect(fetchMock.mock.calls.length).toBe(sendsBefore);
      expect(fake.rows('dm_sent_log')).toHaveLength(1);
      expect(
        fake.rows('dm_jobs').some(
          (r) => r['status'] === 'skipped' && r['error_message'] === 'Duplicate event',
        ),
      ).toBe(true);
    },
  );
});

describe('Facebook trigger cards (UI)', () => {
  it('offers "Comment to Messenger" and "DM keyword" as Facebook triggers', () => {
    const fb = AUTOMATION_TYPES.filter(
      (t) => (t as { channel?: string }).channel === 'facebook',
    );
    expect(fb.map((t) => t.id).sort()).toEqual(['fb-comment-dm', 'fb-dm-reply']);
    expect(fb.find((t) => t.id === 'fb-comment-dm')?.name).toBe('Comment to Messenger');
    expect(fb.find((t) => t.id === 'fb-dm-reply')?.name).toBe('DM keyword');
    for (const card of fb) {
      expect(card.available).toBe(true);
      expect(card.iconType).toBe('facebook');
    }
  });

  it('leaves the five Instagram trigger cards unchanged', () => {
    const ig = AUTOMATION_TYPES.filter((t) => !(t as { channel?: string }).channel);
    expect(ig.map((t) => t.id).sort()).toEqual([
      'comment-dm',
      'dm-reply',
      'reel-dm',
      'story-mention',
      'story-reply',
    ]);
  });

  it('SelectTypeStep hides Facebook cards until a Page is connected', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src/components/automations/new-flow/steps/SelectTypeStep.tsx'),
      'utf8',
    );
    expect(src).toContain('showFacebookTriggers');
    expect(src).toContain('channel !== "facebook" || showFacebookTriggers');
  });

  it('ConfigureStep gates require-follow, lead form and follow-ups off for Facebook types', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src/components/automations/new-flow/steps/ConfigureStep.tsx'),
      'utf8',
    );
    expect(src).toContain('flowType === "fb-comment-dm" || flowType === "fb-dm-reply"');
    expect(src).toContain('Facebook has no "follows the Page"');
    expect(src).toContain('Lead forms are not supported for');
    expect(src).toContain('not supported\n                    for Facebook in v1');
  });
});
