/**
 * Programme 30 / AA-6 — the members route and the workspaces GET no
 * longer read through the service-role client.
 *
 * Register item AA-6 (from PHASE_19_OWNER_DECISIONS residual items +
 * PHASE_19_MEMBERSHIP_RPC_SECURITY_REPORT §3): the members route and
 * the workspaces GET still used the service client for READ-ONLY
 * context/list operations with their own verified checks. The plan
 * was to move those reads onto user-scoped clients where RLS permits
 * — …000024 permits exactly these reads for a member
 * (memberships_select_member: a member may read the membership rows
 * of their own workspaces; workspaces_select_member: a member may
 * read their workspaces' rows) — or record a keep-decision. This
 * suite is the migration evidence; no keep-decision was needed.
 *
 * Harness: TWO distinct FakeSupabase instances (the p19 pattern).
 * `userFake` (returned by the mocked user-JWT factory) carries the
 * real world. `serviceFake` (returned by the mocked service factory)
 * carries a DECOY world and records every call: if any read in these
 * routes regressed to the service role, the response would contain
 * decoy data AND `serviceFake.calls` would be non-empty AND the
 * `createServiceClient` mock would have been invoked. All three
 * signals are asserted.
 *
 * Behaviour preservation is pinned against the same expectations the
 * p18/p19 suites assert (same statuses, same response shapes, same
 * RPC arguments) — the only intentional delta is the factory-failure
 * surface on the read paths, pinned explicitly in the last test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase } from './helpers/fakeSupabase';

const serviceFake = new FakeSupabase();
const userFake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/supabase/userClient', () => ({ createUserRpcClient: vi.fn() }));

import { GET as listWorkspaces } from '@/app/api/workspaces/route';
import { GET as listMembers } from '@/app/api/workspaces/[workspaceId]/members/route';
import {
  PATCH as changeMemberRole,
  DELETE as removeMember,
} from '@/app/api/workspaces/[workspaceId]/members/[userId]/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockServiceFactory = vi.mocked(createServiceClient);
const mockFactory = vi.mocked(createUserRpcClient);

const WS1 = '11111111-1111-4111-8111-111111111111';
const WS_DECOY = '99999999-9999-4999-8999-999999999999';
const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const ADMIN = { id: 'user-admin', email: 'admin@example.com' };
const MEMBER = { id: 'user-member', email: 'member@example.com' };
const VIEWER = { id: 'user-viewer', email: 'viewer@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'outsider@example.com' };

const ORIGINAL_FLAG = process.env['WORKSPACE_RUNTIME_ENABLED'];

const REAL_MEMBERSHIPS = [
  { workspace_id: WS1, user_id: OWNER.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
  { workspace_id: WS1, user_id: ADMIN.id, role: 'admin', created_at: '2026-11-02T00:00:00Z' },
  { workspace_id: WS1, user_id: MEMBER.id, role: 'member', created_at: '2026-11-03T00:00:00Z' },
  { workspace_id: WS1, user_id: VIEWER.id, role: 'viewer', created_at: '2026-11-04T00:00:00Z' },
];

function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const wsParams = { params: Promise.resolve({ workspaceId: WS1 }) };
const memberParams = (userId: string) => ({
  params: Promise.resolve({ workspaceId: WS1, userId }),
});

/** The service role must stay completely untouched by these routes. */
function expectServiceRoleUntouched(): void {
  expect(mockServiceFactory, 'createServiceClient must never be constructed').not.toHaveBeenCalled();
  expect(serviceFake.calls, 'no table call may land on the service fake').toEqual([]);
}

