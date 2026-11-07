/**
 * Programme 18 / Phase E — typed tenant repository tests
 * (src/lib/tenancy/repository.ts) against FakeSupabase.
 *
 * Pins: scoped reads return only own-workspace rows; getByIdInWorkspace
 * throws cross-workspace-row for B's row and unbound-row for a NULL row;
 * insert stamps the ctx workspace and rejects a foreign workspace_id in
 * the payload; a read-capability repository's writes throw
 * insufficient-role (viewer can never obtain write); update/delete are
 * scoped so B's row is untouched; non-tenant tables are unreachable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createTenantRepository,
  capabilityForContext,
  TENANT_TABLES,
} from '@/lib/tenancy/repository';
import { WorkspaceAccessError, type WorkspaceContext } from '@/lib/tenancy/context';
import { FakeSupabase } from './helpers/fakeSupabase';

let fake: FakeSupabase;
let db: SupabaseClient;

const WS_A = 'ws-00000000-0000-4000-8000-00000000000a';
const WS_B = 'ws-00000000-0000-4000-8000-00000000000b';

const ownerA: WorkspaceContext = { workspaceId: WS_A, userId: 'user-a-owner', role: 'owner' };
const memberA: WorkspaceContext = { workspaceId: WS_A, userId: 'user-a-member', role: 'member' };
const viewerA: WorkspaceContext = { workspaceId: WS_A, userId: 'user-a-viewer', role: 'viewer' };
const ownerB: WorkspaceContext = { workspaceId: WS_B, userId: 'user-b-owner', role: 'owner' };

beforeEach(() => {
  fake = new FakeSupabase();
  db = fake as unknown as SupabaseClient;
  fake.seed('automations', [
    { id: 'auto-a1', workspace_id: WS_A, name: 'A one' },
    { id: 'auto-a2', workspace_id: WS_A, name: 'A two' },
    { id: 'auto-b1', workspace_id: WS_B, name: 'B one' },
    { id: 'auto-legacy', workspace_id: null, name: 'Legacy unbound' },
  ]);
  fake.seed('contacts', [
    { id: 'contact-a1', workspace_id: WS_A, username: 'a-friend' },
    { id: 'contact-b1', workspace_id: WS_B, username: 'b-friend' },
  ]);
  fake.seed('instagram_accounts', [
    { id: 'acct-a', workspace_id: WS_A, username: 'a-acct' },
    { id: 'acct-b', workspace_id: WS_B, username: 'b-acct' },
  ]);
});

function expectAccessErrorSync(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceAccessError);
    expect((err as WorkspaceAccessError).code).toBe(code);
    return;
  }
  throw new Error(`expected WorkspaceAccessError(${code}) but the call succeeded`);
}

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

describe('scoped reads', () => {
  it('list returns only own-workspace rows (B and unbound rows excluded)', async () => {
    const repoA = createTenantRepository(db, ownerA);
    const rowsA = await repoA.automations.list();
    expect(rowsA.map((r) => r['id']).sort()).toEqual(['auto-a1', 'auto-a2']);

    const repoB = createTenantRepository(db, ownerB);
    const rowsB = await repoB.automations.list();
    expect(rowsB.map((r) => r['id'])).toEqual(['auto-b1']);

    // The recorded query carried the workspace scope.
    const selectCalls = fake.callsFor('automations', 'select');
    expect(selectCalls[0]!.filters).toContainEqual({
      column: 'workspace_id',
      op: 'eq',
      value: WS_A,
    });
  });

  it('list composes caller eq filters ON TOP of the workspace scope', async () => {
    const repo = createTenantRepository(db, ownerA);
    const rows = await repo.automations.list({ name: 'A two' });
    expect(rows.map((r) => r['id'])).toEqual(['auto-a2']);
    // A caller filter can never widen scope: filtering by B's name in
    // A's repository still returns nothing.
    const widened = await repo.automations.list({ name: 'B one' });
    expect(widened).toEqual([]);
  });

  it('named accessors are bound to their tables (contacts, instagram_accounts)', async () => {
    const repo = createTenantRepository(db, ownerA);
    await expect(repo.contacts.list()).resolves.toHaveLength(1);
    const accounts = await repo.instagramAccounts.list();
    expect(accounts.map((r) => r['id'])).toEqual(['acct-a']);
  });
});

describe('getByIdInWorkspace — the only single-row load', () => {
  it("returns the context workspace's own row", async () => {
    const repo = createTenantRepository(db, ownerA);
    await expect(repo.automations.getByIdInWorkspace('auto-a1')).resolves.toMatchObject({
      id: 'auto-a1',
      workspace_id: WS_A,
    });
  });

  it("throws cross-workspace-row for B's row", async () => {
    const repo = createTenantRepository(db, ownerA);
    await expectAccessError(repo.automations.getByIdInWorkspace('auto-b1'), 'cross-workspace-row');
    await expectAccessError(
      repo.contacts.getByIdInWorkspace('contact-b1'),
      'cross-workspace-row',
    );
  });

  it('throws unbound-row for a NULL-workspace row', async () => {
    const repo = createTenantRepository(db, ownerA);
    await expectAccessError(repo.automations.getByIdInWorkspace('auto-legacy'), 'unbound-row');
  });

  it('returns null for an id that does not exist at all', async () => {
    const repo = createTenantRepository(db, ownerA);
    await expect(repo.automations.getByIdInWorkspace('auto-missing')).resolves.toBeNull();
  });
});

describe('insert', () => {
  it('always stamps the ctx workspace onto the stored row', async () => {
    const repo = createTenantRepository(db, memberA);
    await repo.automations.insert({ name: 'A three' });
    const stored = fake.rows('automations').filter((r) => r['name'] === 'A three');
    expect(stored).toHaveLength(1);
    expect(stored[0]!['workspace_id']).toBe(WS_A);
    // And it is immediately visible in A's scope (only).
    await expect(repo.automations.list()).resolves.toHaveLength(3);
    const repoB = createTenantRepository(db, ownerB);
    await expect(repoB.automations.list()).resolves.toHaveLength(1);
  });

  it('accepts a payload whose workspace_id already equals the ctx workspace', async () => {
    const repo = createTenantRepository(db, ownerA);
    await repo.automations.insert({ name: 'A four', workspace_id: WS_A });
    const stored = fake.rows('automations').filter((r) => r['name'] === 'A four');
    expect(stored[0]!['workspace_id']).toBe(WS_A);
  });

  it('REJECTS a payload that tries to set a foreign workspace_id (and writes nothing)', async () => {
    const repo = createTenantRepository(db, ownerA);
    await expectAccessError(
      repo.automations.insert({ name: 'smuggled', workspace_id: WS_B }),
      'cross-workspace-row',
    );
    await expectAccessError(
      repo.automations.insert({ name: 'unbound-attempt', workspace_id: null }),
      'cross-workspace-row',
    );
    expect(fake.rows('automations').some((r) => r['name'] === 'smuggled')).toBe(false);
    expect(fake.rows('automations').some((r) => r['name'] === 'unbound-attempt')).toBe(false);
    expect(fake.callsFor('automations', 'insert')).toHaveLength(0);
  });
});

describe('capability gate', () => {
  it('capabilityForContext: viewer read-only, every other role write', () => {
    expect(capabilityForContext(viewerA)).toBe('read');
    expect(capabilityForContext(memberA)).toBe('write');
    expect(capabilityForContext(ownerA)).toBe('write');
  });

  it("a read-capability repository's write methods throw insufficient-role", async () => {
    const readRepo = createTenantRepository(db, ownerA, 'read');
    expect(readRepo.capability).toBe('read');
    await expectAccessError(readRepo.automations.insert({ name: 'nope' }), 'insufficient-role');
    await expectAccessError(
      readRepo.automations.updateById('auto-a1', { name: 'nope' }),
      'insufficient-role',
    );
    await expectAccessError(readRepo.automations.deleteById('auto-a1'), 'insufficient-role');
    // Reads still work on a read repository.
    await expect(readRepo.automations.list()).resolves.toHaveLength(2);
  });

  it('a viewer can never obtain a write repository (write request downgrades, fail closed)', async () => {
    const viewerRepo = createTenantRepository(db, viewerA, 'write');
    expect(viewerRepo.capability).toBe('read');
    await expectAccessError(viewerRepo.automations.insert({ name: 'nope' }), 'insufficient-role');
    const viewerDefault = createTenantRepository(db, viewerA);
    expect(viewerDefault.capability).toBe('read');
    await expectAccessError(
      viewerDefault.automations.deleteById('auto-a1'),
      'insufficient-role',
    );
  });
});

describe('update / delete scoping', () => {
  it("updateById updates A's row and returns the fresh row", async () => {
    const repo = createTenantRepository(db, ownerA);
    const updated = await repo.automations.updateById('auto-a1', { name: 'A one renamed' });
    expect(updated).toMatchObject({ id: 'auto-a1', name: 'A one renamed', workspace_id: WS_A });
    const stored = fake.rows('automations').find((r) => r['id'] === 'auto-a1');
    expect(stored!['name']).toBe('A one renamed');
  });

  it("updateById on B's row throws cross-workspace-row and B's row is UNTOUCHED", async () => {
    const repo = createTenantRepository(db, ownerA);
    await expectAccessError(
      repo.automations.updateById('auto-b1', { name: 'hijacked' }),
      'cross-workspace-row',
    );
    const stored = fake.rows('automations').find((r) => r['id'] === 'auto-b1');
    expect(stored!['name']).toBe('B one');
    expect(fake.callsFor('automations', 'update')).toHaveLength(0);
  });

  it('updateById rejects a patch that tries to move the row to another workspace', async () => {
    const repo = createTenantRepository(db, ownerA);
    await expectAccessError(
      repo.automations.updateById('auto-a1', { workspace_id: WS_B }),
      'cross-workspace-row',
    );
    const stored = fake.rows('automations').find((r) => r['id'] === 'auto-a1');
    expect(stored!['workspace_id']).toBe(WS_A);
  });

  it("deleteById removes A's row; on B's row it throws and B's row survives", async () => {
    const repo = createTenantRepository(db, ownerA);
    await expectAccessError(repo.automations.deleteById('auto-b1'), 'cross-workspace-row');
    expect(fake.rows('automations').some((r) => r['id'] === 'auto-b1')).toBe(true);

    await expect(repo.automations.deleteById('auto-a2')).resolves.toBe(true);
    expect(fake.rows('automations').some((r) => r['id'] === 'auto-a2')).toBe(false);
    await expect(repo.automations.deleteById('auto-missing')).resolves.toBe(false);
  });

  it('update/delete of an unbound (NULL-workspace) row throw unbound-row and touch nothing', async () => {
    const repo = createTenantRepository(db, ownerA);
    await expectAccessError(
      repo.automations.updateById('auto-legacy', { name: 'adopted' }),
      'unbound-row',
    );
    await expectAccessError(repo.automations.deleteById('auto-legacy'), 'unbound-row');
    const stored = fake.rows('automations').find((r) => r['id'] === 'auto-legacy');
    expect(stored!['name']).toBe('Legacy unbound');
  });
});

describe('table allowlist', () => {
  it('every allowlisted table carries workspace_id coverage and is reachable', () => {
    const repo = createTenantRepository(db, ownerA);
    for (const table of TENANT_TABLES) {
      expect(repo.table(table).table).toBe(table);
    }
    expect(TENANT_TABLES).toContain('automations');
    expect(TENANT_TABLES).toContain('contacts');
    expect(TENANT_TABLES).toContain('instagram_accounts');
    expect(TENANT_TABLES).toContain('dm_logs');
  });

  it('platform / gated tables are NOT reachable through the repository', () => {
    const repo = createTenantRepository(db, ownerA);
    for (const forbidden of ['app_settings', 'platform_config', 'workspace_settings', 'profiles', 'data_deletion_requests', 'workspaces']) {
      expect(TENANT_TABLES as readonly string[]).not.toContain(forbidden);
      expect(() => repo.table(forbidden as never)).toThrowError(/not a tenant table/);
    }
  });
});
