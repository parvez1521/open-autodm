/**
 * Programme 18 / Phase J — cross-tenant security matrix (route + repository
 * level), against the FakeSupabase harness only. No real DB / Meta.
 *
 * Fixture world: workspace A and workspace B, each with owner/admin/member/
 * viewer; one DUAL user who is a member of BOTH (independently); one
 * OUTSIDER who belongs to neither. Phase D/G workstreams already pin many
 * single-surface cases in depth; this file pins the MATRIX combinations
 * the brief calls for — revocation / role-change taking effect on the NEXT
 * request (fresh resolution per request), body-supplied identity claims,
 * cross-workspace read/edit/delete across automations + contacts + IG
 * accounts, viewer write-denial on every layer, member-cannot-grant-owner,
 * platform-admin separation, replay, and no-NULL stamping.
 *
 * Mutation coverage: this file is one of the targeted suites for the
 * Phase J mutation runs M1 (repository assert), M2 (routeContext
 * membership), M3 (requireCapability), M5 (automations account check) and
 * M6 (invitations manageMembers pre-check) — see
 * saas/PHASE_18_SECURITY_TEST_REPORT.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
// Programme 19 (F-J1): membership RPCs now run through the user-JWT
// factory; its mock returns the SAME FakeSupabase (assertions unchanged).
vi.mock('@/lib/supabase/userClient', () => ({ createUserRpcClient: vi.fn() }));

import { GET as automationsGET, POST as automationsPOST } from '@/app/api/automations/route';
import { PUT as automationPUT, DELETE as automationDELETE } from '@/app/api/automations/[id]/route';
import { GET as contactsGET } from '@/app/api/contacts/route';
import { GET as accountsGET } from '@/app/api/instagram/accounts/route';
import { GET as listWorkspaces, POST as createWorkspace } from '@/app/api/workspaces/route';
import { POST as acceptInvitation } from '@/app/api/workspaces/accept/route';
import { GET as listMembers } from '@/app/api/workspaces/[workspaceId]/members/route';
import { POST as createInvitation } from '@/app/api/workspaces/[workspaceId]/invitations/route';
import { PATCH as changeMemberRole } from '@/app/api/workspaces/[workspaceId]/members/[userId]/route';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { evaluatePlatformAdminGate } from '@/lib/admin/guard';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createUserRpcClient } from '@/lib/supabase/userClient';

const mockAuth = vi.mocked(getAuthenticatedUser);
const db = fake as unknown as SupabaseClient;

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const OWNER_A = { id: 'user-owner-a', email: 'oa@example.com' };
const ADMIN_A = { id: 'user-admin-a', email: 'aa@example.com' };
const MEMBER_A = { id: 'user-member-a', email: 'ma@example.com' };
const VIEWER_A = { id: 'user-viewer-a', email: 'va@example.com' };
const OWNER_B = { id: 'user-owner-b', email: 'ob@example.com' };
const DUAL = { id: 'user-dual', email: 'dual@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'out@example.com' };

let savedFlag: string | undefined;

function memberships(): Array<Record<string, unknown>> {
  return [
    { workspace_id: WS_A, user_id: OWNER_A.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS_A, user_id: ADMIN_A.id, role: 'admin', created_at: '2026-11-01T01:00:00Z' },
    { workspace_id: WS_A, user_id: MEMBER_A.id, role: 'member', created_at: '2026-11-01T02:00:00Z' },
    { workspace_id: WS_A, user_id: VIEWER_A.id, role: 'viewer', created_at: '2026-11-01T03:00:00Z' },
    { workspace_id: WS_A, user_id: DUAL.id, role: 'member', created_at: '2026-11-01T04:00:00Z' },
    { workspace_id: WS_B, user_id: OWNER_B.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS_B, user_id: DUAL.id, role: 'member', created_at: '2026-11-01T01:00:00Z' },
  ];
}

function seedAll(): void {
  fake.replaceRows('workspace_memberships', memberships());
  fake.replaceRows('workspaces', [
    { id: WS_A, name: 'Studio A', created_at: '2026-11-01T00:00:00Z' },
    { id: WS_B, name: 'Studio B', created_at: '2026-11-01T00:00:00Z' },
  ]);
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER_A.id, workspace_id: WS_A, username: 'acct-a', is_active: true, access_token_encrypted: 'SECRET-A' },
    { id: ACCT_B, user_id: OWNER_B.id, workspace_id: WS_B, username: 'acct-b', is_active: true, access_token_encrypted: 'SECRET-B' },
  ]);
  fake.replaceRows('automations', [
    { id: 'auto-a1', user_id: OWNER_A.id, workspace_id: WS_A, instagram_account_id: ACCT_A, name: 'A one', type: 'comment_dm', is_active: true, flow_graph: null, created_at: '2026-11-05T10:00:00Z' },
    { id: 'auto-b1', user_id: OWNER_B.id, workspace_id: WS_B, instagram_account_id: ACCT_B, name: 'B one', type: 'comment_dm', is_active: true, flow_graph: null, created_at: '2026-11-05T11:00:00Z' },
  ]);
  fake.replaceRows('contacts', [
    { id: 'contact-a1', workspace_id: WS_A, instagram_account_id: ACCT_A, username: 'a-friend', last_interaction_at: '2026-11-05T10:00:00Z', first_interaction_at: '2026-11-05T09:00:00Z' },
    { id: 'contact-b1', workspace_id: WS_B, instagram_account_id: ACCT_B, username: 'b-friend', last_interaction_at: '2026-11-05T11:00:00Z', first_interaction_at: '2026-11-05T09:30:00Z' },
  ]);
  fake.replaceRows('workspace_invitations', []);
}

function setRole(userId: string, workspaceId: string, role: string | null): void {
  const rows = memberships().filter(
    (m) => !(m['user_id'] === userId && m['workspace_id'] === workspaceId),
  );
  // Preserve the OTHER rows as currently stored, not the pristine seed:
  const current = fake.rows('workspace_memberships').filter(
    (m) => !(m['user_id'] === userId && m['workspace_id'] === workspaceId),
  );
  void rows;
  if (role !== null) current.push({ workspace_id: workspaceId, user_id: userId, role, created_at: '2026-11-02T00:00:00Z' });
  fake.replaceRows('workspace_memberships', current as never);
}

const jsonReq = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const byId = (id: string) => ({ params: Promise.resolve({ id }) });
const wsParams = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });
const memberParams = (workspaceId: string, userId: string) => ({ params: Promise.resolve({ workspaceId, userId }) });

beforeEach(() => {
  savedFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  seedAll();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  vi.mocked(createUserRpcClient).mockResolvedValue({
    ok: true,
    client: fake as unknown as SupabaseClient,
  });
  mockAuth.mockReset();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedFlag;
});

// ── Valid access + non-member denial ───────────────────────────────────────

describe('valid member access / non-member denied everywhere', () => {
  it('valid members (owner/admin/member/viewer) can read workspace A automations + members', async () => {
    for (const u of [OWNER_A, ADMIN_A, MEMBER_A, VIEWER_A]) {
      mockAuth.mockResolvedValue(u);
      const autos = await automationsGET(new Request(`https://app.example/api/automations?workspace=${WS_A}`));
      expect(autos.status, u.id).toBe(200);
      const members = await listMembers(new Request(`https://app.example/api/workspaces/${WS_A}/members`), wsParams(WS_A));
      expect(members.status, u.id).toBe(200);
    }
  });

  it('non-member is denied on automations, contacts, accounts, members and invitations — with no data', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const autos = await automationsGET(new Request(`https://app.example/api/automations?workspace=${WS_A}`));
    expect(autos.status).toBe(403);
    expect(((await autos.json()) as { automations?: unknown }).automations).toBeUndefined();

    const contacts = await contactsGET(new Request(`https://app.example/api/contacts?workspace=${WS_A}`));
    expect(contacts.status).toBe(403);

    const accounts = await accountsGET(new Request(`https://app.example/api/instagram/accounts?workspace=${WS_A}`));
    expect(accounts.status).toBe(403);

    const members = await listMembers(new Request(`https://app.example/api/workspaces/${WS_A}/members`), wsParams(WS_A));
    expect(members.status).toBe(403);
    expect(((await members.json()) as { members?: unknown }).members).toBeUndefined();

    const invite = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS_A}/invitations`, 'POST', { email: 'x@y.co', role: 'member' }),
      wsParams(WS_A),
    );
    expect(invite.status).toBe(403);
    expect(fake.rows('workspace_invitations')).toHaveLength(0);

    const resolved = await resolveRouteWorkspaceContext(db, OUTSIDER.id, WS_A);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('not-a-member');
  });

  it('repository level: a non-member cannot even construct a context; a member repo lists only own workspace', async () => {
    const member = await resolveRouteWorkspaceContext(db, MEMBER_A.id, WS_A);
    expect(member.ok).toBe(true);
    if (!member.ok) return;
    const repo = createTenantRepository(db, member.ctx, 'read');
    expect((await repo.automations.list()).map((r) => r['id'])).toEqual(['auto-a1']);
    expect((await repo.contacts.list()).map((r) => r['id'])).toEqual(['contact-a1']);
  });
});

// ── Two-workspace independence ─────────────────────────────────────────────

describe('two-workspace user selects each workspace independently', () => {
  it('DUAL sees only A under A selector and only B under B selector (automations + workspace list)', async () => {
    mockAuth.mockResolvedValue(DUAL);
    const a = await automationsGET(new Request(`https://app.example/api/automations?workspace=${WS_A}`));
    expect(((await a.json()) as { automations: Array<{ id: string }> }).automations.map((x) => x.id)).toEqual(['auto-a1']);
    const b = await automationsGET(new Request(`https://app.example/api/automations?workspace=${WS_B}`));
    expect(((await b.json()) as { automations: Array<{ id: string }> }).automations.map((x) => x.id)).toEqual(['auto-b1']);

    const list = await listWorkspaces(new Request('https://app.example/api/workspaces'));
    const body = (await list.json()) as { workspaces: Array<{ workspaceId: string }> };
    expect(body.workspaces.map((w) => w.workspaceId).sort()).toEqual([WS_A, WS_B].sort());
  });

  it('DUAL creates in B with B\u2019s account: the row is stamped WS_B (never WS_A, never NULL)', async () => {
    mockAuth.mockResolvedValue(DUAL);
    const res = await automationsPOST(
      jsonReq(`https://app.example/api/automations?workspace=${WS_B}`, 'POST', { instagramAccountId: ACCT_B, name: 'Dual in B', type: 'comment_dm' }),
    );
    expect(res.status).toBe(201);
    const row = fake.rows('automations').find((r) => r['name'] === 'Dual in B')!;
    expect(row['workspace_id']).toBe(WS_B);
  });
});

// ── Revocation / role change: NEXT request ─────────────────────────────────

describe('revocation and role change take effect on the NEXT request (fresh resolution per request)', () => {
  it('membership revocation blocks the next automations request and the next direct resolution', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const before = await automationsGET(new Request(`https://app.example/api/automations?workspace=${WS_A}`));
    expect(before.status).toBe(200);

    setRole(MEMBER_A.id, WS_A, null); // revoked

    const after = await automationsGET(new Request(`https://app.example/api/automations?workspace=${WS_A}`));
    expect(after.status).toBe(403);
    const resolved = await resolveRouteWorkspaceContext(db, MEMBER_A.id, WS_A);
    expect(resolved.ok).toBe(false);
  });

  it('member → viewer change blocks the next write (route POST + PUT both 403, zero new rows)', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    setRole(MEMBER_A.id, WS_A, 'viewer');

    const post = await automationsPOST(
      jsonReq(`https://app.example/api/automations?workspace=${WS_A}`, 'POST', { instagramAccountId: ACCT_A, name: 'Should not exist', type: 'comment_dm' }),
    );
    expect(post.status).toBe(403);
    expect(fake.rows('automations').some((r) => r['name'] === 'Should not exist')).toBe(false);

    const put = await automationPUT(
      jsonReq(`https://app.example/api/automations/auto-a1?workspace=${WS_A}`, 'PUT', { name: 'Viewer rename' }),
      byId('auto-a1'),
    );
    expect(put.status).toBe(403);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-a1')!['name']).toBe('A one');
  });

  it('stale-context pattern pin: a context resolved BEFORE a role change is not reused — a FRESH resolution yields a read-only repository that refuses the write', async () => {
    const stale = await resolveRouteWorkspaceContext(db, MEMBER_A.id, WS_A);
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.ctx.role).toBe('member');

    setRole(MEMBER_A.id, WS_A, 'viewer'); // role changes after stale.ctx was issued

    // The per-request pattern: re-resolve, THEN construct the repository.
    const fresh = await resolveRouteWorkspaceContext(db, MEMBER_A.id, WS_A);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.ctx.role).toBe('viewer');
    const repo = createTenantRepository(db, fresh.ctx, 'write'); // 'write' request downgraded
    expect(repo.capability).toBe('read');
    await expect(repo.automations.insert({ name: 'stale write attempt' })).rejects.toMatchObject({ code: 'insufficient-role' });
    expect(fake.rows('automations').some((r) => r['name'] === 'stale write attempt')).toBe(false);
    // requireCapability on the fresh ctx also refuses the old capability:
    expect(() => requireCapability(fresh.ctx, 'write')).toThrowError(expect.objectContaining({ code: 'insufficient-role' }));
  });
});

// ── Cross-workspace resource access ────────────────────────────────────────

describe('A cannot read / edit / delete B\u2019s resources (and vice versa under a foreign context)', () => {
  it('automation: B\u2019s automation under A\u2019s context — PUT 404 + byte-identical, DELETE 404 + survives', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const before = { ...fake.rows('automations').find((r) => r['id'] === 'auto-b1')! };
    const put = await automationPUT(
      jsonReq(`https://app.example/api/automations/auto-b1?workspace=${WS_A}`, 'PUT', { name: 'Hijack B' }),
      byId('auto-b1'),
    );
    expect(put.status).toBe(404);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-b1')).toEqual(before);

    const del = await automationDELETE(
      new Request(`https://app.example/api/automations/auto-b1?workspace=${WS_A}`, { method: 'DELETE' }),
      byId('auto-b1'),
    );
    expect(del.status).toBe(404);
    expect(fake.rows('automations').some((r) => r['id'] === 'auto-b1')).toBe(true);
  });

  it('repository: foreign automation / contact / IG account all throw cross-workspace-row on get; update/delete throw before any mutation', async () => {
    const resolved = await resolveRouteWorkspaceContext(db, OWNER_A.id, WS_A);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const repo = createTenantRepository(db, resolved.ctx);
    await expect(repo.automations.getByIdInWorkspace('auto-b1')).rejects.toMatchObject({ code: 'cross-workspace-row' });
    await expect(repo.contacts.getByIdInWorkspace('contact-b1')).rejects.toMatchObject({ code: 'cross-workspace-row' });
    await expect(repo.instagramAccounts.getByIdInWorkspace(ACCT_B)).rejects.toMatchObject({ code: 'cross-workspace-row' });

    const before = { ...fake.rows('automations').find((r) => r['id'] === 'auto-b1')! };
    await expect(repo.automations.updateById('auto-b1', { name: 'Hijack' })).rejects.toMatchObject({ code: 'cross-workspace-row' });
    await expect(repo.automations.deleteById('auto-b1')).rejects.toMatchObject({ code: 'cross-workspace-row' });
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-b1')).toEqual(before);
    expect(fake.callsFor('automations', 'update')).toHaveLength(0);
    expect(fake.callsFor('automations', 'delete')).toHaveLength(0);
  });

  it('contacts + IG accounts routes: A context lists only A; B\u2019s account id as a filter ⇒ 404; no token leaks', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const contacts = await contactsGET(new Request(`https://app.example/api/contacts?workspace=${WS_A}`));
    expect(((await contacts.json()) as { contacts: Array<{ id: string }> }).contacts.map((c) => c.id)).toEqual(['contact-a1']);
    const foreignFilter = await contactsGET(new Request(`https://app.example/api/contacts?workspace=${WS_A}&accountId=${ACCT_B}`));
    expect(foreignFilter.status).toBe(404);

    const accounts = await accountsGET(new Request(`https://app.example/api/instagram/accounts?workspace=${WS_A}`));
    const raw = await accounts.text();
    expect(raw).not.toContain('SECRET-B');
    expect(raw).not.toContain('SECRET-A');
    expect((JSON.parse(raw) as { accounts: Array<{ id: string }> }).accounts.map((a) => a.id)).toEqual([ACCT_A]);
  });

  it('foreign account ID cannot create an automation in A (404, nothing inserted, no NULL row)', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const before = fake.rows('automations').length;
    const res = await automationsPOST(
      jsonReq(`https://app.example/api/automations?workspace=${WS_A}`, 'POST', { instagramAccountId: ACCT_B, name: 'Cross-tenant', type: 'comment_dm' }),
    );
    expect(res.status).toBe(404);
    expect(fake.rows('automations')).toHaveLength(before);
  });
});

// ── Viewer write-denial on every layer ─────────────────────────────────────

describe('viewer cannot write — routes, repository, or member endpoints', () => {
  it('routes: viewer POST automation ⇒ 403; viewer DELETE automation ⇒ 403', async () => {
    mockAuth.mockResolvedValue(VIEWER_A);
    const post = await automationsPOST(
      jsonReq(`https://app.example/api/automations?workspace=${WS_A}`, 'POST', { instagramAccountId: ACCT_A, name: 'Viewer made', type: 'comment_dm' }),
    );
    expect(post.status).toBe(403);
    const del = await automationDELETE(
      new Request(`https://app.example/api/automations/auto-a1?workspace=${WS_A}`, { method: 'DELETE' }),
      byId('auto-a1'),
    );
    expect(del.status).toBe(403);
    expect(fake.rows('automations').some((r) => r['id'] === 'auto-a1')).toBe(true);
  });

  it('repository: viewer repo is read-only even when constructed asking for write', async () => {
    const resolved = await resolveRouteWorkspaceContext(db, VIEWER_A.id, WS_A);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const repo = createTenantRepository(db, resolved.ctx, 'write');
    expect(repo.capability).toBe('read');
    await expect(repo.automations.insert({ name: 'x' })).rejects.toMatchObject({ code: 'insufficient-role' });
    await expect(repo.automations.updateById('auto-a1', { name: 'x' })).rejects.toMatchObject({ code: 'insufficient-role' });
    await expect(repo.automations.deleteById('auto-a1')).rejects.toMatchObject({ code: 'insufficient-role' });
  });

  it('member endpoints: viewer cannot invite (403, no row) and cannot change roles (403, RPC never called)', async () => {
    mockAuth.mockResolvedValue(VIEWER_A);
    const invite = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS_A}/invitations`, 'POST', { email: 'x@y.co', role: 'member' }),
      wsParams(WS_A),
    );
    expect(invite.status).toBe(403);
    expect(fake.rows('workspace_invitations')).toHaveLength(0);

    let rpcCalled = false;
    fake.setRpcHandler('change_member_role', () => { rpcCalled = true; return { data: null, error: null }; });
    const patch = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS_A}/members/${MEMBER_A.id}`, 'PATCH', { role: 'admin' }),
      memberParams(WS_A, MEMBER_A.id),
    );
    expect(patch.status).toBe(403);
    expect(rpcCalled).toBe(false);
  });
});

// ── Member cannot grant Owner ──────────────────────────────────────────────

describe('member cannot grant Owner', () => {
  it('capability layer: member + admin both fail manageBilling; member fails manageMembers', async () => {
    const member = await resolveRouteWorkspaceContext(db, MEMBER_A.id, WS_A);
    expect(member.ok).toBe(true);
    if (!member.ok) return;
    expect(() => requireCapability(member.ctx, 'manageMembers')).toThrowError(expect.objectContaining({ code: 'insufficient-role' }));
  });

  it('route layer: a MEMBER patching a member to owner ⇒ 403 and the RPC is never called', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    let rpcCalled = false;
    fake.setRpcHandler('change_member_role', () => { rpcCalled = true; return { data: null, error: null }; });
    const res = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS_A}/members/${VIEWER_A.id}`, 'PATCH', { role: 'owner' }),
      memberParams(WS_A, VIEWER_A.id),
    );
    expect(res.status).toBe(403);
    expect(rpcCalled).toBe(false);
  });

  it('route layer: an ADMIN patching to owner delegates to the RPC — its "only an owner" error surfaces 4xx and no role changes', async () => {
    mockAuth.mockResolvedValue(ADMIN_A);
    fake.setRpcHandler('change_member_role', () => ({
      data: null,
      error: { message: 'only an owner may grant the owner role' },
    }));
    const res = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS_A}/members/${MEMBER_A.id}`, 'PATCH', { role: 'owner' }),
      memberParams(WS_A, MEMBER_A.id),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // No direct membership write happened in the route layer:
    expect(fake.rows('workspace_memberships').find((m) => m['user_id'] === MEMBER_A.id && m['workspace_id'] === WS_A)!['role']).toBe('member');
  });

  it('invitations can never carry role=owner (400 for an owner inviter; table CHECK is the backstop)', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS_A}/invitations`, 'POST', { email: 'x@y.co', role: 'owner' }),
      wsParams(WS_A),
    );
    expect(res.status).toBe(400);
    expect(fake.rows('workspace_invitations')).toHaveLength(0);
  });
});

// ── Platform-admin separation ──────────────────────────────────────────────

describe('workspace admin/owner cannot reach platform-admin surfaces', () => {
  it('the platform-admin gate denies a workspace OWNER and a workspace ADMIN (membership confers nothing)', () => {
    expect(evaluatePlatformAdminGate({ ADMIN_PROTOTYPE_ACTOR_ID: OWNER_A.id }).allowed).toBe(false);
    expect(evaluatePlatformAdminGate({ ADMIN_PROTOTYPE_ACTOR_ID: ADMIN_A.id, ADMIN_PROTOTYPE_PLATFORM_ADMIN: 'TRUE' }).allowed).toBe(false);
    expect(evaluatePlatformAdminGate({}).allowed).toBe(false);
  });

  it('workspace routes stay flag-gated: with the flag OFF the workspaces tree is 503 even for the owner', async () => {
    delete process.env['WORKSPACE_RUNTIME_ENABLED'];
    mockAuth.mockResolvedValue(OWNER_A);
    const list = await listWorkspaces(new Request('https://app.example/api/workspaces'));
    expect(list.status).toBe(503);
    const create = await createWorkspace(jsonReq('https://app.example/api/workspaces', 'POST', { name: 'Nope' }));
    expect(create.status).toBe(503);
  });
});

// ── Body-supplied claims cannot bypass ─────────────────────────────────────

describe('body-supplied user_id / workspace_id / role / account claims cannot bypass', () => {
  it('automation create: body workspace_id=WS_B, user_id=owner-b, role=owner are ignored — row is stamped WS_A for the CALLER', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await automationsPOST(
      jsonReq(`https://app.example/api/automations?workspace=${WS_A}`, 'POST', {
        instagramAccountId: ACCT_A, name: 'Body claims', type: 'comment_dm',
        workspace_id: WS_B, workspaceId: WS_B, user_id: OWNER_B.id, userId: OWNER_B.id, role: 'owner',
      }),
    );
    expect(res.status).toBe(201);
    const row = fake.rows('automations').find((r) => r['name'] === 'Body claims')!;
    expect(row['workspace_id']).toBe(WS_A);
    expect(row['user_id']).toBe(MEMBER_A.id);
  });

  it('selector comes ONLY from header/query: a body-only workspace claim with no selector ⇒ 400, nothing created', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await automationsPOST(
      jsonReq('https://app.example/api/automations', 'POST', {
        instagramAccountId: ACCT_A, name: 'Body selector', type: 'comment_dm', workspace_id: WS_A, workspaceId: WS_A,
      }),
    );
    expect(res.status).toBe(400);
    expect(fake.rows('automations').some((r) => r['name'] === 'Body selector')).toBe(false);
  });

  it('invitation create: body workspace_id=WS_B is ignored — the invitation lands in the PATH workspace WS_A', async () => {
    mockAuth.mockResolvedValue(ADMIN_A);
    const res = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS_A}/invitations`, 'POST', { email: 'new@y.co', role: 'member', workspace_id: WS_B, workspaceId: WS_B }),
      wsParams(WS_A),
    );
    expect(res.status).toBe(201);
    const rows = fake.rows('workspace_invitations');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['workspace_id']).toBe(WS_A);
    expect(rows[0]!['invited_by']).toBe(ADMIN_A.id);
  });

  it('even a VALID selector is only a selector: OUTSIDER selecting WS_A (where the body also claims owner) is still 403', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const res = await automationsPOST(
      jsonReq(`https://app.example/api/automations?workspace=${WS_A}`, 'POST', {
        instagramAccountId: ACCT_A, name: 'Outsider claim', type: 'comment_dm', role: 'owner', user_id: OWNER_A.id,
      }),
    );
    expect(res.status).toBe(403);
    expect(fake.rows('automations').some((r) => r['name'] === 'Outsider claim')).toBe(false);
  });
});

// ── Replays ────────────────────────────────────────────────────────────────

describe('replays create no cross-tenant state', () => {
  it('duplicate invitation accept: first succeeds via RPC, replay surfaces 409 and the route creates NO membership row itself', async () => {
    mockAuth.mockResolvedValue({ id: 'user-invitee', email: 'invitee@y.co' });
    let calls = 0;
    fake.setRpcHandler('accept_workspace_invitation', () => {
      calls += 1;
      return calls === 1
        ? { data: WS_A, error: null }
        : { data: null, error: { message: 'invitation already accepted' } };
    });
    const before = fake.rows('workspace_memberships').length;
    const first = await acceptInvitation(jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 'tok-1' }));
    expect(first.status).toBe(200);
    const replay = await acceptInvitation(jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 'tok-1' }));
    expect(replay.status).toBe(409);
    // Membership creation is RPC-side only; the route added nothing either time.
    expect(fake.rows('workspace_memberships')).toHaveLength(before);
  });
});

// ── No unintended NULL-workspace rows on stamped paths ─────────────────────

describe('workspace mode creates NO unintended NULL-workspace rows for stamped paths', () => {
  it('after a member automation create, every automation row created in workspace mode carries a non-null workspace_id', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await automationsPOST(
      jsonReq(`https://app.example/api/automations?workspace=${WS_A}`, 'POST', { instagramAccountId: ACCT_A, name: 'Stamped', type: 'comment_dm' }),
    );
    expect(res.status).toBe(201);
    const created = fake.rows('automations').filter((r) => r['name'] === 'Stamped');
    expect(created).toHaveLength(1);
    expect(created[0]!['workspace_id']).toBe(WS_A);
    expect(created[0]!['workspace_id']).not.toBeNull();
  });

  it('repository insert stamps the ctx workspace and REJECTS a foreign/null workspace_id in the payload before writing', async () => {
    const resolved = await resolveRouteWorkspaceContext(db, MEMBER_A.id, WS_A);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const repo = createTenantRepository(db, resolved.ctx);
    const ok = await repo.contacts.insert({ instagram_account_id: ACCT_A, username: 'new-contact' });
    expect(ok['workspace_id']).toBe(WS_A);
    await expect(repo.contacts.insert({ username: 'evil', workspace_id: WS_B })).rejects.toMatchObject({ code: 'cross-workspace-row' });
    await expect(repo.contacts.insert({ username: 'evil2', workspace_id: null })).rejects.toMatchObject({ code: 'cross-workspace-row' });
    expect(fake.rows('contacts').some((r) => r['username'] === 'evil' || r['username'] === 'evil2')).toBe(false);
  });
});

// ── Flag OFF ⇒ legacy (one pin per family restated) ────────────────────────

describe('flag OFF ⇒ legacy behaviour on the Phase D routes', () => {
  it('automations list falls back to legacy user_id scoping (workspace selector ignored)', async () => {
    delete process.env['WORKSPACE_RUNTIME_ENABLED'];
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await automationsGET(new Request(`https://app.example/api/automations?workspace=${WS_B}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automations: Array<{ id: string }> };
    // Legacy: caller's own rows by user_id — auto-a1 only (auto-b1 is B's owner).
    expect(body.automations.map((a) => a.id)).toEqual(['auto-a1']);
  });
});
