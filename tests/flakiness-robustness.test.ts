/**
 * Flakiness-fix tests (2026-11-08).
 *
 * Covers the four code-side fixes from
 * `automations-flakiness-investigation.md` (fix-plan items 2, 3, 4,
 * 6) against the workspace-scoped fetch flakiness:
 *
 *  Item 4 (client timeout): an apiClient call whose session leg or
 *    fetch leg hangs SETTLES as ApiTimeoutError; a caller-driven
 *    abort is NOT misreported as a timeout; normal responses,
 *    ApiError mapping and Authorization attachment are unchanged.
 *  Item 4 (shared session): concurrent apiClient calls share ONE
 *    in-flight getSession(); the memo clears on settle (next call
 *    re-reads) — single-flight, never a cache.
 *  Item 3 (scope gating): source pins — the workspace-scoped list
 *    hooks do not fire while the scope is 'unavailable'.
 *  Item 6 (bounded retry): the transient classifier's matrix, the
 *    retry-once semantics of withTransientQueryRetry, and the tenant
 *    repository list absorbing exactly one transient blip (and
 *    never retrying a non-transient error).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isTransientPostgrestError,
  withTransientQueryRetry,
  TRANSIENT_RETRY_BACKOFF_MS,
} from '../src/lib/supabase/queryRetry';
import { WorkspaceAccessError } from '../src/lib/tenancy/context';
import { FakeSupabase } from './helpers/fakeSupabase';
import { createTenantRepository } from '../src/lib/tenancy/repository';
import type { WorkspaceContext } from '../src/lib/tenancy/context';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Hoisted fake for @/lib/supabase/clients (used by the apiClient tests).
// getSession behaviour is steered per-test through this holder.
// ---------------------------------------------------------------------------
const sessionHolder = vi.hoisted(() => ({
  calls: 0,
  impl: (): Promise<{ data: { session: { access_token: string } | null } }> =>
    Promise.resolve({ data: { session: { access_token: 'test-token' } } }),
}));

vi.mock('@/lib/supabase/clients', () => ({
  createBrowserClient: () => ({
    auth: {
      getSession: () => {
        sessionHolder.calls += 1;
        return sessionHolder.impl();
      },
    },
  }),
}));

const SRC = path.join(__dirname, '..', 'src');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ===========================================================================
// Item 6 — transient classifier
// ===========================================================================
describe('isTransientPostgrestError — classifier matrix', () => {
  it('classifies connection-class SQLSTATEs as transient', () => {
    expect(isTransientPostgrestError({ code: '08006', message: 'connection failure' })).toBe(true);
    expect(isTransientPostgrestError({ code: '08001', message: 'unable to connect' })).toBe(true);
    expect(isTransientPostgrestError({ code: '08003', message: 'connection does not exist' })).toBe(true);
  });

  it('classifies resource/availability SQLSTATEs as transient', () => {
    expect(isTransientPostgrestError({ code: '53300', message: 'too many connections' })).toBe(true);
    expect(isTransientPostgrestError({ code: '57P03', message: 'cannot connect now' })).toBe(true);
    expect(isTransientPostgrestError({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(true);
  });

  it('classifies transport failures (TypeError / fetch-shaped) as transient', () => {
    expect(isTransientPostgrestError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientPostgrestError({ message: 'fetch failed' })).toBe(true);
    expect(isTransientPostgrestError({ message: 'Connection reset by peer' })).toBe(true);
    expect(isTransientPostgrestError({ message: 'socket hang up' })).toBe(true);
    expect(isTransientPostgrestError({ message: 'Network error: Failed to fetch' })).toBe(true);
  });

  it('never retries auth / validation / integrity errors, even with scary messages', () => {
    expect(isTransientPostgrestError({ code: 'XX000', message: 'boom' })).toBe(false);
    expect(isTransientPostgrestError({ code: '23505', message: 'duplicate key value' })).toBe(false);
    expect(isTransientPostgrestError({ code: '23503', message: 'foreign key violation' })).toBe(false);
    expect(isTransientPostgrestError({ code: '42501', message: 'permission denied for table' })).toBe(false);
    expect(isTransientPostgrestError({ code: 'PGRST116', message: 'Results contain 0 rows' })).toBe(false);
    expect(isTransientPostgrestError({ code: 'PGRST301', message: 'JWT expired' })).toBe(false);
    // A coded error outside the transient set is NEVER transient,
    // even when its message sounds like a network failure.
    expect(
      isTransientPostgrestError({ code: 'XX000', message: 'connection reset by peer' }),
    ).toBe(false);
  });

  it('never retries business-rule / workspace errors', () => {
    expect(
      isTransientPostgrestError(
        new WorkspaceAccessError('not-a-member', 'The user is not a member of the selected workspace.'),
      ),
    ).toBe(false);
    expect(isTransientPostgrestError({ message: 'Validation failed - name: required' })).toBe(false);
    expect(isTransientPostgrestError({ message: 'boom' })).toBe(false);
  });

  it('treats non-error shapes as non-transient', () => {
    expect(isTransientPostgrestError(null)).toBe(false);
    expect(isTransientPostgrestError(undefined)).toBe(false);
    expect(isTransientPostgrestError('connection reset')).toBe(false);
    expect(isTransientPostgrestError(500)).toBe(false);
    expect(isTransientPostgrestError({})).toBe(false);
  });
});

// ===========================================================================
// Item 6 — retry-once semantics
// ===========================================================================
describe('withTransientQueryRetry — bounded retry', () => {
  function harness() {
    const sleeps: number[] = [];
    const lines: { level: string; msg: string }[] = [];
    return {
      sleeps,
      lines,
      options: {
        backoffMs: 123,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) => {
          lines.push({ level, msg: String(fields['outcome']) });
        },
      },
    };
  }

  it('returns the value on first success without sleeping', async () => {
    const h = harness();
    let runs = 0;
    const value = await withTransientQueryRetry('op', async () => {
      runs += 1;
      return 42;
    }, h.options);
    expect(value).toBe(42);
    expect(runs).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('retries exactly once after a transient failure, with the backoff, then returns', async () => {
    const h = harness();
    let runs = 0;
    const value = await withTransientQueryRetry('op', async () => {
      runs += 1;
      if (runs === 1) throw { code: '08006', message: 'connection reset by peer' };
      return 'rows';
    }, h.options);
    expect(value).toBe('rows');
    expect(runs).toBe(2);
    expect(h.sleeps).toEqual([123]);
    expect(h.lines.map((l) => l.msg)).toEqual(['transient-error-retrying', 'ok-after-retry']);
  });

  it('propagates the SECOND error when both attempts fail transiently (never a third run)', async () => {
    const h = harness();
    let runs = 0;
    await expect(
      withTransientQueryRetry('op', async () => {
        runs += 1;
        throw { code: '08006', message: `failure-${runs}` };
      }, h.options),
    ).rejects.toMatchObject({ message: 'failure-2' });
    expect(runs).toBe(2);
    expect(h.sleeps).toEqual([123]);
    expect(h.lines.map((l) => l.msg)).toEqual(['transient-error-retrying', 'error-after-retry']);
  });

  it('never retries a non-transient error (single run, no sleep, no retry log)', async () => {
    const h = harness();
    let runs = 0;
    await expect(
      withTransientQueryRetry('op', async () => {
        runs += 1;
        throw { code: '23505', message: 'duplicate key value' };
      }, h.options),
    ).rejects.toMatchObject({ code: '23505' });
    expect(runs).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it('does not retry when the second failure is non-transient either', async () => {
    const h = harness();
    let runs = 0;
    await expect(
      withTransientQueryRetry('op', async () => {
        runs += 1;
        if (runs === 1) throw { code: '57P03', message: 'cannot connect now' };
        throw { code: '42501', message: 'permission denied' };
      }, h.options),
    ).rejects.toMatchObject({ code: '42501' });
    expect(runs).toBe(2);
  });

  it('uses the exported default backoff of 250ms', () => {
    expect(TRANSIENT_RETRY_BACKOFF_MS).toBe(250);
  });
});

// ===========================================================================
// Item 6 — tenant repository list absorbs one blip
// ===========================================================================
describe('tenant repository list — bounded transient retry', () => {
  const WS_A = 'ws-00000000-0000-4000-8000-00000000000a';
  const ownerA: WorkspaceContext = { workspaceId: WS_A, userId: 'user-a-owner', role: 'owner' };

  function seed() {
    const fake = new FakeSupabase();
    fake.seed('automations', [
      { id: 'a1', workspace_id: WS_A, name: 'One' },
      { id: 'a2', workspace_id: WS_A, name: 'Two' },
    ]);
    return fake;
  }

  it('absorbs one transient failure and still returns the scoped rows', async () => {
    const fake = seed();
    const repo = createTenantRepository(fake as unknown as SupabaseClient, ownerA, 'read');
    fake.failNextQuery('automations', { message: 'connection reset by peer', code: '08006' });
    const rows = await repo.automations.list();
    expect(rows.map((r) => r['id'])).toEqual(['a1', 'a2']);
    expect(fake.callsFor('automations', 'select')).toHaveLength(2);
  });

  it('propagates a non-transient failure without retrying', async () => {
    const fake = seed();
    const repo = createTenantRepository(fake as unknown as SupabaseClient, ownerA, 'read');
    fake.failNextQuery('automations', { message: 'boom', code: 'XX000' });
    await expect(repo.automations.list()).rejects.toMatchObject({ code: 'XX000' });
    expect(fake.callsFor('automations', 'select')).toHaveLength(1);
  });

  it('propagates when the transient failure repeats (bounded at one retry)', async () => {
    const fake = seed();
    const repo = createTenantRepository(fake as unknown as SupabaseClient, ownerA, 'read');
    fake.failNextQuery('automations', { message: 'connection reset by peer', code: '08006' });
    fake.failNextQuery('automations', { message: 'connection reset by peer', code: '08006' });
    await expect(repo.automations.list()).rejects.toMatchObject({ code: '08006' });
    expect(fake.callsFor('automations', 'select')).toHaveLength(2);
  });
});

// ===========================================================================
// Item 4 — apiClient timeout + shared session
// ===========================================================================
describe('apiClient — timeout and shared session', () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    vi.resetModules();
    sessionHolder.calls = 0;
    sessionHolder.impl = () =>
      Promise.resolve({ data: { session: { access_token: 'test-token' } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches the session token and returns parsed JSON (unchanged behaviour)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ hello: 'world' }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiClient } = await import('../src/lib/api/client');
    const result = await apiClient<{ hello: string }>('/automations');
    expect(result).toEqual({ hello: 'world' });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('maps a non-OK response to ApiError with status and body (unchanged behaviour)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Nope' }, 403)));
    const { apiClient, ApiError } = await import('../src/lib/api/client');
    await expect(apiClient('/automations')).rejects.toBeInstanceOf(ApiError);
    await expect(apiClient('/automations')).rejects.toMatchObject({ status: 403 });
  });

  it('shares ONE in-flight getSession across concurrent calls, then re-reads after settle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    let release!: (v: { data: { session: { access_token: string } } }) => void;
    sessionHolder.impl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { apiClient } = await import('../src/lib/api/client');
    const pending = [apiClient('/a'), apiClient('/b'), apiClient('/c')];
    // All three calls are in flight; only one getSession was started.
    expect(sessionHolder.calls).toBe(1);
    release({ data: { session: { access_token: 'test-token' } } });
    await expect(Promise.all(pending)).resolves.toHaveLength(3);
    // The memo cleared on settle — a later call reads a fresh session.
    sessionHolder.impl = () =>
      Promise.resolve({ data: { session: { access_token: 'test-token' } } });
    await apiClient('/d');
    expect(sessionHolder.calls).toBe(2);
  });

  it('settles as ApiTimeoutError when the FETCH hangs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    const { apiClient, ApiTimeoutError } = await import('../src/lib/api/client');
    await expect(apiClient('/automations', { timeoutMs: 40 })).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('settles as ApiTimeoutError when getSession hangs (the Web-Lock stall case)', async () => {
    sessionHolder.impl = () => new Promise(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    const { apiClient, ApiTimeoutError } = await import('../src/lib/api/client');
    await expect(apiClient('/automations', { timeoutMs: 40 })).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('a caller-driven abort is NOT misreported as a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    const { apiClient, ApiTimeoutError } = await import('../src/lib/api/client');
    const controller = new AbortController();
    controller.abort();
    const err = await apiClient('/automations', {
      signal: controller.signal,
      timeoutMs: 5_000,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(ApiTimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('skipAuth never touches getSession', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiClient } = await import('../src/lib/api/client');
    await apiClient('/public', { skipAuth: true });
    expect(sessionHolder.calls).toBe(0);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });
});

// ===========================================================================
// Item 3 — scope gating source pins
// ===========================================================================
describe('scope gating — workspace-scoped hooks wait for the scope', () => {
  it('useAutomations is gated on a resolved scope', () => {
    expect(readSrc('hooks/useAutomations.ts')).toContain(
      "enabled: requestScope.kind !== 'unavailable'",
    );
  });

  it('useInstagramAccounts is gated on a resolved scope', () => {
    expect(readSrc('hooks/useInstagramAccounts.ts')).toContain(
      "enabled: requestScope.kind !== 'unavailable'",
    );
  });

  it('useInstagramPosts keeps its account gate AND gains the scope gate', () => {
    expect(readSrc('hooks/useInstagramPosts.ts')).toContain(
      "enabled: !!accountId && requestScope.kind !== 'unavailable'",
    );
  });

  it('useContacts is gated on a resolved scope, transport unchanged', () => {
    const src = readSrc('hooks/useContacts.ts');
    expect(src).toContain("enabled: requestScope.kind !== 'unavailable'");
    // The contacts transport (plain apiClient, no selector) is a
    // pre-existing shape this fix deliberately does not change.
    expect(src).toContain('apiClient<{ contacts: ContactFromDB[] }>');
  });

  it('the three list routes and the repository carry the bounded retry', () => {
    expect(readSrc('app/api/automations/route.ts')).toContain('withTransientQueryRetry');
    expect(readSrc('app/api/instagram/accounts/route.ts')).toContain('withTransientQueryRetry');
    expect(readSrc('app/api/contacts/route.ts')).toContain('withTransientQueryRetry');
    expect(readSrc('lib/tenancy/repository.ts')).toContain('withTransientQueryRetry');
  });
});
