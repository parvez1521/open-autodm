/**
 * Activity-route fix (2026-11-23, audit #12 follow-up) — GET
 * /api/activity (src/app/api/activity/route.ts).
 *
 * The dashboard showed correct stats (7 automations, 80 comments,
 * 99 DMs, 80 contacts) while "Recent Activity" read "No recent
 * events". The 0080aff transport fix (workspace-scoped read) was
 * correct hygiene but NOT the cause — two query-shape defects were:
 *
 *  1. Facebook-blind: the queries filtered ONLY on
 *     instagram_account_id, while Facebook jobs carry
 *     facebook_page_id with instagram_account_id NULL — the same
 *     defect /api/analytics had until c452a48. The route now
 *     queries BOTH sides, and a requested accountId may be an
 *     Instagram account OR a Facebook Page row id.
 *  2. Fragile join + swallowed errors: the dm_jobs select embedded
 *     `automations (id, name, type)` — the only dm_jobs query in
 *     the codebase with a relation embed — and ANY error from that
 *     select was logged and silently continued with `[]`, so a
 *     failing leg masqueraded as "no activity" (200 + empty). The
 *     selects are now FLAT (the /api/analytics shape) with
 *     automation names joined in JS, the jobs leg runs under
 *     withTransientQueryRetry, and a persistent failure returns
 *     500 instead of a misleading empty feed.
 *
 * These pins fail on the old code (FB jobs invisible; names fall
 * back to 'Automation' without the embed; errors swallowed) and
 * pass on the fix. The fake cannot reproduce a real PostgREST
 * embed failure, so the 500 pin uses failNextQuery instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET } from '@/app/api/activity/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const USER_A = { id: 'user-a', email: 'a@example.com' };

const WS_A = 'ws-a-0001';
const ACCT_A = 'acct-a';
const FB_PAGE_A = 'fb-page-a';
const OWNER_A = { id: 'user-owner-a', email: 'oa@example.com' };

let savedFlag: string | undefined;

function seedLegacy(): void {
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: USER_A.id, instagram_user_id: 'IG-A' },
  ]);
  fake.replaceRows('facebook_pages', [
    { id: FB_PAGE_A, user_id: USER_A.id, facebook_page_id: '348182738386266' },
  ]);
  // Automation names live in the automations table — the route joins
  // them in JS now; the dm_jobs rows deliberately carry NO inline
  // `automations` object (the old code read names from the embed).
  fake.replaceRows('automations', [
    { id: 'auto-ig', user_id: USER_A.id, name: 'IG funnel', type: 'comment_dm' },
    { id: 'auto-fb', user_id: USER_A.id, name: 'FB funnel', type: 'fb_comment_dm' },
  ]);
  fake.replaceRows('dm_jobs', [
    {
      id: 'job-ig-1',
      instagram_account_id: ACCT_A,
      facebook_page_id: null,
      trigger_type: 'comment',
      status: 'sent',
      error_message: null,
      sent_at: '2026-11-22T10:00:00Z',
      created_at: '2026-11-22T10:00:00Z',
      automation_id: 'auto-ig',
    },
    {
      id: 'job-fb-1',
      instagram_account_id: null,
      facebook_page_id: FB_PAGE_A,
      trigger_type: 'comment',
      status: 'sent',
      error_message: null,
      sent_at: '2026-11-22T11:00:00Z',
      created_at: '2026-11-22T11:00:00Z',
      automation_id: 'auto-fb',
    },
  ]);
  fake.replaceRows('automation_follow_ups', []);
}

function seedWorkspace(): void {
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS_A, user_id: OWNER_A.id, role: 'owner' },
  ]);
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER_A.id, workspace_id: WS_A, username: 'acct-a' },
  ]);
  fake.replaceRows('facebook_pages', [
    { id: FB_PAGE_A, user_id: OWNER_A.id, workspace_id: WS_A, facebook_page_id: '348182738386266' },
  ]);
  fake.replaceRows('automations', [
    { id: 'auto-fb', workspace_id: WS_A, facebook_page_id: FB_PAGE_A, name: 'FB funnel', type: 'fb_comment_dm', is_active: true },
  ]);
  fake.replaceRows('dm_jobs', [
    {
      id: 'job-fb-1',
      workspace_id: WS_A,
      instagram_account_id: null,
      facebook_page_id: FB_PAGE_A,
      trigger_type: 'comment',
      status: 'sent',
      error_message: null,
      sent_at: '2026-11-22T11:00:00Z',
      created_at: '2026-11-22T11:00:00Z',
      automation_id: 'auto-fb',
    },
  ]);
  fake.replaceRows('automation_follow_ups', []);
}

beforeEach(() => {
  savedFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  fake.calls.length = 0;
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedFlag;
});

describe('activity (legacy mode) — Facebook jobs are visible', () => {
  beforeEach(() => {
    delete process.env['WORKSPACE_RUNTIME_ENABLED'];
    seedLegacy();
    mockAuth.mockResolvedValue(USER_A);
  });

  it('unscoped read returns BOTH the Instagram job and the Facebook job', async () => {
    const res = await GET(new Request('https://app.opendm.in/api/activity'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ id: string; automationId: string }> };
    expect(body.activities.map((a) => a.automationId).sort()).toEqual(['auto-fb', 'auto-ig']);
    // The Facebook leg queries by facebook_page_id (the old code had
    // no such query at all — its only dm_jobs filter was IG).
    const jobsQueries = fake.callsFor('dm_jobs', 'select');
    expect(jobsQueries.some((q) => q.filters.some((f) => f.column === 'facebook_page_id' && f.op === 'in'))).toBe(true);
  });

  it('automation names come from the automations table, not an embedded join', async () => {
    const res = await GET(new Request('https://app.opendm.in/api/activity'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ automationId: string; automationName: string }> };
    const byId = new Map(body.activities.map((a) => [a.automationId, a.automationName]));
    expect(byId.get('auto-ig')).toBe('IG funnel');
    expect(byId.get('auto-fb')).toBe('FB funnel');
  });

  it('a requested Facebook Page id scopes to Facebook activity only (200)', async () => {
    const res = await GET(new Request(`https://app.opendm.in/api/activity?accountId=${FB_PAGE_A}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ automationId: string }> };
    expect(body.activities.map((a) => a.automationId)).toEqual(['auto-fb']);
  });

  it('a requested Facebook Page id the caller does not own ⇒ 404', async () => {
    const res = await GET(new Request('https://app.opendm.in/api/activity?accountId=fb-page-foreign'));
    expect(res.status).toBe(404);
  });

  it('a persistent jobs-leg failure returns 500 — never a misleading empty 200', async () => {
    // Non-transient code (PGRST116): the retry helper rethrows
    // immediately, no backoff, so this stays fast.
    fake.failNextQuery('dm_jobs', { code: 'PGRST116', message: 'simulated persistent failure' });
    const res = await GET(new Request('https://app.opendm.in/api/activity'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; activities?: unknown };
    expect(body.error).toBeTruthy();
    expect(body.activities).toBeUndefined();
  });

  it('a follow-ups-leg failure does NOT blank the jobs feed (200, jobs still listed)', async () => {
    fake.failNextQuery('automation_follow_ups', { code: 'PGRST116', message: 'simulated follow-ups failure' });
    const res = await GET(new Request('https://app.opendm.in/api/activity'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ automationId: string }> };
    expect(body.activities.map((a) => a.automationId).sort()).toEqual(['auto-fb', 'auto-ig']);
  });
});

describe('activity (workspace mode) — Facebook jobs are visible', () => {
  beforeEach(() => {
    process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
    seedWorkspace();
    mockAuth.mockResolvedValue(OWNER_A);
  });

  it('a workspace Facebook job appears in the feed (was invisible: the old query filtered IG only)', async () => {
    const res = await GET(new Request(`https://app.opendm.in/api/activity?workspace=${WS_A}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ automationId: string; automationName: string }> };
    expect(body.activities.map((a) => a.automationId)).toEqual(['auto-fb']);
    expect(body.activities[0]!.automationName).toBe('FB funnel');
  });

  it('a workspace with NO accounts returns 200 + empty activities (empty state, not an error)', async () => {
    fake.replaceRows('workspace_memberships', [
      { workspace_id: 'ws-empty', user_id: OWNER_A.id, role: 'owner' },
    ]);
    fake.replaceRows('instagram_accounts', []);
    fake.replaceRows('facebook_pages', []);
    fake.replaceRows('dm_jobs', []);
    const res = await GET(new Request('https://app.opendm.in/api/activity?workspace=ws-empty'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: unknown[] };
    expect(body.activities).toEqual([]);
  });
});