beforeEach(() => {
  serviceFake.calls.length = 0;
  userFake.calls.length = 0;
  serviceFake.clearRpcHandlers();
  userFake.clearRpcHandlers();
  // The real world lives ONLY on the user fake.
  userFake.replaceRows('workspace_memberships', REAL_MEMBERSHIPS);
  userFake.replaceRows('workspaces', [
    { id: WS1, name: 'Creator Studio', created_by: OWNER.id, created_at: '2026-11-01T00:00:00Z' },
  ]);
  // The decoy world lives ONLY on the service fake: a regression to
  // the service role would surface decoy data in the response.
  serviceFake.replaceRows('workspace_memberships', [
    { workspace_id: WS_DECOY, user_id: OWNER.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
  ]);
  serviceFake.replaceRows('workspaces', [
    { id: WS_DECOY, name: 'DECOY — service-role world', created_by: OWNER.id, created_at: '2026-11-01T00:00:00Z' },
  ]);
  mockServiceFactory.mockClear();
  mockServiceFactory.mockImplementation(() => serviceFake as unknown as SupabaseClient);
  mockFactory.mockReset();
  mockFactory.mockResolvedValue({ ok: true, client: userFake as unknown as SupabaseClient });
  mockAuth.mockReset();
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = ORIGINAL_FLAG;
});

describe('AA-6: workspaces GET reads through the user client', () => {
  it('GET /api/workspaces (owner) ⇒ 200 with the real workspace; every read landed on the user fake', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const res = await listWorkspaces(new Request('https://app.example/api/workspaces'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<Record<string, unknown>> };
    expect(body.workspaces).toEqual([
      {
        id: WS1,
        workspaceId: WS1,
        name: 'Creator Studio',
        role: 'owner',
        created_at: '2026-11-01T00:00:00Z',
      },
    ]);
    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(mockFactory.mock.calls[0]![1]).toBe(OWNER.id);
    expect(userFake.callsFor('workspace_memberships', 'select').length).toBeGreaterThan(0);
    expect(userFake.callsFor('workspaces', 'select').length).toBeGreaterThan(0);
    expectServiceRoleUntouched();
  });

  it('GET /api/workspaces (outsider, no memberships) ⇒ 200 with an empty list — behaviour preserved', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const res = await listWorkspaces(new Request('https://app.example/api/workspaces'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: unknown[] };
    expect(body.workspaces).toEqual([]);
    expectServiceRoleUntouched();
  });
});

describe('AA-6: members GET resolves + lists through the user client', () => {
  it('GET members (viewer) ⇒ 200 with all four members and callerRole viewer', async () => {
    mockAuth.mockResolvedValue(VIEWER);
    const res = await listMembers(new Request(`https://app.example/api/workspaces/${WS1}/members`), wsParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      callerRole: string;
      members: Array<Record<string, unknown>>;
    };
    expect(body.workspaceId).toBe(WS1);
    expect(body.callerRole).toBe('viewer');
    expect(body.members.map((m) => m['userId'])).toEqual([OWNER.id, ADMIN.id, MEMBER.id, VIEWER.id]);
    expectServiceRoleUntouched();
  });

  it('GET members (outsider) ⇒ 403 not-a-member, no member data — the RLS-invisible outcome matches the service-era outcome', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const res = await listMembers(new Request(`https://app.example/api/workspaces/${WS1}/members`), wsParams);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; members?: unknown };
    expect(body.members).toBeUndefined();
    expectServiceRoleUntouched();
  });
});

describe('AA-6: members/[userId] resolves context on the same user client that runs the RPC', () => {
  it('PATCH (admin) ⇒ 200; resolution + RPC both on the user fake; service role untouched', async () => {
    mockAuth.mockResolvedValue(ADMIN);
    const seen: Array<Record<string, unknown>> = [];
    userFake.setRpcHandler('change_member_role', (params) => {
      seen.push(params);
      return { data: null, error: null };
    });
    const res = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS1}/members/${MEMBER.id}`, 'PATCH', { role: 'viewer' }),
      memberParams(MEMBER.id),
    );
    expect(res.status).toBe(200);
    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ p_workspace_id: WS1, p_target_user_id: MEMBER.id, p_new_role: 'viewer' }]);
    expect(userFake.callsFor('workspace_memberships', 'select').length).toBeGreaterThan(0);
    expectServiceRoleUntouched();
  });

  it('DELETE (member, non-manager) ⇒ 403; the RPC never runs; service role untouched', async () => {
    mockAuth.mockResolvedValue(MEMBER);
    let userRpcCalled = false;
    userFake.setRpcHandler('remove_member', () => {
      userRpcCalled = true;
      return { data: null, error: null };
    });
    const res = await removeMember(
      new Request(`https://app.example/api/workspaces/${WS1}/members/${OWNER.id}`, { method: 'DELETE' }),
      memberParams(OWNER.id),
    );
    expect(res.status).toBe(403);
    expect(userRpcCalled).toBe(false);
    expectServiceRoleUntouched();
  });
});

describe('AA-6: the one intentional behaviour delta, pinned', () => {
  it('factory failure on the GET list path ⇒ the route fails closed with the factory status (the read path now depends on the user-client factory, as the RPC paths already did)', async () => {
    mockAuth.mockResolvedValue(OWNER);
    mockFactory.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'Workspace authentication is unavailable',
    });
    const res = await listWorkspaces(new Request('https://app.example/api/workspaces'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Workspace authentication is unavailable');
    expectServiceRoleUntouched();
  });
});

describe('AA-6: source pins', () => {
  const SRC_ROOT = path.resolve(process.cwd(), 'src');
  const readSrc = (rel: string): string => readFileSync(path.join(SRC_ROOT, rel), 'utf8');
  const FILES = [
    'app/api/workspaces/route.ts',
    'app/api/workspaces/[workspaceId]/members/route.ts',
    'app/api/workspaces/[workspaceId]/members/[userId]/route.ts',
  ];

  it('none of the three migrated files references the service client any more; each builds its read client via the factory', () => {
    for (const rel of FILES) {
      const src = readSrc(rel);
      expect(src, rel).not.toContain('createServiceClient');
      expect(src, rel).not.toContain('@/lib/supabase/service');
      expect(src, rel).toContain('createUserRpcClient(request, user.id)');
    }
  });
});
