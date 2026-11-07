/**
 * Programme 18 / Phase C — route workspace-context pattern tests
 * (src/lib/tenancy/routeContext.ts) against FakeSupabase.
 *
 * Pins: member resolves; non-member fails; missing selector fails
 * closed with NO default (even for a single-workspace user); garbage
 * role fails; a raw transport throw becomes a failure result with NO
 * context (the resolver propagates raw throws — P17 — so the wrapper
 * is the normalising boundary); listUserWorkspaces returns only the
 * caller's own memberships; role gates incl. viewer write denial and
 * the accountAdmin = owner/admin mapping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveRouteWorkspaceContext,
  listUserWorkspaces,
  requireCapability,
  hasCapability,
} from '@/lib/tenancy/routeContext';
import { WorkspaceAccessError, type WorkspaceContext } from '@/lib/tenancy/context';
import { FakeSupabase } from './helpers/fakeSupabase';

let fake: FakeSupabase;
let db: SupabaseClient;

const WS1 = 'ws-00000000-0000-4000-8000-000000000001';
const WS2 = 'ws-00000000-0000-4000-8000-000000000002';
const OWNER = 'user-owner';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const VIEWER = 'user-viewer';
const OUTSIDER = 'user-outsider';
const SOLO = 'user-solo';

beforeEach(() => {
  fake = new FakeSupabase();
  db = fake as unknown as SupabaseClient;
  fake.seed('workspace_memberships', [
    { workspace_id: WS1, user_id: OWNER, role: 'owner' },
    { workspace_id: WS1, user_id: ADMIN, role: 'admin' },
    { workspace_id: WS1, user_id: MEMBER, role: 'member' },
    { workspace_id: WS1, user_id: VIEWER, role: 'viewer' },
    { workspace_id: WS2, user_id: OWNER, role: 'member' },
    { workspace_id: WS1, user_id: SOLO, role: 'owner' },
  ]);
});

describe('resolveRouteWorkspaceContext', () => {
  it('resolves a member to { ok: true, ctx } with the membership role', async () => {
    const result = await resolveRouteWorkspaceContext(db, OWNER, WS1);
    expect(result).toEqual({
      ok: true,
      ctx: { workspaceId: WS1, userId: OWNER, role: 'owner' },
    });
    // The { id } user-object form resolves identically.
    const viaObject = await resolveRouteWorkspaceContext(db, { id: MEMBER }, WS1);
    expect(viaObject.ok).toBe(true);
    if (viaObject.ok) expect(viaObject.ctx.role).toBe('member');
  });

  it('non-member fails closed: { ok: false, 403, not-a-member } and NO context', async () => {
    const result = await resolveRouteWorkspaceContext(db, OUTSIDER, WS1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe('not-a-member');
    }
    expect('ctx' in result).toBe(false);
    // A WS1 member has no standing in WS2 either.
    const cross = await resolveRouteWorkspaceContext(db, MEMBER, WS2);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe('not-a-member');
  });

  it('missing selector fails closed with NO default — even for a single-workspace user', async () => {
    for (const missing of [undefined, null, '', '   ']) {
      const result = await resolveRouteWorkspaceContext(db, SOLO, missing);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.code).toBe('workspace-context-required');
      }
      expect('ctx' in result).toBe(false);
    }
    // SOLO belongs to exactly one workspace, yet nothing was defaulted:
    // no successful resolution happened, so no context exists.
  });

  it('a membership row with a garbage role fails closed as not-a-member', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS2, user_id: OUTSIDER, role: 'superuser' },
    ]);
    const result = await resolveRouteWorkspaceContext(db, OUTSIDER, WS2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not-a-member');
  });

  it('a resolved DB error fails closed as not-a-member (no throw escapes)', async () => {
    fake.failNextQuery('workspace_memberships', { message: 'boom', code: 'XX000' });
    const result = await resolveRouteWorkspaceContext(db, OWNER, WS1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not-a-member');
  });

  it('a RAW transport throw becomes a failure result with NO context (never throws, never resolves)', async () => {
    // A db whose from() throws synchronously — the raw-propagation case
    // P17 verified for resolveWorkspaceContext itself.
    const throwingDb = {
      from() {
        throw new Error('socket hangup');
      },
    } as unknown as SupabaseClient;
    const result = await resolveRouteWorkspaceContext(throwingDb, OWNER, WS1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.code).toBe('workspace-resolution-failed');
    }
    expect('ctx' in result).toBe(false);
  });

  it('fresh resolution per request: a revoked membership fails on the NEXT call (no caching)', async () => {
    const first = await resolveRouteWorkspaceContext(db, MEMBER, WS1);
    expect(first.ok).toBe(true);
    fake.replaceRows(
      'workspace_memberships',
      fake.rows('workspace_memberships').filter(
        (r) => !(r['workspace_id'] === WS1 && r['user_id'] === MEMBER),
      ),
    );
    const second = await resolveRouteWorkspaceContext(db, MEMBER, WS1);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('not-a-member');
  });
});

describe('listUserWorkspaces', () => {
  it("returns only the caller's own memberships (workspace + role)", async () => {
    await expect(listUserWorkspaces(db, OWNER)).resolves.toEqual(
      expect.arrayContaining([
        { workspaceId: WS1, role: 'owner' },
        { workspaceId: WS2, role: 'member' },
      ]),
    );
    await expect(listUserWorkspaces(db, OWNER)).resolves.toHaveLength(2);
    await expect(listUserWorkspaces(db, VIEWER)).resolves.toEqual([
      { workspaceId: WS1, role: 'viewer' },
    ]);
    await expect(listUserWorkspaces(db, OUTSIDER)).resolves.toEqual([]);
  });

  it('queries memberships filtered by user_id only (no workspace enumeration)', async () => {
    await listUserWorkspaces(db, MEMBER);
    const calls = fake.callsFor('workspace_memberships', 'select');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toEqual([{ column: 'user_id', op: 'eq', value: MEMBER }]);
  });

  it('drops garbage-role rows and fails closed to [] on error / transport throw', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS2, user_id: MEMBER, role: 'superuser' },
    ]);
    await expect(listUserWorkspaces(db, MEMBER)).resolves.toEqual([
      { workspaceId: WS1, role: 'member' },
    ]);
    fake.failNextQuery('workspace_memberships', { message: 'boom', code: 'XX000' });
    await expect(listUserWorkspaces(db, MEMBER)).resolves.toEqual([]);
    const throwingDb = {
      from() {
        throw new Error('socket hangup');
      },
    } as unknown as SupabaseClient;
    await expect(listUserWorkspaces(throwingDb, MEMBER)).resolves.toEqual([]);
    await expect(listUserWorkspaces(db, '')).resolves.toEqual([]);
  });
});

describe('requireCapability / hasCapability', () => {
  const ctx = (role: WorkspaceContext['role']): WorkspaceContext => ({
    workspaceId: WS1,
    userId: MEMBER,
    role,
  });

  it("'write': owner/admin/member pass, viewer is denied with insufficient-role", () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(() => requireCapability(ctx(role), 'write')).not.toThrow();
      expect(hasCapability(ctx(role), 'write')).toBe(true);
    }
    try {
      requireCapability(ctx('viewer'), 'write');
      throw new Error('expected requireCapability to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceAccessError);
      expect((err as WorkspaceAccessError).code).toBe('insufficient-role');
    }
    expect(hasCapability(ctx('viewer'), 'write')).toBe(false);
  });

  it("'manageMembers': owner/admin only; 'manageBilling': owner only", () => {
    expect(hasCapability(ctx('owner'), 'manageMembers')).toBe(true);
    expect(hasCapability(ctx('admin'), 'manageMembers')).toBe(true);
    expect(hasCapability(ctx('member'), 'manageMembers')).toBe(false);
    expect(hasCapability(ctx('viewer'), 'manageMembers')).toBe(false);
    expect(hasCapability(ctx('owner'), 'manageBilling')).toBe(true);
    expect(hasCapability(ctx('admin'), 'manageBilling')).toBe(false);
    expect(hasCapability(ctx('member'), 'manageBilling')).toBe(false);
  });

  it("'accountAdmin' maps to owner/admin (the IG account-administration gate)", () => {
    expect(hasCapability(ctx('owner'), 'accountAdmin')).toBe(true);
    expect(hasCapability(ctx('admin'), 'accountAdmin')).toBe(true);
    expect(hasCapability(ctx('member'), 'accountAdmin')).toBe(false);
    expect(hasCapability(ctx('viewer'), 'accountAdmin')).toBe(false);
    expect(() => requireCapability(ctx('member'), 'accountAdmin')).toThrowError(
      WorkspaceAccessError,
    );
  });
});
