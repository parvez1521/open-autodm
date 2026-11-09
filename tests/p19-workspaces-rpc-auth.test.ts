/**
 * Programme 19 / F-J1 — route-level RPC authorization + source pins.
 *
 * The workspace routes are run against TWO distinct FakeSupabase
 * instances: `serviceFake` (returned by the mocked service factory —
 * used for membership-context resolution and the GET list) and
 * `userFake` (returned by the mocked user-JWT factory). A membership
 * RPC landing on the service fake is the F-J1 defect; these tests
 * prove every one of the four …000031 RPCs now arrives ONLY on the
 * user fake, with the factory invoked for the already-authenticated
 * route user, and that the pre-RPC authorization sequence is
 * unchanged (a non-manageMembers member gets 403 with the factory
 * never even consulted, and rpcErrorResponse mapping is preserved).
 *
 * AMENDMENT (Programme 30 / AA-6, 2026-11-07): the read-only
 * service-client uses this file originally relied on — membership-
 * context resolution in the members routes and the workspaces GET
 * list — now run through the user-JWT factory as well, so
 * `serviceFake` is seeded but expected to receive NO calls from
 * these routes, and `userFake` is seeded with the membership rows
 * resolution now reads. One sequencing consequence, recorded
 * deliberately: in members/[userId] the factory is now consulted
 * BEFORE the capability check (it builds the client the resolution
 * reads through), so the two non-manager tests below assert the
 * preserved safety property — 403, factory consulted exactly once
 * for client construction, and ZERO RPC invocations on either
 * client — instead of the P19-era "factory never consulted"
 * assertion. The capability gate still precedes every RPC.
 *
 * Source pins follow tests/p18-guard-usage-pin.test.ts style.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

import { POST as createWorkspace } from '@/app/api/workspaces/route';
import { POST as acceptInvitation } from '@/app/api/workspaces/accept/route';
import {
  PATCH as changeMemberRole,
  DELETE as removeMember,
} from '@/app/api/workspaces/[workspaceId]/members/[userId]/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockFactory = vi.mocked(createUserRpcClient);

const WS1 = '11111111-1111-4111-8111-111111111111';
const WS_NEW = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const ADMIN = { id: 'user-admin', email: 'admin@example.com' };
const MEMBER = { id: 'user-member', email: 'member@example.com' };
const INVITEE = { id: 'user-invitee', email: 'new@example.com' };

const ORIGINAL_FLAG = process.env['WORKSPACE_RUNTIME_ENABLED'];

function jsonReq(url: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const memberParams = (userId: string) => ({
  params: Promise.resolve({ workspaceId: WS1, userId }),
});

/** Service-fake RPC tripwire: records any membership RPC that (wrongly) arrives here. */
const serviceRpcCalls: string[] = [];

beforeEach(() => {
  serviceFake.calls.length = 0;
  userFake.calls.length = 0;
  serviceFake.clearRpcHandlers();
  userFake.clearRpcHandlers();
  serviceRpcCalls.length = 0;
  serviceFake.replaceRows('workspace_memberships', [
    { workspace_id: WS1, user_id: OWNER.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS1, user_id: ADMIN.id, role: 'admin', created_at: '2026-11-02T00:00:00Z' },
    { workspace_id: WS1, user_id: MEMBER.id, role: 'member', created_at: '2026-11-03T00:00:00Z' },
  ]);
  serviceFake.replaceRows('workspaces', [
    { id: WS1, name: 'Creator Studio', created_by: OWNER.id, created_at: '2026-11-01T00:00:00Z' },
  ]);
  // Programme 30 (AA-6): context resolution reads through the USER
  // fake now — seed it with the same world the service fake carried.
  userFake.replaceRows('workspace_memberships', [
    { workspace_id: WS1, user_id: OWNER.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS1, user_id: ADMIN.id, role: 'admin', created_at: '2026-11-02T00:00:00Z' },
    { workspace_id: WS1, user_id: MEMBER.id, role: 'member', created_at: '2026-11-03T00:00:00Z' },
  ]);
  userFake.replaceRows('workspaces', [
    { id: WS1, name: 'Creator Studio', created_by: OWNER.id, created_at: '2026-11-01T00:00:00Z' },
  ]);
  for (const rpc of ['create_workspace', 'accept_workspace_invitation', 'change_member_role', 'remove_member']) {
    serviceFake.setRpcHandler(rpc, () => {
      serviceRpcCalls.push(rpc);
      return { data: null, error: { message: 'service-role RPC must never be called (F-J1)' } };
    });
  }
  vi.mocked(createServiceClient).mockImplementation(() => serviceFake as unknown as SupabaseClient);
  mockFactory.mockReset();
  mockFactory.mockResolvedValue({ ok: true, client: userFake as unknown as SupabaseClient });
  mockAuth.mockReset();
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = ORIGINAL_FLAG;
});

