/**
 * Analytics channel tabs + Duplicate automation (2026-11-22).
 *
 * Feature A — /analytics is split by channel (Instagram | Facebook),
 * same toggle as /automations. The API scopes every source to the
 * requested channel: Instagram rows key on instagram_account_id,
 * Facebook rows on facebook_page_id. Before this, the route only
 * ever read instagram_account_id, so Facebook activity was invisible
 * here entirely — the Facebook tab now shows the real Messenger
 * numbers. Pins: channel=instagram excludes FB rows, channel=facebook
 * returns ONLY FB rows, channel=all (and no param) merges both, an
 * invalid channel is a 400, and per-automation rows carry their
 * channel and are filtered with it. Both branches (legacy flag OFF,
 * workspace flag ON) are covered.
 *
 * Feature B — Duplicate automation: POST /api/automations/[id]/duplicate
 * copies the whole config under "Copy of <name>" and always starts
 * INACTIVE, so the copy can never double-send until the owner
 * activates it. Pins: full config copy (keywords, variations, both
 * link buttons, follow-up, require-follow, lead form, flow graph),
 * counters restart at zero, new id, FB copies stay facebook,
 * foreign id ⇒ 404, workspace viewer ⇒ 403.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET as analyticsGET } from '@/app/api/analytics/route';
import { POST as duplicatePOST } from '@/app/api/automations/[id]/duplicate/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE_A = '99999999-9999-4999-8999-999999999999';

const OWNER_A = { id: 'user-owner-a', email: 'oa@example.com' };
const MEMBER_A = { id: 'user-member-a', email: 'ma@example.com' };
const VIEWER_A = { id: 'user-viewer-a', email: 'va@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'out@example.com' };

const AUTO_IG = 'auto-ig-1';
const AUTO_FB = 'auto-fb-1';

let savedFlag: string | undefined;
function setFlag(on: boolean): void {
  if (on) process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  else delete process.env['WORKSPACE_RUNTIME_ENABLED'];
}

const RANGE = 'from=2026-11-01T00:00:00.000Z&to=2026-11-30T23:59:59.999Z';

function seedAll(): void {
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS_A, user_id: OWNER_A.id, role: 'owner' },
    { workspace_id: WS_A, user_id: MEMBER_A.id, role: 'member' },
    { workspace_id: WS_A, user_id: VIEWER_A.id, role: 'viewer' },
    { workspace_id: WS_B, user_id: OUTSIDER.id, role: 'owner' },
  ]);
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER_A.id, workspace_id: WS_A, username: 'beyond_the.feed', is_active: true },
  ]);
  fake.replaceRows('facebook_pages', [
    { id: PAGE_A, user_id: OWNER_A.id, workspace_id: WS_A, facebook_page_id: '348182738386266', name: 'Tech Hacks AI', is_active: true },
  ]);
  fake.replaceRows('automations', [
    {
      id: AUTO_IG, user_id: OWNER_A.id, workspace_id: WS_A,
      instagram_account_id: ACCT_A, facebook_page_id: null, channel: 'instagram',
      name: 'Flight deal', type: 'comment_dm', is_active: true,
      post_id: '123', post_thumbnail_url: 'https://x/thumb.jpg', post_caption: 'Save big',
      keywords: ['GUIDE'], comment_reply_options: ['Sent!'], public_reply_enabled: true,
      public_reply_options: ['Sent!'], follow_up_enabled: true, follow_up_delay_minutes: 60,
      follow_up_message: 'Still there?',
      dm_opening_message_enabled: true, dm_opening_message: 'Hey!',
      dm_opening_message_variations: ['Hey!', 'Hi there!', 'Hello!'],
      dm_opening_message_button_title: 'Send me the link', dm_opening_message_button_link: null,
      ask_to_follow_enabled: true, ask_to_follow_message: 'Follow first',
      ask_to_follow_visit_profile_button: 'Visit Profile', ask_to_follow_confirm_button: "I'm following ✅",
      dm_responses: [
        {
          id: 'r1', type: 'text', content: 'Here it is', buttonTitle: 'Get it now!',
          buttonLink: 'https://example.com/a',
          buttons: [
            { id: 'b1', title: 'Get it now!', link: 'https://example.com/a' },
            { id: 'b2', title: 'Second link', link: 'https://example.com/b' },
          ],
        },
        { id: 'r2', type: 'lead_form', content: 'Drop your email', leadFields: ['email'] },
      ],
      trigger_config: { mode: 'any' },
      flow_graph: { nodes: [{ id: 't1', type: 'trigger', data: {} }], edges: [] },
      ai_reply_language: 'hinglish', total_dms_sent: 42,
      created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    },
    {
      id: AUTO_FB, user_id: OWNER_A.id, workspace_id: WS_A,
      instagram_account_id: null, facebook_page_id: PAGE_A, channel: 'facebook',
      name: 'Goibibo', type: 'fb_comment_dm', is_active: true,
      post_id: '348182738386266_122221970288455346', post_thumbnail_url: null, post_caption: null,
      keywords: ['*ANY*'], comment_reply_options: ['Got it!'], public_reply_enabled: true,
      public_reply_options: ['Got it!'], follow_up_enabled: false, follow_up_delay_minutes: 60,
      follow_up_message: '',
      dm_opening_message_enabled: true, dm_opening_message: 'Thanks!',
      dm_opening_message_variations: ['Thanks!'],
      dm_opening_message_button_title: 'Send me the link', dm_opening_message_button_link: null,
      ask_to_follow_enabled: false, ask_to_follow_message: '',
      ask_to_follow_visit_profile_button: 'Visit Profile', ask_to_follow_confirm_button: "I'm following ✅",
      dm_responses: [
        {
          id: 'r1', type: 'text', content: 'Save 50%', buttonTitle: 'Save now!',
          buttonLink: 'https://example.com/go',
          buttons: [{ id: 'b1', title: 'Save now!', link: 'https://example.com/go' }],
        },
      ],
      trigger_config: {}, flow_graph: null,
      ai_reply_language: 'en', total_dms_sent: 746,
      created_at: '2026-11-06T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    },
  ]);
  // Analytics rows — IG side keys on instagram_account_id, FB side on
  // facebook_page_id (instagram_account_id NULL there).
  fake.replaceRows('dm_jobs', [
    { automation_id: AUTO_IG, instagram_account_id: ACCT_A, facebook_page_id: null, workspace_id: WS_A, trigger_type: 'comment', status: 'sent', created_at: '2026-11-20T10:00:00Z', sent_at: '2026-11-20T10:00:10Z' },
    { automation_id: AUTO_IG, instagram_account_id: ACCT_A, facebook_page_id: null, workspace_id: WS_A, trigger_type: 'comment', status: 'sent', created_at: '2026-11-20T11:00:00Z', sent_at: '2026-11-20T11:00:10Z' },
    { automation_id: AUTO_IG, instagram_account_id: ACCT_A, facebook_page_id: null, workspace_id: WS_A, trigger_type: 'dm', status: 'failed', created_at: '2026-11-20T12:00:00Z', sent_at: null },
    { automation_id: AUTO_FB, instagram_account_id: null, facebook_page_id: PAGE_A, workspace_id: WS_A, trigger_type: 'comment', status: 'sent', created_at: '2026-11-20T10:00:00Z', sent_at: '2026-11-20T10:00:10Z' },
    { automation_id: AUTO_FB, instagram_account_id: null, facebook_page_id: PAGE_A, workspace_id: WS_A, trigger_type: 'comment', status: 'sent', created_at: '2026-11-20T11:00:00Z', sent_at: '2026-11-20T11:00:10Z' },
    { automation_id: AUTO_FB, instagram_account_id: null, facebook_page_id: PAGE_A, workspace_id: WS_A, trigger_type: 'comment', status: 'sent', created_at: '2026-11-20T12:00:00Z', sent_at: '2026-11-20T12:00:10Z' },
  ]);
  fake.replaceRows('automation_sessions', [
    { automation_id: AUTO_IG, instagram_account_id: ACCT_A, facebook_page_id: null, workspace_id: WS_A, current_step: 2, completed: true, started_at: '2026-11-20T10:05:00Z' },
    { automation_id: AUTO_FB, instagram_account_id: null, facebook_page_id: PAGE_A, workspace_id: WS_A, current_step: 1, completed: true, started_at: '2026-11-20T10:05:00Z' },
  ]);
  fake.replaceRows('contacts', [
    { instagram_account_id: ACCT_A, facebook_page_id: null, workspace_id: WS_A, audience_ig_user_id: 'aud-ig', first_interaction_at: '2026-11-20T10:00:00Z', follows_business: true, last_automation_id: AUTO_IG },
    { instagram_account_id: null, facebook_page_id: PAGE_A, workspace_id: WS_A, audience_ig_user_id: 'aud-fb', first_interaction_at: '2026-11-20T10:05:00Z', follows_business: false, last_automation_id: AUTO_FB },
  ]);
}

beforeEach(() => {
  savedFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  fake.calls.length = 0;
  seedAll();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedFlag;
});

const byId = (id: string) => ({ params: Promise.resolve({ id }) });

interface AnalyticsBody {
  totals: Record<string, number>;
  perAutomation: Array<{ id: string; channel: string; triggers: number; delivered: number; failed: number; flowsCompleted: number; follows: number }>;
  automations: Array<{ id: string; channel: string }>;
  daily: Array<{ date: string; comments: number; dms: number; delivered: number; contacts: number }>;
  channel: string;
}

async function getAnalytics(url: string): Promise<{ status: number; body: AnalyticsBody }> {
  const res = await analyticsGET(new Request(url));
  return { status: res.status, body: (await res.json()) as AnalyticsBody };
}

describe('analytics channel filter — flag OFF (legacy branch)', () => {
  beforeEach(() => setFlag(false));

  it('channel=instagram returns only Instagram rows', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const { status, body } = await getAnalytics(`https://app.opendm.in/api/analytics?${RANGE}&channel=instagram`);
    expect(status).toBe(200);
    expect(body.channel).toBe('instagram');
    expect(body.totals.triggers).toBe(3);
    expect(body.totals.delivered).toBe(2);
    expect(body.totals.failed).toBe(1);
    expect(body.totals.flowsCompleted).toBe(1);
    expect(body.totals.followsGained).toBe(1);
    expect(body.totals.newContacts).toBe(1);
    expect(body.totals.newContactFollowers).toBe(1);
    expect(body.perAutomation.map((a) => a.id)).toEqual([AUTO_IG]);
    expect(body.perAutomation[0]!.channel).toBe('instagram');
    expect(body.automations.map((a) => a.id)).toEqual([AUTO_IG]);
    const day = body.daily.find((d) => d.date === '2026-11-20')!;
    expect(day.comments).toBe(2);
    expect(day.dms).toBe(1);
    expect(day.delivered).toBe(2);
    expect(day.contacts).toBe(1);
  });

  it('channel=facebook returns only Facebook rows (previously invisible here)', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const { status, body } = await getAnalytics(`https://app.opendm.in/api/analytics?${RANGE}&channel=facebook`);
    expect(status).toBe(200);
    expect(body.channel).toBe('facebook');
    expect(body.totals.triggers).toBe(3);
    expect(body.totals.delivered).toBe(3);
    expect(body.totals.failed).toBe(0);
    expect(body.totals.flowsCompleted).toBe(1);
    expect(body.totals.followsGained).toBe(0);
    expect(body.totals.newContacts).toBe(1);
    expect(body.totals.newContactFollowers).toBe(0);
    expect(body.perAutomation.map((a) => a.id)).toEqual([AUTO_FB]);
    expect(body.perAutomation[0]!.channel).toBe('facebook');
    expect(body.automations.map((a) => a.id)).toEqual([AUTO_FB]);
    const day = body.daily.find((d) => d.date === '2026-11-20')!;
    expect(day.comments).toBe(3);
    expect(day.delivered).toBe(3);
    expect(day.contacts).toBe(1);
  });

  it('channel=all (and no channel param) merges both channels', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const all = await getAnalytics(`https://app.opendm.in/api/analytics?${RANGE}&channel=all`);
    expect(all.status).toBe(200);
    expect(all.body.totals.triggers).toBe(6);
    expect(all.body.totals.delivered).toBe(5);
    expect(all.body.totals.failed).toBe(1);
    expect(all.body.totals.newContacts).toBe(2);
    expect(all.body.perAutomation.map((a) => a.id).sort()).toEqual([AUTO_FB, AUTO_IG]);

    const def = await getAnalytics(`https://app.opendm.in/api/analytics?${RANGE}`);
    expect(def.status).toBe(200);
    expect(def.body.channel).toBe('all');
    expect(def.body.totals.triggers).toBe(6);
  });

  it('an invalid channel is a 400', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const { status } = await getAnalytics(`https://app.opendm.in/api/analytics?${RANGE}&channel=tiktok`);
    expect(status).toBe(400);
  });

  it('accountId accepts a Facebook Page id on the facebook tab', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const { status, body } = await getAnalytics(
      `https://app.opendm.in/api/analytics?${RANGE}&channel=facebook&accountId=${PAGE_A}`,
    );
    expect(status).toBe(200);
    expect(body.totals.triggers).toBe(3);
    expect(body.perAutomation.map((a) => a.id)).toEqual([AUTO_FB]);
  });
});

describe('analytics channel filter — flag ON (workspace branch)', () => {
  beforeEach(() => setFlag(true));

  it('channel=facebook returns only this workspace’s Facebook rows', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    // Another workspace's FB job for the same Page — must never leak
    // into WS_A numbers (the legacy branch has no workspace concept,
    // so this row only exists in the workspace-mode seed).
    fake.rows('dm_jobs').push(
      { automation_id: AUTO_FB, instagram_account_id: null, facebook_page_id: PAGE_A, workspace_id: WS_B, trigger_type: 'comment', status: 'sent', created_at: '2026-11-20T13:00:00Z', sent_at: '2026-11-20T13:00:10Z' },
    );
    const { status, body } = await getAnalytics(
      `https://app.opendm.in/api/analytics?${RANGE}&channel=facebook&workspace=${WS_A}`,
    );
    expect(status).toBe(200);
    // The WS_B job seeded above must not leak in.
    expect(body.totals.triggers).toBe(3);
    expect(body.totals.delivered).toBe(3);
    expect(body.perAutomation.map((a) => a.id)).toEqual([AUTO_FB]);
  });

  it('channel=instagram returns only this workspace’s Instagram rows', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const { status, body } = await getAnalytics(
      `https://app.opendm.in/api/analytics?${RANGE}&channel=instagram&workspace=${WS_A}`,
    );
    expect(status).toBe(200);
    expect(body.totals.triggers).toBe(3);
    expect(body.totals.delivered).toBe(2);
    expect(body.perAutomation.map((a) => a.id)).toEqual([AUTO_IG]);
  });
});

describe('duplicate automation', () => {
  beforeEach(() => setFlag(false));

  it('copies the whole Instagram config under "Copy of …", starting INACTIVE', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await duplicatePOST(
      new Request(`https://app.opendm.in/api/automations/${AUTO_IG}/duplicate`, { method: 'POST' }),
      byId(AUTO_IG),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { automation: { id: string; name: string; type: string; is_active: boolean; total_dms_sent: number } };
    expect(body.automation.id).not.toBe(AUTO_IG);
    expect(body.automation.name).toBe('Copy of Flight deal');
    expect(body.automation.type).toBe('comment_dm');
    expect(body.automation.is_active).toBe(false);
    expect(body.automation.total_dms_sent).toBe(0);

    const copy = fake.rows('automations').find((r) => r['id'] === body.automation.id)!;
    expect(copy['channel']).toBe('instagram');
    expect(copy['instagram_account_id']).toBe(ACCT_A);
    expect(copy['facebook_page_id']).toBe(null);
    expect(copy['paused_by_disconnect']).toBe(false);
    expect(copy['keywords']).toEqual(['GUIDE']);
    expect(copy['post_id']).toBe('123');
    expect(copy['post_thumbnail_url']).toBe('https://x/thumb.jpg');
    expect(copy['post_caption']).toBe('Save big');
    expect(copy['comment_reply_options']).toEqual(['Sent!']);
    expect(copy['public_reply_options']).toEqual(['Sent!']);
    expect(copy['dm_opening_message_variations']).toEqual(['Hey!', 'Hi there!', 'Hello!']);
    expect(copy['dm_opening_message']).toBe('Hey!');
    expect(copy['dm_opening_message_button_title']).toBe('Send me the link');
    expect(copy['follow_up_enabled']).toBe(true);
    expect(copy['follow_up_delay_minutes']).toBe(60);
    expect(copy['follow_up_message']).toBe('Still there?');
    expect(copy['ask_to_follow_enabled']).toBe(true);
    expect(copy['ask_to_follow_message']).toBe('Follow first');
    expect(copy['ai_reply_language']).toBe('hinglish');
    expect(copy['trigger_config']).toEqual({ mode: 'any' });
    expect(copy['flow_graph']).toEqual({ nodes: [{ id: 't1', type: 'trigger', data: {} }], edges: [] });
    // Both link buttons + the lead-form response survive the copy.
    const responses = copy['dm_responses'] as Array<{ type: string; buttons?: Array<{ title: string; link: string }> }>;
    expect(responses).toHaveLength(2);
    expect(responses[0]!.buttons).toEqual([
      { id: 'b1', title: 'Get it now!', link: 'https://example.com/a' },
      { id: 'b2', title: 'Second link', link: 'https://example.com/b' },
    ]);
    expect(responses[1]!.type).toBe('lead_form');

    // The source row is untouched.
    const source = fake.rows('automations').find((r) => r['id'] === AUTO_IG)!;
    expect(source['is_active']).toBe(true);
    expect(source['total_dms_sent']).toBe(42);
  });

  it('duplicating a Facebook automation stays facebook, inactive', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await duplicatePOST(
      new Request(`https://app.opendm.in/api/automations/${AUTO_FB}/duplicate`, { method: 'POST' }),
      byId(AUTO_FB),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { automation: { id: string; name: string; is_active: boolean } };
    expect(body.automation.name).toBe('Copy of Goibibo');
    expect(body.automation.is_active).toBe(false);
    const copy = fake.rows('automations').find((r) => r['id'] === body.automation.id)!;
    expect(copy['channel']).toBe('facebook');
    expect(copy['facebook_page_id']).toBe(PAGE_A);
    expect(copy['instagram_account_id']).toBe(null);
    expect(copy['type']).toBe('fb_comment_dm');
    expect(copy['keywords']).toEqual(['*ANY*']);
    expect(copy['post_id']).toBe('348182738386266_122221970288455346');
  });

  it('foreign id ⇒ 404 with zero mutation (legacy)', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const before = fake.rows('automations').length;
    const res = await duplicatePOST(
      new Request(`https://app.opendm.in/api/automations/${AUTO_IG}/duplicate`, { method: 'POST' }),
      byId(AUTO_IG),
    );
    expect(res.status).toBe(404);
    expect(fake.rows('automations').length).toBe(before);
  });

  it('unauthenticated ⇒ 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await duplicatePOST(
      new Request(`https://app.opendm.in/api/automations/${AUTO_IG}/duplicate`, { method: 'POST' }),
      byId(AUTO_IG),
    );
    expect(res.status).toBe(401);
  });
});

describe('duplicate automation — flag ON (workspace branch)', () => {
  beforeEach(() => setFlag(true));

  it('member duplicates in their own workspace; copy is stamped + inactive', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await duplicatePOST(
      new Request(`https://app.opendm.in/api/automations/${AUTO_IG}/duplicate?workspace=${WS_A}`, { method: 'POST' }),
      byId(AUTO_IG),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { automation: { id: string; name: string; is_active: boolean } };
    expect(body.automation.name).toBe('Copy of Flight deal');
    expect(body.automation.is_active).toBe(false);
    const copy = fake.rows('automations').find((r) => r['id'] === body.automation.id)!;
    expect(copy['workspace_id']).toBe(WS_A);
    expect(copy['user_id']).toBe(MEMBER_A.id);
  });

  it('viewer cannot duplicate (403); foreign-workspace id ⇒ 404', async () => {
    mockAuth.mockResolvedValue(VIEWER_A);
    const before = fake.rows('automations').length;
    const denied = await duplicatePOST(
      new Request(`https://app.opendm.in/api/automations/${AUTO_IG}/duplicate?workspace=${WS_A}`, { method: 'POST' }),
      byId(AUTO_IG),
    );
    expect(denied.status).toBe(403);
    expect(fake.rows('automations').length).toBe(before);

    // The source lives in WS_A; WS_B's owner asking for it by id
    // gets a 404 (the IDOR posture: foreign rows do not exist).
    mockAuth.mockResolvedValue(OUTSIDER);
    const foreign = await duplicatePOST(
      new Request(`https://app.opendm.in/api/automations/${AUTO_IG}/duplicate?workspace=${WS_B}`, { method: 'POST' }),
      byId(AUTO_IG),
    );
    expect(foreign.status).toBe(404);
    expect(fake.rows('automations').length).toBe(before);
  });
});

describe('analytics channel tabs — page wiring (source pins)', () => {
  const readSrc = (rel: string): string =>
    readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

  it('renders an Instagram / Facebook toggle in the same pill style as /automations', () => {
    const page = readSrc('app/(main)/analytics/page.tsx');
    expect(page).toContain('aria-label="Analytics channel"');
    expect(page).toContain('InstagramLogo');
    expect(page).toContain('FacebookLogo');
    expect(page).toContain('"Instagram"');
    expect(page).toContain('"Facebook"');
    expect(page).toContain('bg-muted rounded-lg p-0.5');
    expect(page).toContain('h-8 px-3.5 rounded-[6px]');
  });

  it('defaults to Instagram and persists the choice in localStorage', () => {
    const page = readSrc('app/(main)/analytics/page.tsx');
    expect(page).toContain('opendm-analytics-channel');
    expect(page).toContain('useState<ChannelTab>(() => {');
    expect(page).toContain('localStorage.getItem(CHANNEL_STORAGE_KEY)');
    expect(page).toContain('localStorage.setItem(CHANNEL_STORAGE_KEY, channelTab)');
    expect(page).toContain('return "instagram"');
    expect(page).toContain('=== "facebook" ? "facebook" : "instagram"');
  });

  it('passes the channel (and the selected Page on the Facebook tab) to the analytics query', () => {
    const page = readSrc('app/(main)/analytics/page.tsx');
    expect(page).toContain('channel: channelTab');
    expect(page).toContain("accountId: channelTab === \"facebook\" ? activeFacebookPageId : accountId");
    expect(page).toContain('setAutomationId("all")');
    expect(page).toContain('No Facebook activity in this range yet');
    expect(page).toContain('No Facebook automations yet');
  });

  it('the hook sends channel to the API and keys the cache on it', () => {
    const hook = readSrc('hooks/useAnalytics.ts');
    expect(hook).toContain("channel: 'instagram' | 'facebook' | 'all'");
    expect(hook).toContain('channel,');
    expect(hook).toContain("params.accountId ?? 'all', channel");
  });
});

describe('duplicate automation — list wiring (source pins)', () => {
  const readSrc = (rel: string): string =>
    readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

  it('the list row has a Duplicate button next to Edit/Delete', () => {
    const list = readSrc('components/automations/AutomationsList.tsx');
    expect(list).toContain('onDuplicate');
    expect(list).toContain('title="Duplicate automation');
    expect(list).toContain('<Copy className="w-3.5 h-3.5" />');
    expect(list).toContain('duplicatingId');
  });

  it('the hook posts to the duplicate endpoint and refreshes the list', () => {
    const hook = readSrc('hooks/useAutomations.ts');
    expect(hook).toContain('export function useDuplicateAutomation()');
    expect(hook).toContain('/duplicate');
    expect(hook).toContain("method: 'POST'");
    expect(hook).toContain("invalidateQueries({ queryKey: ['automations'] })");
  });

  it('the page wires duplicate through the list and surfaces its error', () => {
    const page = readSrc('app/(main)/automations/page.tsx');
    expect(page).toContain('useDuplicateAutomation');
    expect(page).toContain('onDuplicate={handleDuplicate}');
    expect(page).toContain('duplicatingId={duplicateMutation.isPending');
    expect(page).toContain('duplicateMutation.error?.message');
  });

  it('the duplicate route validates with the shared create schema and starts inactive', () => {
    const route = readSrc('app/api/automations/[id]/duplicate/route.ts');
    expect(route).toContain('CreateAutomationSchema.safeParse');
    expect(route).toContain('buildDuplicateInsertRow');
    // The inactive-start + "Copy of" naming live in the shared
    // duplicate helper the route calls.
    const helper = readSrc('lib/automation/duplicate.ts');
    expect(helper).toContain('isActive: false');
    expect(helper).toContain('is_active: false');
    expect(helper).toContain('Copy of');
  });
});
