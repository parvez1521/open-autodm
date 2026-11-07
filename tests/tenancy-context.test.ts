/**
 * Phase B / Programme 16 — workspace context / authorization layer tests
 * (src/lib/tenancy/context.ts) against the in-memory FakeSupabase harness.
 *
 * Pins the fail-closed contract: membership row is the ONLY evidence of
 * access; a missing workspace context never defaults; viewer is
 * read-only; account → workspace resolution returns null (fail-closed)
 * for unbound accounts. Live SQL behaviour of the membership RPCs is
 * proven separately by the disposable-PostgreSQL rehearsal in
 * saas/phase16-rehearsal/.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveWorkspaceContext,
  requireWorkspaceRole,
  canWrite,
  canManageMembers,
  canManageBilling,
  resolveWorkspaceForAccount,
  WorkspaceAccessError,
  type WorkspaceContext,
} from '@/lib/tenancy/context';
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

beforeEach(() => {
  fake = new FakeSupabase();
  db = fake as unknown as SupabaseClient;
  fake.seed('workspace_memberships', [
    { workspace_id: WS1, user_id: OWNER, role: 'owner' },
    { workspace_id: WS1, user_id: ADMIN, role: 'admin' },
    { workspace_id: WS1, user_id: MEMBER, role: 'member' },
    { workspace_id: WS1, user_id: VIEWER, role: 'viewer' },
    { workspace_id: WS2, user_id: OWNER, role: 'member' },
  ]);
  fake.seed('instagram_accounts', [
    { id: 'acct-bound', workspace_id: WS1 },
    { id: 'acct-unbound', workspace_id: null },
  ]);
});

async function expectAccessError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceAccessError);
    expect((err as WorkspaceAccessError).code).toBe(code);
    return;
  }
  throw new Error(`expected WorkspaceAccessError(${code}) but the call succeeded`);
}

describe('resolveWorkspaceContext', () => {
  it('resolves a member with their correct role', async () => {
    await expect(resolveWorkspaceContext(db, OWNER, WS1)).resolves.toEqual({
      workspaceId: WS1,
      userId: OWNER,
      role: 'owner',
    });
    await expect(resolveWorkspaceContext(db, VIEWER, WS1)).resolves.toMatchObject({ role: 'viewer' });
    // Same user, different workspace → the row for THAT workspace decides.
    await expect(resolveWorkspaceContext(db, OWNER, WS2)).resolves.toMatchObject({ role: 'member' });
  });

  it('queries membership by BOTH workspace_id and user_id (tenant-scoped)', async () => {
    await resolveWorkspaceContext(db, MEMBER, WS1);
    const calls = fake.callsFor('workspace_memberships', 'select');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toEqual(
      expect.arrayContaining([
        { column: 'workspace_id', op: 'eq', value: WS1 },
        { column: 'user_id', op: 'eq', value: MEMBER },
      ]),
    );
  });

  it('non-member → not-a-member (a client-supplied workspaceId is never trusted alone)', async () => {
    await expectAccessError(resolveWorkspaceContext(db, OUTSIDER, WS1), 'not-a-member');
    // A member of WS1 has no standing in WS2.
    await expectAccessError(resolveWorkspaceContext(db, MEMBER, WS2), 'not-a-member');
  });

  it('missing/blank workspaceId → workspace-context-required (fail closed, no default workspace)', async () => {
    await expectAccessError(resolveWorkspaceContext(db, OWNER, undefined), 'workspace-context-required');
    await expectAccessError(resolveWorkspaceContext(db, OWNER, null), 'workspace-context-required');
    await expectAccessError(resolveWorkspaceContext(db, OWNER, ''), 'workspace-context-required');
    await expectAccessError(resolveWorkspaceContext(db, OWNER, '   '), 'workspace-context-required');
    // The fail-closed path must not even query the database.
    expect(fake.callsFor('workspace_memberships')).toHaveLength(0);
  });

  it('missing userId → not-a-member', async () => {
    await expectAccessError(resolveWorkspaceContext(db, '', WS1), 'not-a-member');
  });

  it('a membership row with an unrecognized role fails closed', async () => {
    fake.seed('workspace_memberships', [{ workspace_id: WS2, user_id: OUTSIDER, role: 'superuser' }]);
    await expectAccessError(resolveWorkspaceContext(db, OUTSIDER, WS2), 'not-a-member');
  });

  it('a database error fails closed as not-a-member', async () => {
    fake.failNextQuery('workspace_memberships', { message: 'boom', code: 'XX000' });
    await expectAccessError(resolveWorkspaceContext(db, OWNER, WS1), 'not-a-member');
  });
});

describe('role capabilities (Programme 16 role table)', () => {
  it('canWrite: owner/admin/member true, viewer false (read-only)', () => {
    expect(canWrite('owner')).toBe(true);
    expect(canWrite('admin')).toBe(true);
    expect(canWrite('member')).toBe(true);
    expect(canWrite('viewer')).toBe(false);
  });

  it('canManageMembers: owner/admin only — a member cannot manage members', () => {
    expect(canManageMembers('owner')).toBe(true);
    expect(canManageMembers('admin')).toBe(true);
    expect(canManageMembers('member')).toBe(false);
    expect(canManageMembers('viewer')).toBe(false);
  });

  it('canManageBilling: owner only', () => {
    expect(canManageBilling('owner')).toBe(true);
    expect(canManageBilling('admin')).toBe(false);
    expect(canManageBilling('member')).toBe(false);
    expect(canManageBilling('viewer')).toBe(false);
  });
});

describe('requireWorkspaceRole', () => {
  const ctx = (role: WorkspaceContext['role']): WorkspaceContext => ({ workspaceId: WS1, userId: MEMBER, role });

  it('passes when the role is allowed', () => {
    expect(() => requireWorkspaceRole(ctx('owner'), ['owner'])).not.toThrow();
    expect(() => requireWorkspaceRole(ctx('member'), ['owner', 'admin', 'member'])).not.toThrow();
    expect(() => requireWorkspaceRole(ctx('viewer'), ['owner', 'admin', 'member', 'viewer'])).not.toThrow();
  });

  it('throws insufficient-role when the role is not allowed', () => {
    for (const [role, allowed] of [
      ['viewer', ['owner', 'admin', 'member']],
      ['member', ['owner', 'admin']],
      ['admin', ['owner']],
    ] as const) {
      try {
        requireWorkspaceRole(ctx(role), [...allowed]);
        throw new Error('expected requireWorkspaceRole to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceAccessError);
        expect((err as WorkspaceAccessError).code).toBe('insufficient-role');
      }
    }
  });

  it('composes with resolveWorkspaceContext end-to-end', async () => {
    const viewerCtx = await resolveWorkspaceContext(db, VIEWER, WS1);
    expect(canWrite(viewerCtx.role)).toBe(false);
    expect(() => requireWorkspaceRole(viewerCtx, ['owner', 'admin', 'member'])).toThrowError(WorkspaceAccessError);
    const ownerCtx = await resolveWorkspaceContext(db, OWNER, WS1);
    expect(() => requireWorkspaceRole(ownerCtx, ['owner'])).not.toThrow();
  });
});

describe('resolveWorkspaceForAccount', () => {
  it('returns the bound workspace for a bound account', async () => {
    await expect(resolveWorkspaceForAccount(db, 'acct-bound')).resolves.toBe(WS1);
  });

  it('returns null for an unbound account (fail-closed, no global fallback)', async () => {
    await expect(resolveWorkspaceForAccount(db, 'acct-unbound')).resolves.toBeNull();
  });

  it('returns null for an unknown account and for a missing id', async () => {
    await expect(resolveWorkspaceForAccount(db, 'acct-missing')).resolves.toBeNull();
    await expect(resolveWorkspaceForAccount(db, undefined)).resolves.toBeNull();
    await expect(resolveWorkspaceForAccount(db, '')).resolves.toBeNull();
  });

  it('returns null when the lookup fails', async () => {
    fake.failNextQuery('instagram_accounts', { message: 'boom', code: 'XX000' });
    await expect(resolveWorkspaceForAccount(db, 'acct-bound')).resolves.toBeNull();
  });
});
