/**
 * Programme 18 / Phase D — workspace-mode account administration and
 * traffic-guard routes.
 *
 * Pins (flag ON):
 *  - disconnect / refresh / resubscribe require 'accountAdmin'
 *    (owner/admin): a member is denied 403 with zero mutation, and a
 *    foreign account under the caller's workspace ⇒ 404 (token never
 *    touched);
 *  - subscription-status and posts are READS under the PD-3 split: a
 *    member may use them for an in-workspace account, foreign ⇒ 404;
 *  - traffic-guard status is a read (viewer ok); pause/resume follow
 *    the PD-4 interim member+ rule; dismiss is member-level; every
 *    action on a foreign account is denied before the tracker runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

const { mockPause, mockResume, mockStatus, mockMarkRead, mockDecrypt } = vi.hoisted(() => ({
  mockPause: vi.fn(),
  mockResume: vi.fn(),
  mockStatus: vi.fn(),
  mockMarkRead: vi.fn(),
  mockDecrypt: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/trafficGuard/tracker', () => ({
  getAccountTrafficGuardStatus: mockStatus,
  pauseAccountAutomations: mockPause,
  resumeAccountAutomations: mockResume,
  markNotificationRead: mockMarkRead,
}));
vi.mock('@/lib/crypto', () => ({
  decrypt: mockDecrypt,
  encrypt: (value: string) => `enc-${value}`,
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'test-key' }) }));
vi.mock('@/lib/instagram/oauth', () => ({
  refreshLongLivedToken: vi.fn(async () => ({ access_token: 'fresh-token', expires_in: 5184000 })),
}));
vi.mock('@/lib/instagram/api', () => ({
  subscribeToWebhookFields: vi.fn(async () => ({ ok: true, body: '{"success":true}' })),
  getSubscribedFields: vi.fn(async () => ({ ok: true, fields: ['comments', 'messages'], raw: '{}' })),
  WEBHOOK_SUBSCRIBED_FIELDS: ['comments', 'messages'],
  META_API_VERSION: 'v21.0',
}));

import { DELETE as disconnectDELETE } from '@/app/api/instagram/disconnect/[accountId]/route';
import { POST as refreshPOST } from '@/app/api/instagram/refresh/[accountId]/route';
import { POST as resubscribePOST } from '@/app/api/instagram/resubscribe/[accountId]/route';
import { GET as subStatusGET } from '@/app/api/instagram/subscription-status/[accountId]/route';
import { GET as postsGET } from '@/app/api/instagram/posts/[accountId]/route';
import { GET as tgStatusGET } from '@/app/api/traffic-guard/status/route';
import { POST as tgPausePOST } from '@/app/api/traffic-guard/pause/route';
import { POST as tgResumePOST } from '@/app/api/traffic-guard/resume/route';
import { POST as tgDismissPOST } from '@/app/api/traffic-guard/dismiss/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INCIDENT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INCIDENT_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTIF_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOTIF_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const OWNER_A = { id: 'user-owner-a', email: 'oa@example.com' };
const MEMBER_A = { id: 'user-member-a', email: 'ma@example.com' };
const VIEWER_A = { id: 'user-viewer-a', email: 'va@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'out@example.com' };

const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString();

let savedFlag: string | undefined;

function seedAll(): void {
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS_A, user_id: OWNER_A.id, role: 'owner' },
    { workspace_id: WS_A, user_id: MEMBER_A.id, role: 'member' },
    { workspace_id: WS_A, user_id: VIEWER_A.id, role: 'viewer' },
  ]);
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER_A.id, workspace_id: WS_A, username: 'acct-a', instagram_user_id: 'IG-A', is_active: true, access_token_encrypted: 'enc-old', token_expires_at: FUTURE, traffic_guard_paused: true, traffic_guard_paused_incident_id: INCIDENT_A },
    { id: ACCT_B, user_id: 'user-owner-b', workspace_id: WS_B, username: 'acct-b', instagram_user_id: 'IG-B', is_active: true, access_token_encrypted: 'enc-b', token_expires_at: FUTURE },
  ]);
  fake.replaceRows('comment_traffic_incidents', [
    { id: INCIDENT_A, workspace_id: WS_A, instagram_account_id: ACCT_A, paused_at: '2026-11-05T10:00:00Z', resumed_at: null },
    { id: INCIDENT_B, workspace_id: WS_B, instagram_account_id: ACCT_B, paused_at: '2026-11-05T10:00:00Z', resumed_at: null },
  ]);
  fake.replaceRows('traffic_guard_notifications', [
    { id: NOTIF_A, workspace_id: WS_A, user_id: MEMBER_A.id, instagram_account_id: ACCT_A, is_read: false },
    { id: NOTIF_B, workspace_id: WS_B, user_id: 'user-owner-b', instagram_account_id: ACCT_B, is_read: false },
  ]);
}

beforeEach(() => {
  savedFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  fake.calls.length = 0;
  seedAll();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
  mockPause.mockReset().mockResolvedValue({ success: true, pausedAutomationIds: [], heldJobsCount: 0 });
  mockResume.mockReset().mockResolvedValue({ success: true, resumedAutomationIds: [], resumedJobsCount: 0 });
  mockStatus.mockReset().mockResolvedValue({ state: 'normal', current60sCount: 0, notifications: [] });
  mockMarkRead.mockReset().mockResolvedValue(undefined);
  mockDecrypt.mockReset().mockReturnValue('plain-token');
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedFlag;
  vi.unstubAllGlobals();
});

const acctCtx = (accountId: string) => ({ params: Promise.resolve({ accountId }) });
const wsReq = (url: string, init?: RequestInit) => new Request(url, init);
const postJson = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('disconnect (accountAdmin)', () => {
  it('owner disconnects an in-workspace account', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await disconnectDELETE(wsReq(`https://app.opendm.in/api/instagram/disconnect/${ACCT_A}?workspace=${WS_A}`, { method: 'DELETE' }), acctCtx(ACCT_A));
    expect(res.status).toBe(200);
    expect(fake.rows('instagram_accounts').some((r) => r['id'] === ACCT_A)).toBe(false);
  });

  it('member is denied 403 (accountAdmin) with zero mutation; foreign account ⇒ 404 for the owner', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const denied = await disconnectDELETE(wsReq(`https://app.opendm.in/api/instagram/disconnect/${ACCT_A}?workspace=${WS_A}`, { method: 'DELETE' }), acctCtx(ACCT_A));
    expect(denied.status).toBe(403);
    expect(fake.rows('instagram_accounts').some((r) => r['id'] === ACCT_A)).toBe(true);

    mockAuth.mockResolvedValue(OWNER_A);
    const foreign = await disconnectDELETE(wsReq(`https://app.opendm.in/api/instagram/disconnect/${ACCT_B}?workspace=${WS_A}`, { method: 'DELETE' }), acctCtx(ACCT_B));
    expect(foreign.status).toBe(404);
    expect(fake.rows('instagram_accounts').some((r) => r['id'] === ACCT_B)).toBe(true);
  });
});

describe('refresh (accountAdmin)', () => {
  it('owner refreshes; the stored token is rotated through the scoped update', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await refreshPOST(wsReq(`https://app.opendm.in/api/instagram/refresh/${ACCT_A}?workspace=${WS_A}`, { method: 'POST' }), acctCtx(ACCT_A));
    expect(res.status).toBe(200);
    expect(fake.rows('instagram_accounts').find((r) => r['id'] === ACCT_A)!['access_token_encrypted']).toBe('enc-fresh-token');
  });

  it('member is denied 403 and the token is never decrypted; foreign account ⇒ 404', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const denied = await refreshPOST(wsReq(`https://app.opendm.in/api/instagram/refresh/${ACCT_A}?workspace=${WS_A}`, { method: 'POST' }), acctCtx(ACCT_A));
    expect(denied.status).toBe(403);
    expect(mockDecrypt).not.toHaveBeenCalled();
    expect(fake.rows('instagram_accounts').find((r) => r['id'] === ACCT_A)!['access_token_encrypted']).toBe('enc-old');

    mockAuth.mockResolvedValue(OWNER_A);
    const foreign = await refreshPOST(wsReq(`https://app.opendm.in/api/instagram/refresh/${ACCT_B}?workspace=${WS_A}`, { method: 'POST' }), acctCtx(ACCT_B));
    expect(foreign.status).toBe(404);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});

describe('resubscribe (accountAdmin)', () => {
  it('owner resubscribes an in-workspace account; member denied 403; foreign ⇒ 404', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const ok = await resubscribePOST(wsReq(`https://app.opendm.in/api/instagram/resubscribe/${ACCT_A}?workspace=${WS_A}`, { method: 'POST' }), acctCtx(ACCT_A));
    expect(ok.status).toBe(200);

    mockAuth.mockResolvedValue(MEMBER_A);
    const denied = await resubscribePOST(wsReq(`https://app.opendm.in/api/instagram/resubscribe/${ACCT_A}?workspace=${WS_A}`, { method: 'POST' }), acctCtx(ACCT_A));
    expect(denied.status).toBe(403);

    mockAuth.mockResolvedValue(OWNER_A);
    const foreign = await resubscribePOST(wsReq(`https://app.opendm.in/api/instagram/resubscribe/${ACCT_B}?workspace=${WS_A}`, { method: 'POST' }), acctCtx(ACCT_B));
    expect(foreign.status).toBe(404);
  });
});

describe('subscription-status + posts (PD-3 read split)', () => {
  it('a MEMBER may read subscription status for an in-workspace account; foreign ⇒ 404', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const ok = await subStatusGET(wsReq(`https://app.opendm.in/api/instagram/subscription-status/${ACCT_A}?workspace=${WS_A}`), acctCtx(ACCT_A));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { hasComments: boolean };
    expect(body.hasComments).toBe(true);

    const foreign = await subStatusGET(wsReq(`https://app.opendm.in/api/instagram/subscription-status/${ACCT_B}?workspace=${WS_A}`), acctCtx(ACCT_B));
    expect(foreign.status).toBe(404);
  });

  it('a MEMBER may read posts for an in-workspace account; foreign ⇒ 404 and Meta is never called', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'm1', media_type: 'IMAGE', permalink: 'https://insta.example/p/1', timestamp: '2026-11-05T10:00:00Z', caption: 'hi' }],
        paging: {},
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    mockAuth.mockResolvedValue(MEMBER_A);
    const ok = await postsGET(wsReq(`https://app.opendm.in/api/instagram/posts/${ACCT_A}?workspace=${WS_A}`), acctCtx(ACCT_A));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { posts: Array<{ id: string }> };
    expect(body.posts.map((p) => p.id)).toEqual(['m1']);

    fetchMock.mockClear();
    const foreign = await postsGET(wsReq(`https://app.opendm.in/api/instagram/posts/${ACCT_B}?workspace=${WS_A}`), acctCtx(ACCT_B));
    expect(foreign.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('traffic-guard (workspace mode)', () => {
  it('status is a read: viewer ok for in-workspace account; foreign account ⇒ 404 and tracker not called', async () => {
    mockAuth.mockResolvedValue(VIEWER_A);
    const ok = await tgStatusGET(new Request(`https://app.opendm.in/api/traffic-guard/status?accountId=${ACCT_A}&workspace=${WS_A}`));
    expect(ok.status).toBe(200);
    expect(mockStatus).toHaveBeenCalledWith(ACCT_A);

    mockStatus.mockClear();
    const foreign = await tgStatusGET(new Request(`https://app.opendm.in/api/traffic-guard/status?accountId=${ACCT_B}&workspace=${WS_A}`));
    expect(foreign.status).toBe(404);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('pause follows the PD-4 interim member+ rule; viewer denied; foreign account/incident denied before the RPC', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const ok = await tgPausePOST(postJson(`https://app.opendm.in/api/traffic-guard/pause?workspace=${WS_A}`, { accountId: ACCT_A, incidentId: INCIDENT_A }));
    expect(ok.status).toBe(200);
    expect(mockPause).toHaveBeenCalledWith(ACCT_A, INCIDENT_A);

    mockPause.mockClear();
    mockAuth.mockResolvedValue(VIEWER_A);
    const viewer = await tgPausePOST(postJson(`https://app.opendm.in/api/traffic-guard/pause?workspace=${WS_A}`, { accountId: ACCT_A, incidentId: INCIDENT_A }));
    expect(viewer.status).toBe(403);
    expect(mockPause).not.toHaveBeenCalled();

    mockAuth.mockResolvedValue(MEMBER_A);
    const foreignAcct = await tgPausePOST(postJson(`https://app.opendm.in/api/traffic-guard/pause?workspace=${WS_A}`, { accountId: ACCT_B, incidentId: INCIDENT_B }));
    expect(foreignAcct.status).toBe(404);
    const foreignIncident = await tgPausePOST(postJson(`https://app.opendm.in/api/traffic-guard/pause?workspace=${WS_A}`, { accountId: ACCT_A, incidentId: INCIDENT_B }));
    expect(foreignIncident.status).toBe(404);
    expect(mockPause).not.toHaveBeenCalled();
  });

  it('resume: member resumes the active paused incident; foreign account ⇒ 404 before the RPC', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const ok = await tgResumePOST(postJson(`https://app.opendm.in/api/traffic-guard/resume?workspace=${WS_A}`, { accountId: ACCT_A, incidentId: INCIDENT_A }));
    expect(ok.status).toBe(200);
    expect(mockResume).toHaveBeenCalledWith(ACCT_A, INCIDENT_A);

    mockResume.mockClear();
    const foreign = await tgResumePOST(postJson(`https://app.opendm.in/api/traffic-guard/resume?workspace=${WS_A}`, { accountId: ACCT_B, incidentId: INCIDENT_B }));
    expect(foreign.status).toBe(404);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('dismiss is member-level: member ok (own-user filter preserved); viewer denied; foreign notification ⇒ 404', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const ok = await tgDismissPOST(postJson(`https://app.opendm.in/api/traffic-guard/dismiss?workspace=${WS_A}`, { notificationId: NOTIF_A }));
    expect(ok.status).toBe(200);
    expect(mockMarkRead).toHaveBeenCalledWith(NOTIF_A, MEMBER_A.id);

    mockMarkRead.mockClear();
    mockAuth.mockResolvedValue(VIEWER_A);
    const viewer = await tgDismissPOST(postJson(`https://app.opendm.in/api/traffic-guard/dismiss?workspace=${WS_A}`, { notificationId: NOTIF_A }));
    expect(viewer.status).toBe(403);
    expect(mockMarkRead).not.toHaveBeenCalled();

    mockAuth.mockResolvedValue(MEMBER_A);
    const foreign = await tgDismissPOST(postJson(`https://app.opendm.in/api/traffic-guard/dismiss?workspace=${WS_A}`, { notificationId: NOTIF_B }));
    expect(foreign.status).toBe(404);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it('non-member is denied on every traffic-guard action', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const res = await tgPausePOST(postJson(`https://app.opendm.in/api/traffic-guard/pause?workspace=${WS_A}`, { accountId: ACCT_A, incidentId: INCIDENT_A }));
    expect(res.status).toBe(403);
    expect(mockPause).not.toHaveBeenCalled();
  });
});
