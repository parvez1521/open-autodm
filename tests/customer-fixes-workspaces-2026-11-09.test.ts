/**
 * Customer-journey fixes (2026-11-09) — item A: trial/workspace
 * farming gates on the workspace routes.
 *
 * Pins (all behind ENTITLEMENTS_ENFORCED; flag OFF ⇒ byte-identical
 * legacy behaviour, which the p18 suite already covers):
 *  - POST /api/workspaces refuses a second workspace for a Free-plan
 *    owner (403 PLAN_LIMIT_REACHED, dimension workspaces) and never
 *    calls the create_workspace RPC; a user with NO workspaces can
 *    still create their first (auto-provisioning keeps working).
 *  - POST invitations refuses when the workspace is at its plan's
 *    teamSeats limit (usage = current member count).
 *  - POST /api/workspaces/accept refuses BEFORE the accept RPC when
 *    the target workspace is at its seat limit; an unknown token
 *    resolves no live invitation, so the request still reaches the
 *    RPC and its faithful error mapping (no behaviour change).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/supabase/userClient', () => ({ createUserRpcClient: vi.fn() }));

import { POST as createWorkspace } from '@/app/api/workspaces/route';
import { POST as acceptInvitation } from '@/app/api/workspaces/accept/route';
import { POST as createInvitation } from '@/app/api/workspaces/[workspaceId]/invitations/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const createRpcCalls = { count: 0 };

const WS1 = '11111111-1111-4111-8111-111111111111';
const WS_NEW = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const NEWCOMER = { id: 'user-new', email: 'new@example.com' };
const INVITEE = { id: 'user-invitee', email: 'invitee@example.com' };

const FUTURE = '2027-01-01T00:00:00Z';
const RAW_TOKEN = 'raw-invite-token-0123456789abcdef';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

const SAVED = {
  runtime: process.env['WORKSPACE_RUNTIME_ENABLED'],
  enforced: process.env['ENTITLEMENTS_ENFORCED'],
};

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seedFreeWorkspaceWithFourMembers(): void {
  fake.replaceRows('workspaces', [
    { id: WS1, name: 'Creator Studio', created_by: OWNER.id, created_at: '2026-11-01T00:00:00Z' },
  ]);
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS1, user_id: OWNER.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS1, user_id: 'user-admin', role: 'admin', created_at: '2026-11-02T00:00:00Z' },
    { workspace_id: WS1, user_id: 'user-member', role: 'member', created_at: '2026-11-03T00:00:00Z' },
    { workspace_id: WS1, user_id: 'user-viewer', role: 'viewer', created_at: '2026-11-04T00:00:00Z' },
  ]);
  fake.replaceRows('subscriptions', []);
  fake.replaceRows('workspace_invitations', []);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  seedFreeWorkspaceWithFourMembers();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  vi.mocked(createUserRpcClient).mockResolvedValue({
    ok: true,
    client: fake as unknown as SupabaseClient,
  });
  mockAuth.mockReset();
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  delete process.env['ENTITLEMENTS_ENFORCED'];
  createRpcCalls.count = 0;
  fake.setRpcHandler('create_workspace', () => {
    createRpcCalls.count += 1;
    return { data: WS_NEW, error: null };
  });
});

afterEach(() => {
  if (SAVED.runtime === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = SAVED.runtime;
  if (SAVED.enforced === undefined) delete process.env['ENTITLEMENTS_ENFORCED'];
  else process.env['ENTITLEMENTS_ENFORCED'] = SAVED.enforced;
});

describe('A1 — POST /api/workspaces gated on the workspaces dimension', () => {
  it('flag ON: a Free-plan owner of one workspace is refused a second (403, RPC never called)', async () => {
    process.env['ENTITLEMENTS_ENFORCED'] = 'true';
    mockAuth.mockResolvedValue(OWNER);
    const res = await createWorkspace(jsonReq('https://app.opendm.in/api/workspaces', { name: 'Second' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; dimension: string; limit: number };
    expect(body.code).toBe('PLAN_LIMIT_REACHED');
    expect(body.dimension).toBe('workspaces');
    expect(body.limit).toBe(1);
    expect(createRpcCalls.count).toBe(0);
  });

  it('flag ON: a user with NO workspaces can still create their first (auto-provision path)', async () => {
    process.env['ENTITLEMENTS_ENFORCED'] = 'true';
    mockAuth.mockResolvedValue(NEWCOMER);
    const res = await createWorkspace(jsonReq('https://app.opendm.in/api/workspaces', { name: 'First' }));
    expect(res.status).toBe(201);
    expect(createRpcCalls.count).toBe(1);
  });

  it('flag OFF: the same Free-plan owner creates a second workspace exactly as before', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const res = await createWorkspace(jsonReq('https://app.opendm.in/api/workspaces', { name: 'Second' }));
    expect(res.status).toBe(201);
  });
});

describe('A2 — POST invitations gated on the teamSeats dimension', () => {
  const params = { params: Promise.resolve({ workspaceId: WS1 }) };

  it('flag ON: inviting into a 4-member Free workspace (1 seat) is refused before any insert', async () => {
    process.env['ENTITLEMENTS_ENFORCED'] = 'true';
    mockAuth.mockResolvedValue(OWNER);
    const res = await createInvitation(
      jsonReq('https://app.opendm.in/api/workspaces/x/invitations', { email: 'invitee@example.com', role: 'member' }),
      params,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; dimension: string };
    expect(body.code).toBe('PLAN_LIMIT_REACHED');
    expect(body.dimension).toBe('teamSeats');
    expect(fake.rows('workspace_invitations')).toHaveLength(0);
  });

  it('flag ON: a paid plan with free seats still invites (Growth = 3 seats, 1 member)', async () => {
    process.env['ENTITLEMENTS_ENFORCED'] = 'true';
    fake.replaceRows('workspace_memberships', [
      { workspace_id: WS1, user_id: OWNER.id, role: 'owner', created_at: '2026-11-01T00:00:00Z' },
    ]);
    fake.replaceRows('subscriptions', [
      {
        id: 'sub-1', workspace_id: WS1, plan_id: 'creator-pro', lifecycle_status: 'active',
        provider: 'cashfree', provider_subscription_id: 'order_1', billing_period: 'monthly',
        amount_minor: 50000, currency: 'INR',
        current_period_start: '2026-11-01T00:00:00Z', current_period_end: '2026-12-01T00:00:00Z',
        trial_ends_at: null, last_provider_event_at: null,
      },
    ]);
    mockAuth.mockResolvedValue(OWNER);
    const res = await createInvitation(
      jsonReq('https://app.opendm.in/api/workspaces/x/invitations', { email: 'invitee@example.com', role: 'member' }),
      params,
    );
    expect(res.status).toBe(201);
    expect(fake.rows('workspace_invitations')).toHaveLength(1);
  });
});

describe('A3 — POST /api/workspaces/accept gated on teamSeats BEFORE the RPC', () => {
  function seedLiveInvitation(): void {
    fake.replaceRows('workspace_invitations', [
      {
        id: 'inv-1', workspace_id: WS1, email: INVITEE.email, role: 'member',
        token_hash: TOKEN_HASH, status: 'pending', created_by: OWNER.id,
        created_at: '2026-11-05T00:00:00Z', expires_at: FUTURE, accepted_by: null, accepted_at: null,
      },
    ]);
  }

  it('flag ON: accepting into a full Free workspace is refused and the RPC is never called', async () => {
    process.env['ENTITLEMENTS_ENFORCED'] = 'true';
    seedLiveInvitation();
    const rpc = vi.fn(() => ({ data: WS1, error: null }));
    fake.setRpcHandler('accept_workspace_invitation', rpc);
    mockAuth.mockResolvedValue(INVITEE);
    const res = await acceptInvitation(
      jsonReq('https://app.opendm.in/api/workspaces/accept', { token: RAW_TOKEN }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_LIMIT_REACHED');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('flag ON: an unknown token still reaches the RPC (its error mapping is unchanged)', async () => {
    process.env['ENTITLEMENTS_ENFORCED'] = 'true';
    const rpc = vi.fn(() => ({
      data: null,
      error: { message: 'invitation not found or already used' },
    }));
    fake.setRpcHandler('accept_workspace_invitation', rpc);
    mockAuth.mockResolvedValue(INVITEE);
    const res = await acceptInvitation(
      jsonReq('https://app.opendm.in/api/workspaces/accept', { token: 'no-such-token' }),
    );
    expect(rpc).toHaveBeenCalled();
    expect(res.status).toBe(404);
  });

  it('flag OFF: a live invitation into the same full workspace accepts via the RPC as before', async () => {
    seedLiveInvitation();
    const rpc = vi.fn(() => ({ data: WS1, error: null }));
    fake.setRpcHandler('accept_workspace_invitation', rpc);
    mockAuth.mockResolvedValue(INVITEE);
    const res = await acceptInvitation(
      jsonReq('https://app.opendm.in/api/workspaces/accept', { token: RAW_TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalled();
  });
});