describe('route-level: membership RPCs run through the user client only', () => {
  it('create_workspace: factory is invoked for the authenticated actor; RPC lands on the user client, NOT the service client', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const seen: Array<Record<string, unknown>> = [];
    userFake.setRpcHandler('create_workspace', (params) => {
      seen.push(params);
      return { data: WS_NEW, error: null };
    });
    const res = await createWorkspace(jsonReq('https://app.example/api/workspaces', 'POST', { name: 'New Studio' }));
    expect(res.status).toBe(201);
    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(mockFactory.mock.calls[0]![1]).toBe(OWNER.id);
    expect(seen).toEqual([{ p_name: 'New Studio' }]);
    expect(serviceRpcCalls).toEqual([]);
  });

  it('accept: uses the authenticated identity; RPC lands on the user client, NOT the service client', async () => {
    mockAuth.mockResolvedValue(INVITEE);
    const seen: Array<Record<string, unknown>> = [];
    userFake.setRpcHandler('accept_workspace_invitation', (params) => {
      seen.push(params);
      return { data: WS1, error: null };
    });
    const res = await acceptInvitation(
      jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 'raw-token-abc' }),
    );
    expect(res.status).toBe(200);
    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(mockFactory.mock.calls[0]![1]).toBe(INVITEE.id);
    expect(seen).toEqual([{ p_token: 'raw-token-abc' }]);
    expect(serviceRpcCalls).toEqual([]);
  });

  it('change_member_role (admin): RPC lands on the user client with exact …000031 args; context resolves on the user client too (P30/AA-6: service client not used by this route)', async () => {
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
    expect(mockFactory.mock.calls[0]![1]).toBe(ADMIN.id);
    expect(seen).toEqual([{ p_workspace_id: WS1, p_target_user_id: MEMBER.id, p_new_role: 'viewer' }]);
    expect(serviceRpcCalls).toEqual([]);
    // P30/AA-6: not even a table read landed on the service fake.
    expect(serviceFake.calls).toEqual([]);
  });

  it('remove_member (admin): RPC lands on the user client; service client never receives it', async () => {
    mockAuth.mockResolvedValue(ADMIN);
    const seen: Array<Record<string, unknown>> = [];
    userFake.setRpcHandler('remove_member', (params) => {
      seen.push(params);
      return { data: null, error: null };
    });
    const res = await removeMember(
      new Request(`https://app.example/api/workspaces/${WS1}/members/${MEMBER.id}`, { method: 'DELETE' }),
      memberParams(MEMBER.id),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ p_workspace_id: WS1, p_target_user_id: MEMBER.id }]);
    expect(serviceRpcCalls).toEqual([]);
  });

  it('a member (non-manageMembers) PATCH ⇒ 403, RPC never called on either client (P30/AA-6: factory consulted once for the resolution client — see header amendment)', async () => {
    mockAuth.mockResolvedValue(MEMBER);
    let userRpcCalled = false;
    userFake.setRpcHandler('change_member_role', () => {
      userRpcCalled = true;
      return { data: null, error: null };
    });
    const res = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS1}/members/${OWNER.id}`, 'PATCH', { role: 'admin' }),
      memberParams(OWNER.id),
    );
    expect(res.status).toBe(403);
    // P30/AA-6 pin change (dated, see header): the factory now builds
    // the client the context resolution reads through, so it IS
    // consulted — exactly once, for the authenticated member — while
    // the safety property is unchanged: the capability gate fires
    // before any RPC, and no RPC runs on either client.
    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(mockFactory.mock.calls[0]![1]).toBe(MEMBER.id);
    expect(userRpcCalled).toBe(false);
    expect(serviceRpcCalls).toEqual([]);
    expect(serviceFake.calls).toEqual([]);
  });

  it('a member (non-manageMembers) DELETE ⇒ 403, RPC never called (P30/AA-6: factory consulted once for the resolution client)', async () => {
    mockAuth.mockResolvedValue(MEMBER);
    const res = await removeMember(
      new Request(`https://app.example/api/workspaces/${WS1}/members/${OWNER.id}`, { method: 'DELETE' }),
      memberParams(OWNER.id),
    );
    expect(res.status).toBe(403);
    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(serviceRpcCalls).toEqual([]);
    expect(serviceFake.calls).toEqual([]);
  });

  it('factory failure (identity cannot be re-verified) ⇒ route fails closed with the factory status and the RPC is never called', async () => {
    mockAuth.mockResolvedValue(OWNER);
    mockFactory.mockResolvedValue({
      ok: false,
      status: 401,
      error: 'Authentication required for this workspace operation',
    });
    let userRpcCalled = false;
    userFake.setRpcHandler('create_workspace', () => {
      userRpcCalled = true;
      return { data: WS_NEW, error: null };
    });
    const res = await createWorkspace(jsonReq('https://app.example/api/workspaces', 'POST', { name: 'X' }));
    expect(res.status).toBe(401);
    expect(userRpcCalled).toBe(false);
    expect(serviceRpcCalls).toEqual([]);
  });

  it("rpcErrorResponse mapping preserved: 'cannot remove the last owner…' from the user-client RPC ⇒ 409", async () => {
    mockAuth.mockResolvedValue(OWNER);
    userFake.setRpcHandler('remove_member', () => ({
      data: null,
      error: { message: 'cannot remove the last owner of a workspace' },
    }));
    const res = await removeMember(
      new Request(`https://app.example/api/workspaces/${WS1}/members/${OWNER.id}`, { method: 'DELETE' }),
      memberParams(OWNER.id),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('last owner');
    expect(serviceRpcCalls).toEqual([]);
  });

  it('no credential appears in log output during a route flow', async () => {
    mockAuth.mockResolvedValue(OWNER);
    userFake.setRpcHandler('create_workspace', () => ({ data: WS_NEW, error: null }));
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '));
      }),
    );
    try {
      const res = await createWorkspace(
        jsonReq('https://app.example/api/workspaces', 'POST', { name: 'Studio' }, {
          authorization: 'Bearer route-secret-token-xyz',
        }),
      );
      expect(res.status).toBe(201);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain('route-secret-token-xyz');
  });
});

