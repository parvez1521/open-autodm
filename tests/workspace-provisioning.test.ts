/**
 * First-workspace provisioning — launch fix (2026-11-08).
 *
 * Root cause pinned here: signup created NO workspace. The only
 * creation path was an explicit POST /api/workspaces and nothing
 * called it, so a fresh customer (and any account predating the
 * SaaS wiring, e.g. the staging preview account) had zero
 * memberships and billing/scope resolution dead-ended with "The
 * user does not belong to any workspace."
 *
 * The fix: WorkspaceProvider ensures the first workspace on load
 * via lib/tenancy/provisioning.ts (provisionIfEmpty) through the
 * SAME POST route + create_workspace RPC manual creation uses.
 *
 * Coverage:
 *  - provisionIfEmpty decision logic (unit).
 *  - Provider wiring (source pins, matching the p18 UI test style).
 *  - The full sequence against the REAL routes with the fake db:
 *    a membership-less user lists [] → POST creates (RPC) →
 *    lists their workspace as owner — i.e. exactly what the
 *    provider now drives on a new customer's first console load.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase } from './helpers/fakeSupabase';
import {
  provisionIfEmpty,
  DEFAULT_WORKSPACE_NAME,
} from '@/lib/tenancy/provisioning';

// ── provisionIfEmpty (unit) ─────────────────────────────────────

describe('provisionIfEmpty', () => {
  it('a non-empty list is returned untouched — create/relist never run', async () => {
    const create = vi.fn(async () => ({}));
    const relist = vi.fn(async () => ['x']);
    const res = await provisionIfEmpty(['ws-1'], { create, relist });
    expect(res).toEqual({ workspaces: ['ws-1'], provisioned: false });
    expect(create).not.toHaveBeenCalled();
    expect(relist).not.toHaveBeenCalled();
  });

  it('an empty list creates the default workspace once and returns the re-read list', async () => {
    const create = vi.fn(async (_name: string) => ({}));
    const relist = vi.fn(async () => ['ws-new']);
    const res = await provisionIfEmpty<string>([], { create, relist });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(DEFAULT_WORKSPACE_NAME);
    expect(relist).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ workspaces: ['ws-new'], provisioned: true });
  });

  it('a failed creation is fail-soft: empty list, no relist, no throw', async () => {
    const create = vi.fn(async () => {
      throw new Error('503 workspace-runtime-disabled');
    });
    const relist = vi.fn(async () => ['ws-new']);
    const res = await provisionIfEmpty<string>([], { create, relist });
    expect(res).toEqual({ workspaces: [], provisioned: false });
    expect(relist).not.toHaveBeenCalled();
  });

  it('a creation the re-read cannot see yet reports provisioned: false', async () => {
    const create = vi.fn(async () => ({}));
    const relist = vi.fn(async () => [] as string[]);
    const res = await provisionIfEmpty<string>([], { create, relist });
    expect(res).toEqual({ workspaces: [], provisioned: false });
  });

  it('a re-read failure after a successful create is fail-soft', async () => {
    const create = vi.fn(async () => ({}));
    const relist = vi.fn(async () => {
      throw new Error('transport down');
    });
    const res = await provisionIfEmpty<string>([], { create, relist });
    expect(res).toEqual({ workspaces: [], provisioned: false });
  });
});

// ── Provider wiring (source pins) ───────────────────────────────

describe('WorkspaceProvider provisioning wiring', () => {
  const providerSrc = readFileSync(
    path.resolve(process.cwd(), 'src/components/workspace/WorkspaceProvider.tsx'),
    'utf8',
  );

  it('ensures the first workspace through provisionIfEmpty on an empty list', () => {
    expect(providerSrc).toContain("provisionIfEmpty");
    expect(providerSrc).toContain("@/lib/tenancy/provisioning");
    expect(providerSrc).toContain('list.length === 0');
  });

  it('creates through the app\'s own POST /api/workspaces route', () => {
    expect(providerSrc).toContain('method: "POST"');
    expect(providerSrc).toContain('body: JSON.stringify({ name })');
  });

  it('attempts provisioning at most once per mount', () => {
    expect(providerSrc).toContain('provisionAttemptedRef');
  });

  it('the member-derived GET remains the list source (no parallel query)', () => {
    expect(providerSrc).toContain('apiClient<{ workspaces: WorkspaceSummary[] }>("/workspaces")');
    expect(providerSrc).toContain('if (!workspaceRuntimeEnabled) return;');
  });
});

// ── Route-level: the sequence a new customer now drives ─────────

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/supabase/userClient', () => ({ createUserRpcClient: vi.fn() }));

import { GET as listWorkspaces, POST as createWorkspace } from '@/app/api/workspaces/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const NEW_CUSTOMER = { id: 'user-new-customer', email: 'new@example.com' };
const WS_PROVISIONED = '33333333-3333-4333-8333-333333333333';
const ORIGINAL_FLAG = process.env['WORKSPACE_RUNTIME_ENABLED'];

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('workspace_memberships', []);
  fake.replaceRows('workspaces', []);
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  vi.mocked(createUserRpcClient).mockResolvedValue({
    ok: true,
    client: fake as unknown as SupabaseClient,
  });
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(NEW_CUSTOMER);
  process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  // Mimic migration …000031's create_workspace: workspace row +
  // owner membership, atomically, actor = the caller.
  fake.setRpcHandler('create_workspace', (params) => {
    fake.seed('workspaces', [
      {
        id: WS_PROVISIONED,
        name: params['p_name'],
        created_by: NEW_CUSTOMER.id,
        created_at: '2026-11-08T00:00:00Z',
      },
    ]);
    fake.seed('workspace_memberships', [
      { workspace_id: WS_PROVISIONED, user_id: NEW_CUSTOMER.id, role: 'owner', created_at: '2026-11-08T00:00:00Z' },
    ]);
    return { data: WS_PROVISIONED, error: null };
  });
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = ORIGINAL_FLAG;
});

describe('signup → workspace (route level)', () => {
  it('a membership-less user lists [], provisions via POST, then lists their workspace as owner', async () => {
    const before = await listWorkspaces(new Request('https://app.example/api/workspaces'));
    expect(before.status).toBe(200);
    expect(((await before.json()) as { workspaces: unknown[] }).workspaces).toEqual([]);

    const created = await createWorkspace(
      new Request('https://app.example/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: DEFAULT_WORKSPACE_NAME }),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { workspace: { workspaceId: string; role: string } };
    expect(createdBody.workspace.workspaceId).toBe(WS_PROVISIONED);
    expect(createdBody.workspace.role).toBe('owner');

    const after = await listWorkspaces(new Request('https://app.example/api/workspaces'));
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      workspaces: Array<{ workspaceId: string; name: string | null; role: string }>;
    };
    expect(afterBody.workspaces).toEqual([
      {
        id: WS_PROVISIONED,
        workspaceId: WS_PROVISIONED,
        name: DEFAULT_WORKSPACE_NAME,
        role: 'owner',
        created_at: '2026-11-08T00:00:00Z',
      },
    ]);
  });
});
