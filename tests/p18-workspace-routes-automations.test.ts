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

// ── Bug 2 enforcement (owner-approved 2026-11-09) ──────────────────
// Before this fix, plan limits were display-only: no mutation path
// consulted the entitlement service, so a Free workspace could create
// unlimited active automations (public-readiness-audit.md Bug 2).
// The gate (lib/entitlements/guard.ts) engages only with
// ENTITLEMENTS_ENFORCED=true; flag off ⇒ behaviour is unchanged.
describe('Bug 2 enforcement — automations (2026-11-09)', () => {
  let savedEnforced: string | undefined;
  beforeEach(() => {
    savedEnforced = process.env['ENTITLEMENTS_ENFORCED'];
    process.env['ENTITLEMENTS_ENFORCED'] = 'true';
    // seedAll() does not manage `subscriptions` (the fake is a module
    // singleton) — start every enforcement test from "no subscription
    // row" (Free) unless the test seeds one itself.
    fake.replaceRows('subscriptions', []);
  });
  afterEach(() => {
    if (savedEnforced === undefined) delete process.env['ENTITLEMENTS_ENFORCED'];
    else process.env['ENTITLEMENTS_ENFORCED'] = savedEnforced;
  });

  const postAuto = (name: string, extra: Record<string, unknown> = {}, ws = true) =>
    POST(
      new Request(`https://app.opendm.in/api/automations${ws ? `?workspace=${WS_A}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagramAccountId: ACCT_A, name, type: 'comment_dm', ...extra }),
      }),
    );

  describe('workspace mode', () => {
    beforeEach(() => setFlag(true));

    it('Free workspace: creating active automations is blocked at the plan limit (3); inactive creates are never gated', async () => {
      mockAuth.mockResolvedValue(MEMBER_A);
      // WS_A already holds 2 active automations (auto-a1, auto-a2).
      const third = await postAuto('Third active');
      expect(third.status).toBe(201);
      const fourth = await postAuto('Fourth active');
      expect(fourth.status).toBe(403);
      const body = (await fourth.json()) as { code?: string; limit?: number; used?: number };
      expect(body.code).toBe('PLAN_LIMIT_REACHED');
      expect(body.limit).toBe(3);
      expect(body.used).toBe(3);
      expect(fake.rows('automations').some((r) => r['name'] === 'Fourth active')).toBe(false);
      // An INACTIVE create consumes no slot ⇒ allowed even at the limit.
      const inactive = await postAuto('Draft one', { isActive: false });
      expect(inactive.status).toBe(201);
    });

    it('Free workspace: activating an automation beyond the limit is blocked; editing an active one is not', async () => {
      fake.replaceRows('automations', [
        ...fake.rows('automations'),
        { id: 'auto-a3-off', user_id: OWNER_A.id, workspace_id: WS_A, instagram_account_id: ACCT_A, name: 'A three (off)', type: 'comment_dm', is_active: false, flow_graph: null, created_at: '2026-11-05T08:00:00Z' },
      ]);
      mockAuth.mockResolvedValue(MEMBER_A);
      const third = await postAuto('Third active');
      expect(third.status).toBe(201); // workspace now at the Free limit of 3 actives

      const activate = await PUT(
        new Request(`https://app.opendm.in/api/automations/auto-a3-off?workspace=${WS_A}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: true }),
        }),
        byId('auto-a3-off'),
      );
      expect(activate.status).toBe(403);
      expect(((await activate.json()) as { code?: string }).code).toBe('PLAN_LIMIT_REACHED');
      expect(fake.rows('automations').find((r) => r['id'] === 'auto-a3-off')!['is_active']).toBe(false);

      // Editing an already-active automation consumes no new slot.
      const edit = await PUT(
        new Request(`https://app.opendm.in/api/automations/auto-a1?workspace=${WS_A}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'A one renamed', is_active: true }),
        }),
        byId('auto-a1'),
      );
      expect(edit.status).toBe(200);
    });

    it('paid plan limits are respected (creator-pro: 50 active automations — Free would have blocked)', async () => {
      fake.replaceRows('subscriptions', [
        {
          id: 'sub-ws-a', workspace_id: WS_A, plan_id: 'creator-pro', lifecycle_status: 'active',
          provider: 'razorpay', billing_period: 'monthly', amount_minor: 50_000, currency: 'INR',
          current_period_start: '2026-11-01T00:00:00.000Z', current_period_end: '2027-01-01T00:00:00.000Z',
          trial_ends_at: null,
        },
      ]);
      mockAuth.mockResolvedValue(MEMBER_A);
      expect((await postAuto('Paid third')).status).toBe(201);
      expect((await postAuto('Paid fourth')).status).toBe(201);
      expect((await postAuto('Paid fifth')).status).toBe(201);
    });

    it('ENTITLEMENTS_ENFORCED off ⇒ over-limit creates pass exactly as before the fix', async () => {
      delete process.env['ENTITLEMENTS_ENFORCED'];
      mockAuth.mockResolvedValue(MEMBER_A);
      expect((await postAuto('Off third')).status).toBe(201);
      expect((await postAuto('Off fourth')).status).toBe(201);
      expect((await postAuto('Off fifth')).status).toBe(201);
    });
  });

  describe('legacy mode', () => {
    beforeEach(() => setFlag(false));

    it('Free user at the user-scoped limit (3 active incl. legacy rows) is blocked on an active create; inactive passes', async () => {
      mockAuth.mockResolvedValue(OWNER_A);
      // OWNER_A owns auto-a1, auto-a2 and auto-legacy — all active.
      const blocked = await postAuto('Legacy fourth', {}, false);
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { code?: string }).code).toBe('PLAN_LIMIT_REACHED');
      expect(fake.rows('automations').some((r) => r['name'] === 'Legacy fourth')).toBe(false);
      const inactive = await postAuto('Legacy draft', { isActive: false }, false);
      expect(inactive.status).toBe(201);
    });
  });
});
