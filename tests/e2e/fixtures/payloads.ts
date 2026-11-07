/**
 * Phase 10.3 E2E harness — shared synthetic fixtures.
 *
 * Everything here is SYNTHETIC: fake IGSIDs, fake usernames, and a
 * synthetic AES key (`'e2'.repeat(32)` = 64 hex chars) that exists only
 * inside this test suite. No real account, token, or secret is ever
 * referenced. The factories mirror the row shapes the parity suites use,
 * centralised so every E2E journey starts from the same world.
 */

import { encrypt } from '@/lib/crypto';
import type { FakeRow } from '../../helpers/fakeSupabase';
import type { AutoDmJobPayload, MetaWebhookBody } from '@/lib/types';

/** Synthetic 32-byte AES-256-GCM key (hex) — test-only, never a real key. */
export const E2E_TOKEN_KEY = 'e2'.repeat(32);

export const E2E = {
  accountId: 'acct-e2e',
  ownerUserId: 'user-e2e-owner',
  otherUserId: 'user-e2e-other',
  ownerIgsid: 'IG-E2E-OWNER',
  fanIgsid: 'IG-E2E-FAN',
  fanUsername: 'e2e_fan',
  automationId: 'auto-e2e-1',
  automation2Id: 'auto-e2e-2',
  postId: 'post-e2e-1',
  commentId: 'cmt-e2e-1',
} as const;

/** Instagram account row with the token encrypted at rest (real crypto). */
export function accountRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: E2E.accountId,
    user_id: E2E.ownerUserId,
    instagram_user_id: E2E.ownerIgsid,
    username: 'e2e_creator',
    name: 'E2E Creator',
    is_active: true,
    access_token_encrypted: encrypt('synthetic-long-lived-token', E2E_TOKEN_KEY),
    paused_until: null,
    pause_reason: null,
    traffic_guard_paused: false,
    ...overrides,
  };
}

/** Automation row — a comment→DM funnel with keyword LINK by default. */
export function automationRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: E2E.automationId,
    user_id: E2E.ownerUserId,
    instagram_account_id: E2E.accountId,
    name: 'E2E synthetic automation',
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
    dm_opening_message: 'Here is your guide',
    dm_opening_message_button_title: null,
    dm_opening_message_button_link: null,
    ask_to_follow_enabled: false,
    ask_to_follow_message: '',
    ask_to_follow_visit_profile_button: '',
    ask_to_follow_confirm_button: '',
    dm_responses: [],
    follow_up_enabled: false,
    follow_up_delay_minutes: 60,
    follow_up_message: '',
    is_traffic_guard_paused: false,
    total_dms_sent: 0,
    ...overrides,
  };
}

/** Job payload for the comment-triggered opening DM of the default world. */
export function jobPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: E2E.automationId,
    instagramAccountId: E2E.accountId,
    igAccountIgsid: E2E.ownerIgsid,
    triggerType: 'comment',
    triggerUserId: E2E.fanIgsid,
    triggerUsername: E2E.fanUsername,
    triggerEventId: E2E.commentId,
    triggerTimestamp: Date.now(),
    postId: E2E.postId,
    commentText: 'LINK',
    messageText: null,
    ...overrides,
  };
}

/** Comment webhook body (Meta `changes` shape) for the default world. */
export function commentWebhookBody(
  text: string,
  commentId: string = E2E.commentId,
  fromId: string = E2E.fanIgsid
): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: E2E.ownerIgsid,
        time: nowSec,
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: fromId, username: E2E.fanUsername },
              media: { id: E2E.postId },
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

/** DM webhook body (Meta `messaging` shape) for the default world. */
export function dmWebhookBody(
  text: string,
  mid = 'mid-e2e-1',
  fromId: string = E2E.fanIgsid,
  extraMessage: Record<string, unknown> = {}
): MetaWebhookBody {
  return {
    object: 'instagram',
    entry: [
      {
        id: E2E.ownerIgsid,
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: fromId },
            recipient: { id: E2E.ownerIgsid },
            timestamp: Date.now(),
            message: { mid, text, ...extraMessage },
          },
        ],
      },
    ],
  } as MetaWebhookBody;
}

/** Story-reply DM webhook body — a DM carrying `message.reply_to.story`. */
export function storyReplyWebhookBody(text: string, mid = 'mid-e2e-story-1'): MetaWebhookBody {
  return dmWebhookBody(text, mid, E2E.fanIgsid, {
    reply_to: { mid: 'mid-e2e-story-src', story: { id: 'story-e2e-1', url: 'https://example.invalid/story' } },
  });
}

/** Durable scheduled-follow-up row (automation_follow_ups shape). */
export function followUpRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'fu-e2e-1',
    automation_id: E2E.automationId,
    instagram_account_id: E2E.accountId,
    session_id: null,
    recipient_id: E2E.fanIgsid,
    recipient_username: E2E.fanUsername,
    qualified_event_id: 'evt-e2e-qual-1',
    qualified_timestamp: new Date().toISOString(),
    scheduled_for: new Date().toISOString(),
    status: 'scheduled',
    message_snapshot: 'Checking in!',
    error_reason: null,
    sent_at: null,
    ...overrides,
  };
}

/** Job payload that drives the scheduled-follow-up processor for followUpRow(). */
export function scheduledFollowUpPayload(
  overrides: Partial<AutoDmJobPayload> = {}
): AutoDmJobPayload {
  return jobPayload({
    triggerType: 'dm_reply_followup',
    triggerEventId: 'scheduled_evt-e2e-qual-1',
    isFollowUp: true,
    isScheduledFollowUp: true,
    sessionStep: 99,
    followUpText: 'Checking in!',
    commentText: null,
    postId: null,
    ...overrides,
  });
}