describe('source pins: no service-role membership RPC remains', () => {
  const SRC_ROOT = path.resolve(process.cwd(), 'src');
  const readSrc = (rel: string): string => readFileSync(path.join(SRC_ROOT, rel), 'utf8');
  const MEMBERSHIP_RPCS = ['create_workspace', 'accept_workspace_invitation', 'change_member_role', 'remove_member'];

  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectSourceFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('every membership-RPC invocation in src/ lives in a file that builds its client via the user-JWT factory', () => {
    const invocations: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const rpc of MEMBERSHIP_RPCS) {
        if (new RegExp(`\\.rpc\\(\\s*['"]${rpc}['"]`).test(src)) {
          invocations.push(`${path.relative(SRC_ROOT, file).replace(/\\/g, '/')} → ${rpc}`);
          expect(src, file).toContain('createUserRpcClient');
        }
      }
    }
    expect(invocations.sort()).toEqual([
      'app/api/workspaces/[workspaceId]/members/[userId]/route.ts → change_member_role',
      'app/api/workspaces/[workspaceId]/members/[userId]/route.ts → remove_member',
      'app/api/workspaces/accept/route.ts → accept_workspace_invitation',
      'app/api/workspaces/route.ts → create_workspace',
    ]);
  });

  it('workspaces POST: the create_workspace receiver is the factory client (handler-scoped: POST never builds a service client)', () => {
    const src = readSrc('app/api/workspaces/route.ts');
    const post = src.slice(src.indexOf('export async function POST'));
    expect(post).toContain('createUserRpcClient(request, user.id)');
    expect(post).toContain('const db = rpcClient.client;');
    expect(post).toContain("db.rpc('create_workspace'");
    expect(post).not.toContain('createServiceClient');
    // P30/AA-6 pin change (dated): GET no longer keeps the service
    // client — the membership-derived list + enrichment read through
    // the factory client too, so the whole file is service-free.
    const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
    expect(get).toContain('createUserRpcClient(request, user.id)');
    expect(get).toContain('const db = rpcClient.client;');
    expect(get).toContain('listUserWorkspaces(db, user.id)');
    expect(src).not.toContain('createServiceClient');
    expect(src).not.toContain('@/lib/supabase/service');
  });

  it('accept route: the RPC receiver is the factory client; service client only for the flag-gated entitlement gate (2026-11-09 exception)', () => {
    const src = readSrc('app/api/workspaces/accept/route.ts');
    // P19 invariant, unchanged: the membership-writing RPC runs
    // through the caller's user-JWT client — never the service role.
    expect(src).toContain('createUserRpcClient(request, user.id)');
    expect(src).toContain('const db = rpcClient.client;');
    expect(src).toContain("db.rpc('accept_workspace_invitation'");
    // Dated exception (2026-11-09, trial/workspace farming fix): the
    // route DOES now construct a service client, for exactly one
    // purpose — the ENTITLEMENTS_ENFORCED-gated, read-only teamSeats
    // check BEFORE the RPC. The invitation-by-token-hash lookup is
    // impossible on the user client (the invitee is not yet a member;
    // RLS invitations_select_owner_admin), and the queries run only
    // inside the gate's context thunk (flag off ⇒ never executed).
    // Classified as a reviewed exception in
    // tests/p17-service-role-pins.test.ts.
    expect(src).toContain('evaluateEntitlementGate');
    expect(src).toContain('hashInvitationToken(token)');
  });

  it('members/[userId] route: both RPCs run on rpcClient.client; context resolves on that same user client (P30/AA-6: no service client remains)', () => {
    const src = readSrc('app/api/workspaces/[workspaceId]/members/[userId]/route.ts');
    expect(src).toContain("rpcClient.client.rpc('change_member_role'");
    expect(src).toContain("rpcClient.client.rpc('remove_member'");
    expect(src).not.toContain("db.rpc('change_member_role'");
    expect(src).not.toContain("db.rpc('remove_member'");
    // P30/AA-6 pin change (dated): the P19-era assertion that the
    // service client is still constructed here (for resolution) is
    // inverted — resolution now runs on the factory client
    // (`const db = rpcClient.client`), and no service client remains.
    expect(src).not.toContain('createServiceClient');
    expect(src).not.toContain('@/lib/supabase/service');
    expect(src).toContain('resolveRouteWorkspaceContext(db, user.id, workspaceId)');
    expect(src).toContain("requireCapability(resolved.ctx, 'manageMembers')");
    expect(src.match(/createUserRpcClient\(request, user\.id\)/g)).toHaveLength(2);
  });

  it('factory hygiene pin: userClient.ts carries no service-role reference and no logging', () => {
    const src = readSrc('lib/supabase/userClient.ts');
    expect(src).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(src).not.toContain('createServiceClient');
    expect(src).not.toContain('console.');
    expect(src).toContain('auth.uid()');
    expect(src).toContain('NEVER falls');
  });
});
