/**
 * Phase C / Programme 16 — workspace-scoped data-access layer tests
 * (src/lib/tenancy/scopedDb.ts) against the in-memory FakeSupabase harness.
 *
 * Pins: applyTenantScope adds exactly the workspace_id eq filter and
 * returns only the context workspace's rows across two workspaces;
 * assertRowInWorkspace passes on a match and fails closed with stable
 * codes on mismatch ('cross-workspace-row') and on unbound rows
 * ('unbound-row'); tenantFilter/stampWorkspace shapes. Live SQL
 * behaviour (RLS + composite FKs) is proven separately by the
 * disposable-PostgreSQL rehearsal in saas/phase16-rehearsal/.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  tenantFilter,
  stampWorkspace,
  applyTenantScope,
  assertRowInWorkspace,
} from '@/lib/tenancy/scopedDb';
import { WorkspaceAccessError, type WorkspaceContext } from '@/lib/tenancy/context';
import { FakeSupabase } from './helpers/fakeSupabase';

let fake: FakeSupabase;
let db: SupabaseClient;

const WS_A = 'ws-00000000-0000-4000-8000-00000000000a';
const WS_B = 'ws-00000000-0000-4000-8000-00000000000b';

const ctxA: WorkspaceContext = { workspaceId: WS_A, userId: 'user-a-owner', role: 'owner' };
const ctxB: WorkspaceContext = { workspaceId: WS_B, userId: 'user-b-owner', role: 'owner' };

beforeEach(() => {
  fake = new FakeSupabase();
  db = fake as unknown as SupabaseClient;
  fake.seed('automations', [
    { id: 'auto-a1', workspace_id: WS_A, name: 'A one' },
    { id: 'auto-a2', workspace_id: WS_A, name: 'A two' },
    { id: 'auto-b1', workspace_id: WS_B, name: 'B one' },
    { id: 'auto-legacy', workspace_id: null, name: 'Legacy unbound' },
  ]);
});

describe('tenantFilter / stampWorkspace', () => {
  it('tenantFilter returns exactly { workspace_id: ctx.workspaceId }', () => {
    expect(tenantFilter(ctxA)).toEqual({ workspace_id: WS_A });
    expect(tenantFilter(ctxB)).toEqual({ workspace_id: WS_B });
  });

  it('stampWorkspace returns the insert fragment for the context workspace', () => {
    expect(stampWorkspace(ctxA)).toEqual({ workspace_id: WS_A });
    // Stamping an insert through the fake persists the workspace on the row.
    return (async () => {
      await fake.from('automations').insert({ name: 'stamped', ...stampWorkspace(ctxB) });
      const rows = fake.rows('automations').filter((r) => r['name'] === 'stamped');
      expect(rows).toHaveLength(1);
      expect(rows[0]!['workspace_id']).toBe(WS_B);
    })();
  });
});

describe('applyTenantScope', () => {
  it('adds the workspace_id eq filter (asserted via the fake’s recorded calls)', async () => {
    await applyTenantScope(db.from('automations').select('id, name'), ctxA);
    const calls = fake.callsFor('automations', 'select');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toEqual([{ column: 'workspace_id', op: 'eq', value: WS_A }]);
  });

  it('returns only the context workspace’s rows (two-workspace isolation)', async () => {
    const { data: rowsA } = await applyTenantScope(db.from('automations').select('id'), ctxA);
    expect((rowsA as { id: string }[]).map((r) => r.id).sort()).toEqual(['auto-a1', 'auto-a2']);

    const { data: rowsB } = await applyTenantScope(db.from('automations').select('id'), ctxB);
    expect((rowsB as { id: string }[]).map((r) => r.id)).toEqual(['auto-b1']);
    // The unbound legacy row is in NEITHER workspace scope (fail closed).
    expect((rowsA as { id: string }[]).some((r) => r.id === 'auto-legacy')).toBe(false);
  });

  it('composes with further filters on the same builder', async () => {
    // Uses the FakeBuilder directly: chaining .eq() onto the real
    // SupabaseClient's PostgREST builder type trips TS2589 (excessively
    // deep instantiation) — a type-level quirk, not runtime behaviour.
    const { data } = await applyTenantScope(fake.from('automations').select('id'), ctxA).eq('name', 'A two');
    expect((data as { id: string }[]).map((r) => r.id)).toEqual(['auto-a2']);
    const calls = fake.callsFor('automations', 'select');
    expect(calls[0]!.filters).toEqual(
      expect.arrayContaining([
        { column: 'workspace_id', op: 'eq', value: WS_A },
        { column: 'name', op: 'eq', value: 'A two' },
      ]),
    );
  });
});

describe('assertRowInWorkspace', () => {
  it('passes when the row belongs to the context workspace', () => {
    expect(() => assertRowInWorkspace({ workspace_id: WS_A }, ctxA)).not.toThrow();
    expect(() => assertRowInWorkspace({ workspace_id: WS_B }, ctxB)).not.toThrow();
  });

  it('throws cross-workspace-row on a workspace mismatch', () => {
    try {
      assertRowInWorkspace({ workspace_id: WS_B }, ctxA);
      throw new Error('expected assertRowInWorkspace to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceAccessError);
      expect((err as WorkspaceAccessError).code).toBe('cross-workspace-row');
    }
  });

  it('throws unbound-row on null / missing workspace_id and on a missing row', () => {
    for (const row of [{ workspace_id: null }, { workspace_id: undefined }, {}, null, undefined] as const) {
      try {
        assertRowInWorkspace(row, ctxA);
        throw new Error('expected assertRowInWorkspace to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceAccessError);
        expect((err as WorkspaceAccessError).code).toBe('unbound-row');
      }
    }
  });
});
