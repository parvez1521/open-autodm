/**
 * Programme 18 / Phase D — workspace-mode automations routes.
 *
 * Pins, against the FakeSupabase harness:
 *  - flag OFF ⇒ legacy behaviour (list scoped by user_id; by-id PUT
 *    scoped by user_id) — the pre-P18 contract, unchanged;
 *  - flag ON ⇒ member lists/creates in own workspace only; viewer reads
 *    but cannot write; a user with two workspaces sees only the selected
 *    workspace's rows; foreign automation/account ids ⇒ 404 with zero
 *    mutation; create with a foreign account is rejected; a created
 *    automation is stamped with the ctx workspace_id (TW-1).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET, POST } from '@/app/api/automations/route';
import { PUT, DELETE } from '@/app/api/automations/[id]/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const OWNER_A = { id: 'user-owner-a', email: 'oa@example.com' };
const MEMBER_A = { id: 'user-member-a', email: 'ma@example.com' };
const VIEWER_A = { id: 'user-viewer-a', email: 'va@example.com' };
const DUAL = { id: 'user-dual', email: 'dual@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'out@example.com' };

let savedFlag: string | undefined;
function setFlag(on: boolean): void {
  if (on) process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  else delete process.env['WORKSPACE_RUNTIME_ENABLED'];
}

function seedAll(): void {
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS_A, user_id: OWNER_A.id, role: 'owner' },
    { workspace_id: WS_A, user_id: MEMBER_A.id, role: 'member' },
    { workspace_id: WS_A, user_id: VIEWER_A.id, role: 'viewer' },
    { workspace_id: WS_A, user_id: DUAL.id, role: 'member' },
    { workspace_id: WS_B, user_id: DUAL.id, role: 'member' },
  ]);
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER_A.id, workspace_id: WS_A, username: 'acct-a', is_active: true },
    { id: ACCT_B, user_id: 'user-owner-b', workspace_id: WS_B, username: 'acct-b', is_active: true },
  ]);
  fake.replaceRows('automations', [
    { id: 'auto-a1', user_id: OWNER_A.id, workspace_id: WS_A, instagram_account_id: ACCT_A, name: 'A one', type: 'comment_dm', is_active: true, flow_graph: null, created_at: '2026-11-05T10:00:00Z' },
    { id: 'auto-a2', user_id: OWNER_A.id, workspace_id: WS_A, instagram_account_id: ACCT_A, name: 'A two', type: 'comment_dm', is_active: true, flow_graph: null, created_at: '2026-11-05T09:00:00Z' },
    { id: 'auto-b1', user_id: 'user-owner-b', workspace_id: WS_B, instagram_account_id: ACCT_B, name: 'B one', type: 'comment_dm', is_active: true, flow_graph: null, created_at: '2026-11-05T11:00:00Z' },
    { id: 'auto-legacy', user_id: OWNER_A.id, workspace_id: null, instagram_account_id: ACCT_A, name: 'Legacy', type: 'comment_dm', is_active: true, flow_graph: null, created_at: '2026-11-04T10:00:00Z' },
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

describe('flag OFF — legacy behaviour preserved', () => {
  beforeEach(() => setFlag(false));

  it('GET list is scoped by user_id (workspace_id is ignored)', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await GET(new Request('https://app.opendm.in/api/automations'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automations: Array<{ id: string }> };
    // Legacy scope = every row with user_id = caller, incl. the
    // NULL-workspace legacy row and excluding B's row.
    expect(body.automations.map((a) => a.id).sort()).toEqual(['auto-a1', 'auto-a2', 'auto-legacy']);
    const select = fake.callsFor('automations', 'select')[0]!;
    expect(select.filters).toContainEqual({ column: 'user_id', op: 'eq', value: OWNER_A.id });
  });

  it('PUT by-id updates the caller-owned automation; foreign id ⇒ 404', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const ok = await PUT(
      new Request('https://app.opendm.in/api/automations/auto-a1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      }),
      byId('auto-a1'),
    );
    expect(ok.status).toBe(200);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-a1')!['name']).toBe('Renamed');

    const foreign = await PUT(
      new Request('https://app.opendm.in/api/automations/auto-b1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijack' }),
      }),
      byId('auto-b1'),
    );
    expect(foreign.status).toBe(404);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-b1')!['name']).toBe('B one');
  });
});

describe('flag ON — workspace mode', () => {
  beforeEach(() => setFlag(true));

  it('member lists ONLY the selected workspace automations', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await GET(new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automations: Array<{ id: string }> };
    expect(body.automations.map((a) => a.id).sort()).toEqual(['auto-a1', 'auto-a2']);
  });

  it('header selector wins over the query selector', async () => {
    mockAuth.mockResolvedValue(DUAL);
    const res = await GET(
      new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`, {
        headers: { 'x-workspace-id': WS_B },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automations: Array<{ id: string }> };
    expect(body.automations.map((a) => a.id)).toEqual(['auto-b1']);
  });

  it('a two-workspace user sees only the selected workspace in each selection', async () => {
    mockAuth.mockResolvedValue(DUAL);
    const resA = await GET(new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`));
    const bodyA = (await resA.json()) as { automations: Array<{ id: string }> };
    expect(bodyA.automations.map((a) => a.id).sort()).toEqual(['auto-a1', 'auto-a2']);
    const resB = await GET(new Request(`https://app.opendm.in/api/automations?workspace=${WS_B}`));
    const bodyB = (await resB.json()) as { automations: Array<{ id: string }> };
    expect(bodyB.automations.map((a) => a.id)).toEqual(['auto-b1']);
  });

  it('non-member is denied with no data; missing selector fails closed', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const denied = await GET(new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`));
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { automations?: unknown };
    expect(deniedBody.automations).toBeUndefined();

    mockAuth.mockResolvedValue(MEMBER_A);
    const noSelector = await GET(new Request('https://app.opendm.in/api/automations'));
    expect(noSelector.status).toBe(400);
  });

  it('viewer can read but cannot create', async () => {
    mockAuth.mockResolvedValue(VIEWER_A);
    const list = await GET(new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`));
    expect(list.status).toBe(200);

    const create = await POST(
      new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagramAccountId: ACCT_A, name: 'Viewer made', type: 'comment_dm' }),
      }),
    );
    expect(create.status).toBe(403);
    expect(fake.rows('automations').some((r) => r['name'] === 'Viewer made')).toBe(false);
  });

  it('member creates in own workspace; the new row is stamped with the ctx workspace_id', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await POST(
      new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagramAccountId: ACCT_A, name: 'Member made', type: 'comment_dm' }),
      }),
    );
    expect(res.status).toBe(201);
    const stored = fake.rows('automations').filter((r) => r['name'] === 'Member made');
    expect(stored).toHaveLength(1);
    expect(stored[0]!['workspace_id']).toBe(WS_A);
    expect(stored[0]!['user_id']).toBe(MEMBER_A.id);
  });

  it('create with a FOREIGN account is rejected and inserts nothing', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const before = fake.rows('automations').length;
    const res = await POST(
      new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagramAccountId: ACCT_B, name: 'Cross tenant', type: 'comment_dm' }),
      }),
    );
    expect(res.status).toBe(404);
    expect(fake.rows('automations')).toHaveLength(before);
  });

  it("A's automation addressed under B's context ⇒ PUT 404 + zero mutation; DELETE 404 + row survives", async () => {
    mockAuth.mockResolvedValue(DUAL);
    const put = await PUT(
      new Request(`https://app.opendm.in/api/automations/auto-a1?workspace=${WS_B}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijack' }),
      }),
      byId('auto-a1'),
    );
    expect(put.status).toBe(404);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-a1')!['name']).toBe('A one');

    const del = await DELETE(
      new Request(`https://app.opendm.in/api/automations/auto-a1?workspace=${WS_B}`, { method: 'DELETE' }),
      byId('auto-a1'),
    );
    expect(del.status).toBe(404);
    expect(fake.rows('automations').some((r) => r['id'] === 'auto-a1')).toBe(true);
  });

  it('member updates and deletes in own workspace; viewer write is denied with zero mutation', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const put = await PUT(
      new Request(`https://app.opendm.in/api/automations/auto-a2?workspace=${WS_A}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'A two renamed' }),
      }),
      byId('auto-a2'),
    );
    expect(put.status).toBe(200);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-a2')!['name']).toBe('A two renamed');

    mockAuth.mockResolvedValue(VIEWER_A);
    const viewerPut = await PUT(
      new Request(`https://app.opendm.in/api/automations/auto-a1?workspace=${WS_A}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Viewer hijack' }),
      }),
      byId('auto-a1'),
    );
    expect(viewerPut.status).toBe(403);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-a1')!['name']).toBe('A one');

    mockAuth.mockResolvedValue(MEMBER_A);
    const del = await DELETE(
      new Request(`https://app.opendm.in/api/automations/auto-a2?workspace=${WS_A}`, { method: 'DELETE' }),
      byId('auto-a2'),
    );
    expect(del.status).toBe(200);
    expect(fake.rows('automations').some((r) => r['id'] === 'auto-a2')).toBe(false);
  });

  it('list with a foreign accountId filter ⇒ 404 (filter cannot widen scope)', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await GET(
      new Request(`https://app.opendm.in/api/automations?workspace=${WS_A}&accountId=${ACCT_B}`),
    );
    expect(res.status).toBe(404);
  });
});
