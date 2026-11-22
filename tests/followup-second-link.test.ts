/**
 * Second link button through the reveal-tap follow-up paths (2026-11-22).
 *
 * Bug (proven live 2026-11-22): the two follow-up processors — IG
 * processFollowUpDmJob and FB processFacebookFollowUpDmJob — bypassed the
 * shared senders (sendOneResponse / sendOneFacebookResponse) and inlined a
 * legacy-only single-button send: they read only response.buttonLink /
 * buttonTitle and called the string overload of the link-button sender.
 * The stored dm_responses[].buttons array (2 entries) was never looked at,
 * so the second button was silently dropped on every reveal-tap delivery.
 * Server proof: every fb_link_button_attempt debug row 2026-11-22 08:24–
 * 08:51 UTC logged buttonCount=1, and Meta read-back of delivered messages
 * showed exactly one button ("Get it now!").
 *
 * Fix under test: both follow-up loops now resolve the buttons with
 * getTextLinkButtons(response) and pass the array to the sender; the
 * inline fallback prints every resolved button, not just the legacy one.
 * The 1-step (no-reveal) paths already did this and are untouched.
 *
 * Harness mirrors tests/p19-bf3-followup-pair.test.ts: FakeSupabase only,
 * Meta surface mocked, jitter collapsed — zero real Meta calls. Each case
 * drives the REAL follow-up processor and asserts on the arguments the
 * mocked sender received — a source-text pin would not have caught this
 * bug (the shared helpers already contained the right code).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import { MetaApiError } from '@/lib/instagram/errors';
import type { AutoDmJobPayload } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32);
const WS_A = 'workspace-A';
const OWNER_A = 'user-owner-a';

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
vi.mock('@/lib/facebook/api', () => ({
  sendFacebookMessage: vi.fn(async () => 'fb-msg-1'),
  sendFacebookLinkButtonMessage: vi.fn(async () => 'fb-msg-2'),
  sendFacebookCardMessage: vi.fn(async () => 'fb-msg-3'),
  replyToFacebookComment: vi.fn(async () => {}),
  getFacebookUserProfile: vi.fn(async () => null),
}));
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

import { processFollowUpDmJob } from '@/lib/automation/processJob';
import { processFacebookFollowUpDmJob } from '@/lib/automation/processFacebookJob';
import { sendInstagramDm, sendInstagramLinkButtonDm } from '@/lib/instagram/api';
import {
  sendFacebookMessage,
  sendFacebookLinkButtonMessage,
} from '@/lib/facebook/api';

const mockIgSendDm = vi.mocked(sendInstagramDm);
const mockIgSendLink = vi.mocked(sendInstagramLinkButtonDm);
const mockFbSendMsg = vi.mocked(sendFacebookMessage);
const mockFbSendLink = vi.mocked(sendFacebookLinkButtonMessage);

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

const TABLES = [
  'instagram_accounts', 'facebook_pages', 'automations', 'job_queue', 'dm_sent_log',
  'dm_jobs', 'dm_logs', 'automation_sessions', 'automation_follow_ups',
  'recipient_opt_outs', 'comment_private_reply_reservations',
  'comment_public_reply_reservations', 'workspace_memberships',
  'workspace_instagram_accounts', 'profiles', 'debug_events', 'ai_usage_log',
  'app_settings', 'platform_config', 'inbound_webhook_events', 'tracked_links',
  'dm_rate_events',
] as const;

// The production response from the live incident: "Claude $200 Plan free"
// with two buttons — "Get it now!" (legacy, synced) + "Free AI caption
// generator" (second button). The sender receives tracked short URLs
// (rewriteResponseLinks runs first), so assertions pin titles + count and
// the tracked_links rows pin the destinations.
const TWO_BUTTON_RESPONSE = {
  id: 'r1',
  type: 'text',
  content: 'Claude $200 Plan free',
  buttonTitle: 'Get it now!',
  buttonLink: 'https://switchroute.in/prompt-library/claude-max-plan-free',
  buttons: [
    {
      id: 'legacy',
      title: 'Get it now!',
      link: 'https://switchroute.in/prompt-library/claude-max-plan-free',
    },
    { id: 'gz1n2q9', title: 'Free AI caption generator', link: 'https://www.captionit.in' },
  ],
};

const LEGACY_RESPONSE = {
  id: 'r1',
  type: 'text',
  content: 'Here is your link',
  buttonTitle: 'Get it now!',
  buttonLink: 'https://switchroute.in/prompt-library/claude-max-plan-free',
};

const PLAIN_RESPONSE = { id: 'r1', type: 'text', content: 'Just a message, no links' };

function igAccountRow(overrides: FakeRow = {}): FakeRow {
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

function igAutomationRow(overrides: FakeRow = {}): FakeRow {
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
    dm_responses: [TWO_BUTTON_RESPONSE],
    follow_up_enabled: false,
    follow_up_delay_minutes: 60,
    follow_up_message: '',
    is_traffic_guard_paused: false,
    total_dms_sent: 0,
    ...overrides,
  };
}

function fbPageRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'page-A',
    user_id: OWNER_A,
    workspace_id: WS_A,
    facebook_page_id: 'FB-PAGE-123',
    name: 'Test Page',
    is_active: true,
    access_token_encrypted: encrypt('token-page-A', TOKEN_KEY),
    paused_until: null,
    pause_reason: null,
    ...overrides,
  };
}

function fbAutomationRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-FB',
    user_id: OWNER_A,
    facebook_page_id: 'page-A',
    name: 'FB Automation',
    type: 'fb_comment_dm',
    is_active: true,
    dm_responses: [TWO_BUTTON_RESPONSE],
    ...overrides,
  };
}

function sessionRow(kind: 'ig' | 'fb', overrides: FakeRow = {}): FakeRow {
  const base =
    kind === 'ig'
      ? {
          id: 'sess-A',
          automation_id: 'auto-A',
          instagram_account_id: 'acct-A',
          audience_ig_user_id: 'IG-FAN',
        }
      : {
          id: 'sess-FB',
          automation_id: 'auto-FB',
          facebook_page_id: 'page-A',
          audience_ig_user_id: 'FB-FAN',
        };
  return {
    ...base,
    current_step: 1,
    completed: false,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function igPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: 'auto-A',
    instagramAccountId: 'acct-A',
    igAccountIgsid: 'IG-A',
    triggerType: 'dm_reply_followup',
    triggerUserId: 'IG-FAN',
    triggerUsername: 'fan',
    triggerEventId: 'tap-1',
    triggerTimestamp: Date.now(),
    postId: 'post-1',
    commentText: null,
    messageText: null,
    isFollowUp: true,
    sessionId: 'sess-A',
    sessionStep: 1,
    ...overrides,
  };
}

function fbPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: 'auto-FB',
    instagramAccountId: 'page-A',
    igAccountIgsid: 'FB-PAGE-123',
    triggerType: 'dm_reply_followup',
    triggerUserId: 'FB-FAN',
    triggerUsername: 'fan',
    triggerEventId: 'tap-1',
    triggerTimestamp: Date.now(),
    postId: 'post-1',
    commentText: null,
    messageText: null,
    isFollowUp: true,
    sessionId: 'sess-FB',
    sessionStep: 1,
    ...overrides,
  };
}

function trackedDestinations(): string[] {
  return fake.rows('tracked_links').map((r) => r['destination_url'] as string);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
  afterCallbacks.length = 0;
  mockIgSendDm.mockClear();
  mockIgSendLink.mockClear();
  mockFbSendMsg.mockClear();
  mockFbSendLink.mockClear();
  fake.setRpcHandler('check_and_record_fb_dm_rate_limit', async () => ({
    data: [{ allowed: true, current_count: 0, retry_after_seconds: 0 }],
    error: null,
  }));
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

describe('IG follow-up (processFollowUpDmJob) sends both link buttons', () => {
  it('sends a 2-button response as a 2-button template, not just the legacy first button', async () => {
    fake.replaceRows('instagram_accounts', [igAccountRow()]);
    fake.replaceRows('automations', [igAutomationRow()]);
    fake.seed('automation_sessions', [sessionRow('ig')]);

    await processFollowUpDmJob(igPayload());

    expect(mockIgSendLink).toHaveBeenCalledTimes(1);
    expect(mockIgSendDm).not.toHaveBeenCalled();
    const buttons = mockIgSendLink.mock.calls[0]![3] as Array<{ title: string; url: string }>;
    expect(Array.isArray(buttons)).toBe(true);
    expect(buttons.map((b) => b.title)).toEqual(['Get it now!', 'Free AI caption generator']);
    // Both links were click-tracked to short URLs; the rows pin the real destinations.
    expect(buttons.every((b) => b.url.startsWith('https://app.opendm.in/r/'))).toBe(true);
    expect(trackedDestinations().sort()).toEqual(
      [
        'https://switchroute.in/prompt-library/claude-max-plan-free',
        'https://www.captionit.in',
      ].sort(),
    );
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });

  it('legacy single-button response still sends exactly 1 button', async () => {
    fake.replaceRows('instagram_accounts', [igAccountRow()]);
    fake.replaceRows('automations', [igAutomationRow({ dm_responses: [LEGACY_RESPONSE] })]);
    fake.seed('automation_sessions', [sessionRow('ig')]);

    await processFollowUpDmJob(igPayload());

    expect(mockIgSendLink).toHaveBeenCalledTimes(1);
    const buttons = mockIgSendLink.mock.calls[0]![3] as Array<{ title: string; url: string }>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.title).toBe('Get it now!');
  });

  it('response with no links sends a plain message', async () => {
    fake.replaceRows('instagram_accounts', [igAccountRow()]);
    fake.replaceRows('automations', [igAutomationRow({ dm_responses: [PLAIN_RESPONSE] })]);
    fake.seed('automation_sessions', [sessionRow('ig')]);

    await processFollowUpDmJob(igPayload());

    expect(mockIgSendLink).not.toHaveBeenCalled();
    expect(mockIgSendDm).toHaveBeenCalledTimes(1);
    expect(mockIgSendDm.mock.calls[0]![2]).toContain('Just a message, no links');
  });

  it('template rejection falls back to inline text with BOTH links, not just the first', async () => {
    fake.replaceRows('instagram_accounts', [igAccountRow()]);
    fake.replaceRows('automations', [igAutomationRow()]);
    fake.seed('automation_sessions', [sessionRow('ig')]);
    mockIgSendLink.mockRejectedValueOnce(new MetaApiError('template rejected', 100, undefined));

    await processFollowUpDmJob(igPayload());

    expect(mockIgSendLink).toHaveBeenCalledTimes(1);
    expect(mockIgSendDm).toHaveBeenCalledTimes(1);
    const text = mockIgSendDm.mock.calls[0]![2] as string;
    expect(text).toContain('Get it now!:');
    expect(text).toContain('Free AI caption generator:');
    expect(text.match(/\/r\/[A-Za-z0-9]{7}/g)).toHaveLength(2);
  });
});

describe('FB follow-up (processFacebookFollowUpDmJob) sends both link buttons', () => {
  it('sends a 2-button response as a 2-button template, not just the legacy first button', async () => {
    fake.replaceRows('facebook_pages', [fbPageRow()]);
    fake.replaceRows('automations', [fbAutomationRow()]);
    fake.seed('automation_sessions', [sessionRow('fb')]);

    await processFacebookFollowUpDmJob(fbPayload());

    expect(mockFbSendLink).toHaveBeenCalledTimes(1);
    expect(mockFbSendMsg).not.toHaveBeenCalled();
    const buttons = mockFbSendLink.mock.calls[0]![3] as Array<{ title: string; url: string }>;
    expect(Array.isArray(buttons)).toBe(true);
    expect(buttons.map((b) => b.title)).toEqual(['Get it now!', 'Free AI caption generator']);
    expect(buttons.every((b) => b.url.startsWith('https://app.opendm.in/r/'))).toBe(true);
    expect(trackedDestinations().sort()).toEqual(
      [
        'https://switchroute.in/prompt-library/claude-max-plan-free',
        'https://www.captionit.in',
      ].sort(),
    );
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });

  it('legacy single-button response still sends exactly 1 button', async () => {
    fake.replaceRows('facebook_pages', [fbPageRow()]);
    fake.replaceRows('automations', [fbAutomationRow({ dm_responses: [LEGACY_RESPONSE] })]);
    fake.seed('automation_sessions', [sessionRow('fb')]);

    await processFacebookFollowUpDmJob(fbPayload());

    expect(mockFbSendLink).toHaveBeenCalledTimes(1);
    const buttons = mockFbSendLink.mock.calls[0]![3] as Array<{ title: string; url: string }>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.title).toBe('Get it now!');
  });

  it('response with no links sends a plain message', async () => {
    fake.replaceRows('facebook_pages', [fbPageRow()]);
    fake.replaceRows('automations', [fbAutomationRow({ dm_responses: [PLAIN_RESPONSE] })]);
    fake.seed('automation_sessions', [sessionRow('fb')]);

    await processFacebookFollowUpDmJob(fbPayload());

    expect(mockFbSendLink).not.toHaveBeenCalled();
    expect(mockFbSendMsg).toHaveBeenCalledTimes(1);
    expect(mockFbSendMsg.mock.calls[0]![2]).toContain('Just a message, no links');
  });

  it('template rejection falls back to inline text with BOTH links, not just the first', async () => {
    fake.replaceRows('facebook_pages', [fbPageRow()]);
    fake.replaceRows('automations', [fbAutomationRow()]);
    fake.seed('automation_sessions', [sessionRow('fb')]);
    mockFbSendLink.mockRejectedValueOnce(new MetaApiError('template rejected', 100, undefined));

    await processFacebookFollowUpDmJob(fbPayload());

    expect(mockFbSendLink).toHaveBeenCalledTimes(1);
    expect(mockFbSendMsg).toHaveBeenCalledTimes(1);
    const text = mockFbSendMsg.mock.calls[0]![2] as string;
    expect(text).toContain('Get it now!:');
    expect(text).toContain('Free AI caption generator:');
    expect(text.match(/\/r\/[A-Za-z0-9]{7}/g)).toHaveLength(2);
  });
});
