/**
 * Programme 18 / Phase G — workspace route tests
 * (src/app/api/workspaces/**) against the FakeSupabase harness.
 *
 * Pins:
 *  - EVERY new handler: flag OFF ⇒ 503 'workspace-runtime-disabled'
 *    (after authentication — unauthenticated + flag OFF ⇒ 401).
 *  - GET /api/workspaces: creator lists own workspace (name + role).
 *  - GET members: non-member ⇒ 403; viewer (any member) CAN read.
 *  - Invitations: viewer/member ⇒ 403; admin ⇒ 201, raw token returned
 *    once, and ONLY its sha256 hash reaches the db layer.
 *  - PATCH/DELETE members: member ⇒ 403 with the RPC never called;
 *    admin ⇒ RPC called with the exact …000031 argument names; the
 *    last-owner RPC error surfaces as 409.
 *  - Accept: success delegates to the RPC with the raw token; a
 *    replayed token ⇒ 409 and an expired token ⇒ 410, with NO
 *    membership row created by the route on either failure.
 *  - Source pins: the accept route never reads user-editable profile
 *    metadata for the email match (the RPC checks the verified
 *    auth.users email), and token generation uses node:crypto.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
// Programme 19 (F-J1): the four membership RPCs now run through the
// user-JWT factory instead of the service client. The factory mock
// returns the SAME FakeSupabase, so every RPC handler/assertion below
// is unchanged — only the client the RPC arrives on has moved.
vi.mock('@/lib/supabase/userClient', () => ({ createUserRpcClient: vi.fn() }));

import { GET as listWorkspaces, POST as createWorkspace } from '@/app/api/workspaces/route';
import { POST as acceptInvitation } from '@/app/api/workspaces/accept/route';
import { GET as listMembers } from '@/app/api/workspaces/[workspaceId]/members/route';
import { POST as createInvitation } from '@/app/api/workspaces/[workspaceId]/invitations/route';
import {
  PATCH as changeMemberRole,
  DELETE as removeMember,
} from '@/app/api/workspaces/[workspaceId]/members/[userId]/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const WS1 = '11111111-1111-4111-8111-111111111111';
const WS_NEW = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const ADMIN = { id: 'user-admin', email: 'admin@example.com' };
const MEMBER = { id: 'user-member', email: 'member@example.com' };
const VIEWER = { id: 'user-viewer', email: 'viewer@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'outsider@example.com' };

const ORIGINAL_FLAG = process.env['WORKSPACE_RUNTIME_ENABLED'];

function seedMemberships(): void {
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS1, user_id: OWNER.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS1, user_id: ADMIN.id, role: 'admin', created_at: '2026-11-02T00:00:00Z' },
    { workspace_id: WS1, user_id: MEMBER.id, role: 'member', created_at: '2026-11-03T00:00:00Z' },
    { workspace_id: WS1, user_id: VIEWER.id, role: 'viewer', created_at: '2026-11-04T00:00:00Z' },
  ]);
  fake.replaceRows('workspaces', [
    { id: WS1, name: 'Creator Studio', created_by: OWNER.id, created_at: '2026-11-01T00:00:00Z' },
  ]);
  fake.replaceRows('workspace_invitations', []);
}

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}
function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const wsParams = { params: Promise.resolve({ workspaceId: WS1 }) };
const memberParams = { params: Promise.resolve({ workspaceId: WS1, userId: MEMBER.id }) };

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  seedMemberships();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  vi.mocked(createUserRpcClient).mockResolvedValue({
    ok: true,
    client: fake as unknown as SupabaseClient,
  });
  mockAuth.mockReset();
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = ORIGINAL_FLAG;
});

describe('flag gate — every new endpoint is inert while the flag is OFF', () => {
  beforeEach(() => {
    process.env['WORKSPACE_RUNTIME_ENABLED'] = 'false';
    mockAuth.mockResolvedValue(OWNER);
  });

  it('GET /api/workspaces ⇒ 503 workspace-runtime-disabled', async () => {
    const res = await listWorkspaces(req('https://app.example/api/workspaces'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('workspace-runtime-disabled');
  });

  it('POST /api/workspaces ⇒ 503', async () => {
    const res = await createWorkspace(jsonReq('https://app.example/api/workspaces', 'POST', { name: 'X' }));
    expect(res.status).toBe(503);
  });

  it('GET members ⇒ 503', async () => {
    const res = await listMembers(req(`https://app.example/api/workspaces/${WS1}/members`), wsParams);
    expect(res.status).toBe(503);
  });

  it('POST invitations ⇒ 503', async () => {
    const res = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS1}/invitations`, 'POST', { email: 'a@b.co', role: 'member' }),
      wsParams,
    );
    expect(res.status).toBe(503);
  });

  it('POST accept ⇒ 503', async () => {
    const res = await acceptInvitation(jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 't' }));
    expect(res.status).toBe(503);
  });

  it('PATCH member ⇒ 503 and DELETE member ⇒ 503', async () => {
    const patch = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS1}/members/${MEMBER.id}`, 'PATCH', { role: 'admin' }),
      memberParams,
    );
    expect(patch.status).toBe(503);
    const del = await removeMember(
      req(`https://app.example/api/workspaces/${WS1}/members/${MEMBER.id}`, { method: 'DELETE' }),
      memberParams,
    );
    expect(del.status).toBe(503);
  });

  it('authentication comes first: unauthenticated + flag OFF ⇒ 401 (not 503)', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await listWorkspaces(req('https://app.example/api/workspaces'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/workspaces (flag ON)', () => {
  it("lists ONLY the caller's own workspaces, with name + role (creator = owner)", async () => {
    mockAuth.mockResolvedValue(OWNER);
    const res = await listWorkspaces(req('https://app.example/api/workspaces'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: Array<{ workspaceId: string; name: string | null; role: string; created_at: string | null }>;
    };
    expect(body.workspaces).toEqual([
      { id: WS1, workspaceId: WS1, name: 'Creator Studio', role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    ]);
  });

  it('an outsider lists nothing (membership-derived only)', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const res = await listWorkspaces(req('https://app.example/api/workspaces'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspaces: unknown[] }).workspaces).toEqual([]);
  });
});

describe('POST /api/workspaces (flag ON)', () => {
  it('creates via the create_workspace RPC with p_name and returns the new id as owner', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const seen: Array<Record<string, unknown>> = [];
    fake.setRpcHandler('create_workspace', (params) => {
      seen.push(params);
      return { data: WS_NEW, error: null };
    });
    const res = await createWorkspace(jsonReq('https://app.example/api/workspaces', 'POST', { name: '  New Studio  ' }));
    expect(res.status).toBe(201);
    expect(seen).toEqual([{ p_name: 'New Studio' }]);
    const body = (await res.json()) as { workspace: { workspaceId: string; role: string } };
    expect(body.workspace.workspaceId).toBe(WS_NEW);
    expect(body.workspace.role).toBe('owner');
  });

  it('rejects a blank name with 400 and never calls the RPC', async () => {
    mockAuth.mockResolvedValue(OWNER);
    let called = false;
    fake.setRpcHandler('create_workspace', () => {
      called = true;
      return { data: WS_NEW, error: null };
    });
    const res = await createWorkspace(jsonReq('https://app.example/api/workspaces', 'POST', { name: '   ' }));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe('GET /api/workspaces/[workspaceId]/members (flag ON)', () => {
  it('a non-member is denied 403 and receives no member data', async () => {
    mockAuth.mockResolvedValue(OUTSIDER);
    const res = await listMembers(req(`https://app.example/api/workspaces/${WS1}/members`), wsParams);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; members?: unknown };
    expect(body.code).toBe('not-a-member');
    expect(body.members).toBeUndefined();
  });

  it('DECISION: a viewer CAN read the member list (any-member read rule)', async () => {
    mockAuth.mockResolvedValue(VIEWER);
    const res = await listMembers(req(`https://app.example/api/workspaces/${WS1}/members`), wsParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      callerRole: string;
      members: Array<{ userId: string; role: string; joined_at: string; email: unknown }>;
    };
    expect(body.callerRole).toBe('viewer');
    expect(body.members.map((m) => m.userId)).toEqual([OWNER.id, ADMIN.id, MEMBER.id, VIEWER.id]);
    expect(body.members[0]).toMatchObject({ role: 'owner', joined_at: '2026-11-01T00:00:00Z', email: null });
  });
});

describe('POST /api/workspaces/[workspaceId]/invitations (flag ON)', () => {
  it('a viewer cannot invite: 403 and NO invitation row written', async () => {
    mockAuth.mockResolvedValue(VIEWER);
    const res = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS1}/invitations`, 'POST', { email: 'new@example.com', role: 'member' }),
      wsParams,
    );
    expect(res.status).toBe(403);
    expect(fake.rows('workspace_invitations')).toHaveLength(0);
  });

  it('a plain member cannot invite either: 403', async () => {
    mockAuth.mockResolvedValue(MEMBER);
    const res = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS1}/invitations`, 'POST', { email: 'new@example.com', role: 'member' }),
      wsParams,
    );
    expect(res.status).toBe(403);
    expect(fake.rows('workspace_invitations')).toHaveLength(0);
  });

  it('an admin CAN invite: 201, raw token returned once, ONLY its sha256 hash reaches the db', async () => {
    mockAuth.mockResolvedValue(ADMIN);
    const res = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS1}/invitations`, 'POST', { email: 'New@Example.com', role: 'viewer' }),
      wsParams,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      acceptLink: string;
      invitation: { email: string; role: string; workspaceId: string };
    };
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThanOrEqual(32);
    expect(body.acceptLink).toContain(body.token);
    expect(body.invitation).toMatchObject({ email: 'new@example.com', role: 'viewer', workspaceId: WS1 });

    // The db layer saw exactly one insert, carrying the hash — never the raw token.
    const inserts = fake.callsFor('workspace_invitations', 'insert');
    expect(inserts).toHaveLength(1);
    const payload = inserts[0]!.payload as Record<string, unknown>;
    const expectedHash = createHash('sha256').update(body.token).digest('hex');
    expect(payload['token_hash']).toBe(expectedHash);
    expect(payload['workspace_id']).toBe(WS1);
    expect(payload['invited_by']).toBe(ADMIN.id);
    expect(JSON.stringify(payload)).not.toContain(body.token);
    expect(JSON.stringify(fake.rows('workspace_invitations'))).not.toContain(body.token);
  });

  it('inviting with role=owner is rejected 400 (the table CHECK forbids it too)', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const res = await createInvitation(
      jsonReq(`https://app.example/api/workspaces/${WS1}/invitations`, 'POST', { email: 'new@example.com', role: 'owner' }),
      wsParams,
    );
    expect(res.status).toBe(400);
    expect(fake.rows('workspace_invitations')).toHaveLength(0);
  });
});

describe('PATCH / DELETE members (flag ON)', () => {
  it('a member CANNOT change roles: 403 and the change_member_role RPC is never called', async () => {
    mockAuth.mockResolvedValue(MEMBER);
    let rpcCalled = false;
    fake.setRpcHandler('change_member_role', () => {
      rpcCalled = true;
      return { data: null, error: null };
    });
    const res = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS1}/members/${VIEWER.id}`, 'PATCH', { role: 'admin' }),
      { params: Promise.resolve({ workspaceId: WS1, userId: VIEWER.id }) },
    );
    expect(res.status).toBe(403);
    expect(rpcCalled).toBe(false);
  });

  it('an admin CAN change roles: RPC called with the exact …000031 argument names', async () => {
    mockAuth.mockResolvedValue(ADMIN);
    const seen: Array<Record<string, unknown>> = [];
    fake.setRpcHandler('change_member_role', (params) => {
      seen.push(params);
      return { data: null, error: null };
    });
    const res = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS1}/members/${MEMBER.id}`, 'PATCH', { role: 'viewer' }),
      memberParams,
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { p_workspace_id: WS1, p_target_user_id: MEMBER.id, p_new_role: 'viewer' },
    ]);
  });

  it('the last-owner guard is NOT reimplemented — its RPC error surfaces as 409', async () => {
    mockAuth.mockResolvedValue(OWNER);
    fake.setRpcHandler('change_member_role', () => ({
      data: null,
      error: { message: 'cannot demote the last owner of a workspace' },
    }));
    const res = await changeMemberRole(
      jsonReq(`https://app.example/api/workspaces/${WS1}/members/${OWNER.id}`, 'PATCH', { role: 'member' }),
      { params: Promise.resolve({ workspaceId: WS1, userId: OWNER.id }) },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('last owner');
  });

  it('a viewer CANNOT remove members: 403, RPC never called; an admin CAN (exact args)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    fake.setRpcHandler('remove_member', (params) => {
      seen.push(params);
      return { data: null, error: null };
    });
    mockAuth.mockResolvedValue(VIEWER);
    const denied = await removeMember(
      req(`https://app.example/api/workspaces/${WS1}/members/${MEMBER.id}`, { method: 'DELETE' }),
      memberParams,
    );
    expect(denied.status).toBe(403);
    expect(seen).toEqual([]);

    mockAuth.mockResolvedValue(ADMIN);
    const ok = await removeMember(
      req(`https://app.example/api/workspaces/${WS1}/members/${MEMBER.id}`, { method: 'DELETE' }),
      memberParams,
    );
    expect(ok.status).toBe(200);
    expect(seen).toEqual([{ p_workspace_id: WS1, p_target_user_id: MEMBER.id }]);
  });
});

describe('POST /api/workspaces/accept (flag ON)', () => {
  it('delegates to accept_workspace_invitation with the raw token and returns the workspace id', async () => {
    mockAuth.mockResolvedValue({ id: 'user-invitee', email: 'new@example.com' });
    const seen: Array<Record<string, unknown>> = [];
    fake.setRpcHandler('accept_workspace_invitation', (params) => {
      seen.push(params);
      return { data: WS1, error: null };
    });
    const res = await acceptInvitation(
      jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 'raw-token-abc' }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ p_token: 'raw-token-abc' }]);
    expect(((await res.json()) as { workspaceId: string }).workspaceId).toBe(WS1);
  });

  it('a REPLAYED token surfaces the RPC error as 409 and creates NO membership', async () => {
    mockAuth.mockResolvedValue({ id: 'user-invitee', email: 'new@example.com' });
    fake.setRpcHandler('accept_workspace_invitation', () => ({
      data: null,
      error: { message: 'invitation already accepted' },
    }));
    const before = fake.rows('workspace_memberships').length;
    const res = await acceptInvitation(
      jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 'raw-token-abc' }),
    );
    expect(res.status).toBe(409);
    expect(fake.rows('workspace_memberships')).toHaveLength(before);
  });

  it('an EXPIRED token surfaces as 410 and a mismatched email as 403 — both 4xx, no membership', async () => {
    mockAuth.mockResolvedValue({ id: 'user-invitee', email: 'other@example.com' });
    fake.setRpcHandler('accept_workspace_invitation', () => ({
      data: null,
      error: { message: 'invitation expired' },
    }));
    const expired = await acceptInvitation(
      jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 'old-token' }),
    );
    expect(expired.status).toBe(410);

    fake.setRpcHandler('accept_workspace_invitation', () => ({
      data: null,
      error: { message: 'invitation email does not match the signed-in account' },
    }));
    const mismatched = await acceptInvitation(
      jsonReq('https://app.example/api/workspaces/accept', 'POST', { token: 'some-token' }),
    );
    expect(mismatched.status).toBe(403);
    expect(fake.rows('workspace_memberships')).toHaveLength(4);
  });

  it('a missing token is 400 and the RPC is never called', async () => {
    mockAuth.mockResolvedValue({ id: 'user-invitee', email: 'new@example.com' });
    let called = false;
    fake.setRpcHandler('accept_workspace_invitation', () => {
      called = true;
      return { data: WS1, error: null };
    });
    const res = await acceptInvitation(jsonReq('https://app.example/api/workspaces/accept', 'POST', {}));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe('source pins (Phase G)', () => {
  const readSrc = (rel: string): string =>
    readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

  it('the accept route NEVER reads user-editable profile metadata for the email match', () => {
    const src = readSrc('app/api/workspaces/accept/route.ts');
    expect(src).not.toContain('raw_user_meta_data');
    expect(src).not.toContain('user_metadata');
    // The verified-email enforcement lives in the RPC; the route only delegates.
    expect(src).toContain('accept_workspace_invitation');
  });

  it('token generation uses node:crypto randomBytes; no new Phase G file uses a predictable PRNG', () => {
    const shared = readSrc('app/api/workspaces/workspaceShared.ts');
    expect(shared).toContain("from 'node:crypto'");
    expect(shared).toContain('randomBytes');
    expect(shared).toContain('createHash');
    const newFiles = [
      'app/api/workspaces/workspaceShared.ts',
      'app/api/workspaces/route.ts',
      'app/api/workspaces/accept/route.ts',
      'app/api/workspaces/[workspaceId]/members/route.ts',
      'app/api/workspaces/[workspaceId]/invitations/route.ts',
      'app/api/workspaces/[workspaceId]/members/[userId]/route.ts',
      'components/workspace/WorkspaceProvider.tsx',
      'components/workspace/WorkspaceSwitcher.tsx',
      'components/workspace/WorkspaceMembers.tsx',
    ];
    for (const rel of newFiles) {
      expect(readSrc(rel), rel).not.toContain('Math.random');
    }
  });
});
