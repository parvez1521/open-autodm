/**
 * Programme 18 / Phase D — workspace-mode data routes: contacts,
 * analytics, activity, instagram/accounts list, debug/events.
 *
 * Pins (flag ON): reads are scoped to the selected workspace first and
 * caller filters second (foreign ids ⇒ 404, never widening); accounts
 * list shows only the selected workspace's accounts and never a token;
 * debug events stay PER-USER in workspace mode (PD-1) — a member does
 * not see another member's events in the same workspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET as contactsGET } from '@/app/api/contacts/route';
import { GET as analyticsGET } from '@/app/api/analytics/route';
import { GET as activityGET } from '@/app/api/activity/route';
import { GET as accountsGET } from '@/app/api/instagram/accounts/route';
import { GET as debugGET, DELETE as debugDELETE } from '@/app/api/debug/events/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'acct-a';
const ACCT_B = 'acct-b';

const OWNER_A = { id: 'user-owner-a', email: 'oa@example.com' };
const MEMBER_A = { id: 'user-member-a', email: 'ma@example.com' };
const VIEWER_A = { id: 'user-viewer-a', email: 'va@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'out@example.com' };

let savedFlag: string | undefined;

function seedAll(): void {
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS_A, user_id: OWNER_A.id, role: 'owner' },
    { workspace_id: WS_A, user_id: MEMBER_A.id, role: 'member' },
    { workspace_id: WS_A, user_id: VIEWER_A.id, role: 'viewer' },
  ]);
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER_A.id, workspace_id: WS_A, username: 'acct-a', name: 'A', profile_picture_url: null, is_active: true, token_expires_at: null, paused_until: null, pause_reason: null, access_token_encrypted: 'SECRET-A', created_at: '2026-11-01T00:00:00Z' },
    { id: ACCT_B, user_id: 'user-owner-b', workspace_id: WS_B, username: 'acct-b', name: 'B', profile_picture_url: null, is_active: true, token_expires_at: null, paused_until: null, pause_reason: null, access_token_encrypted: 'SECRET-B', created_at: '2026-11-01T00:00:00Z' },
  ]);
  fake.replaceRows('contacts', [
    { id: 'contact-a1', workspace_id: WS_A, instagram_account_id: ACCT_A, username: 'a-friend', last_interaction_at: '2026-11-05T10:00:00Z', first_interaction_at: '2026-11-05T09:00:00Z', follows_business: true, last_automation_id: 'auto-a1' },
    { id: 'contact-b1', workspace_id: WS_B, instagram_account_id: ACCT_B, username: 'b-friend', last_interaction_at: '2026-11-05T11:00:00Z', first_interaction_at: '2026-11-05T09:30:00Z', follows_business: false, last_automation_id: 'auto-b1' },
  ]);
  fake.replaceRows('automations', [
    { id: 'auto-a1', workspace_id: WS_A, instagram_account_id: ACCT_A, name: 'A one', type: 'comment_dm', is_active: true },
    { id: 'auto-b1', workspace_id: WS_B, instagram_account_id: ACCT_B, name: 'B one', type: 'comment_dm', is_active: true },
  ]);
  fake.replaceRows('dm_jobs', [
    { id: 'job-a1', workspace_id: WS_A, instagram_account_id: ACCT_A, automation_id: 'auto-a1', trigger_type: 'comment', status: 'sent', error_message: null, sent_at: '2026-11-05T10:00:00Z', created_at: '2026-11-05T10:00:00Z', automations: { id: 'auto-a1', name: 'A one', type: 'comment_dm' } },
    { id: 'job-b1', workspace_id: WS_B, instagram_account_id: ACCT_B, automation_id: 'auto-b1', trigger_type: 'comment', status: 'sent', error_message: null, sent_at: '2026-11-05T11:00:00Z', created_at: '2026-11-05T11:00:00Z', automations: { id: 'auto-b1', name: 'B one', type: 'comment_dm' } },
  ]);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('automation_follow_ups', []);
  fake.replaceRows('debug_events', [
    { id: 'e-member', user_id: MEMBER_A.id, workspace_id: WS_A, event_type: 'dm_sent', created_at: '2026-11-05T10:00:00Z' },
    { id: 'e-owner', user_id: OWNER_A.id, workspace_id: WS_A, event_type: 'dm_sent', created_at: '2026-11-05T11:00:00Z' },
    { id: 'e-viewer', user_id: VIEWER_A.id, workspace_id: WS_A, event_type: 'dm_sent', created_at: '2026-11-05T12:00:00Z' },
  ]);
}

beforeEach(() => {
  savedFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  fake.calls.length = 0;
  seedAll();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedFlag;
});

describe('contacts (workspace mode)', () => {
  it("member sees only the selected workspace's contacts", async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await contactsGET(new Request(`https://app.opendm.in/api/contacts?workspace=${WS_A}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contacts: Array<{ id: string }> };
    expect(body.contacts.map((c) => c.id)).toEqual(['contact-a1']);
  });

  it("A's account id addressed under B-scoped request ⇒ 404; non-member ⇒ 403", async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const foreign = await contactsGET(
      new Request(`https://app.opendm.in/api/contacts?workspace=${WS_A}&accountId=${ACCT_B}`),
    );
    expect(foreign.status).toBe(404);

    mockAuth.mockResolvedValue(OUTSIDER);
    const denied = await contactsGET(new Request(`https://app.opendm.in/api/contacts?workspace=${WS_A}`));
    expect(denied.status).toBe(403);
  });
});

describe('analytics (workspace mode)', () => {
  it('aggregates ONLY workspace-owned records', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await analyticsGET(
      new Request(`https://app.opendm.in/api/analytics?workspace=${WS_A}&from=2026-11-01&to=2026-11-30`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { triggers: number }; automations: Array<{ id: string }> };
    expect(body.totals.triggers).toBe(1);
    expect(body.automations.map((a) => a.id)).toEqual(['auto-a1']);
  });

  it('foreign automationId ⇒ 404 (direct check, no widening); foreign accountId ⇒ 404', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const foreignAuto = await analyticsGET(
      new Request(`https://app.opendm.in/api/analytics?workspace=${WS_A}&automationId=auto-b1`),
    );
    expect(foreignAuto.status).toBe(404);
    const foreignAcct = await analyticsGET(
      new Request(`https://app.opendm.in/api/analytics?workspace=${WS_A}&accountId=${ACCT_B}`),
    );
    expect(foreignAcct.status).toBe(404);
  });
});

describe('activity (workspace mode)', () => {
  it("returns only the selected workspace's activity, scoped by workspace_id + account set", async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await activityGET(new Request(`https://app.opendm.in/api/activity?workspace=${WS_A}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ automationId: string }> };
    expect(body.activities.map((a) => a.automationId)).toEqual(['auto-a1']);
    const jobsQuery = fake.callsFor('dm_jobs', 'select')[0]!;
    expect(jobsQuery.filters).toContainEqual({ column: 'workspace_id', op: 'eq', value: WS_A });
  });

  it('foreign accountId ⇒ 404', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await activityGET(
      new Request(`https://app.opendm.in/api/activity?workspace=${WS_A}&accountId=${ACCT_B}`),
    );
    expect(res.status).toBe(404);
  });
});

describe('instagram/accounts list (workspace mode)', () => {
  it("lists ONLY the selected workspace's accounts; token never leaves the server; viewer may read", async () => {
    mockAuth.mockResolvedValue(VIEWER_A);
    const res = await accountsGET(new Request(`https://app.opendm.in/api/instagram/accounts?workspace=${WS_A}`));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('SECRET-A');
    expect(raw).not.toContain('SECRET-B');
    const body = JSON.parse(raw) as { accounts: Array<{ id: string; username: string }> };
    expect(body.accounts.map((a) => a.id)).toEqual([ACCT_A]);
    expect(body.accounts[0]!['username']).toBe('acct-a');
  });
});

describe('debug/events (workspace mode, PD-1 per-user)', () => {
  it("a member sees ONLY their own events — not other members' events in the same workspace", async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await debugGET(new Request(`https://app.opendm.in/api/debug/events?workspace=${WS_A}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ id: string }> };
    expect(body.events.map((e) => e.id)).toEqual(['e-member']);
    const select = fake.callsFor('debug_events', 'select')[0]!;
    expect(select.filters).toContainEqual({ column: 'user_id', op: 'eq', value: MEMBER_A.id });
    expect(select.filters.some((f) => f.column === 'workspace_id')).toBe(false);
  });

  it('non-member gets nothing (403); viewer DELETE is denied and rows survive; member DELETE clears only own rows', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const denied = await debugGET(new Request(`https://app.opendm.in/api/debug/events?workspace=${WS_A}`));
    expect(denied.status).toBe(403);

    mockAuth.mockResolvedValue(VIEWER_A);
    const viewerDel = await debugDELETE(new Request(`https://app.opendm.in/api/debug/events?workspace=${WS_A}`, { method: 'DELETE' }));
    expect(viewerDel.status).toBe(403);
    expect(fake.rows('debug_events')).toHaveLength(3);

    mockAuth.mockResolvedValue(MEMBER_A);
    const memberDel = await debugDELETE(new Request(`https://app.opendm.in/api/debug/events?workspace=${WS_A}`, { method: 'DELETE' }));
    expect(memberDel.status).toBe(200);
    expect(fake.rows('debug_events').map((r) => r['id']).sort()).toEqual(['e-owner', 'e-viewer']);
  });
});
