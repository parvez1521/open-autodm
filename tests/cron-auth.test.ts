/**
 * Phase 10.4 §4 — S-03: cron endpoint must be HEADER-ONLY.
 *
 * Route under test: src/app/api/cron/process-jobs/route.ts (the only
 * cron route in the repo). Its heavy dependencies (queue engine,
 * Traffic Guard tracker, follow-up sweep, Supabase service client,
 * token refresh) are mocked; the authorization logic, safeCompare and
 * the response shape are the REAL code.
 *
 * Caller trace (see phase10.4-scratch-B): every in-repo caller uses
 * `Authorization: Bearer` — the setup-generated pg_cron snippet
 * (src/app/api/setup/route.ts cronSnippet, jsonb_build_object
 * 'Authorization', 'Bearer …'), Vercel Cron (vercel.json; Vercel sends
 * the CRON_SECRET as a Bearer header), docs/TESTING.md (header). No
 * caller anywhere in src/, docs/, supabase/ or config uses ?secret= —
 * the only occurrence was the fallback in the route itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const SECRET = 'test-cron-secret-0123456789abcdef';

const envState = vi.hoisted(() => ({ secret: null as string | null }));

vi.mock('@/lib/env', () => ({
  getEnv: () => {
    if (envState.secret === null) {
      throw new Error(
        '[open-autoDM] Invalid or missing environment variables:\n' +
          '  - CRON_SECRET: CRON_SECRET must be at least 16 characters'
      );
    }
    return { CRON_SECRET: envState.secret, TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) };
  },
}));

vi.mock('@/lib/automation/engine', () => ({
  processDueJobs: vi.fn(async () => ({ claimed: 0, done: 0, rescheduled: 0, failed: 0, held: 0 })),
}));
vi.mock('@/lib/trafficGuard/tracker', () => ({ evaluateOpenIncidents: vi.fn(async () => 0) }));
vi.mock('@/lib/automation/followUps', () => ({ sweepDueFollowUps: vi.fn(async () => 0) }));
vi.mock('@/lib/instagram/oauth', () => ({ refreshLongLivedToken: vi.fn() }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

const dbStub = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'lt']) chain[m] = () => chain;
  chain['then'] = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
    resolve({ data: [], error: null });
  return {
    from: () => chain,
    rpc: async () => ({ data: null, error: null }),
  };
});
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => dbStub }));

import { GET, POST } from '@/app/api/cron/process-jobs/route';
import { processDueJobs } from '@/lib/automation/engine';

const mockDrain = vi.mocked(processDueJobs);
const BASE = 'https://app.opendm.in/api/cron/process-jobs';

function req(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers });
}

beforeEach(() => {
  envState.secret = SECRET;
  mockDrain.mockClear();
});

describe('S-03 cron auth — header-only Bearer', () => {
  it('valid Bearer header → 200 and the drain runs', async () => {
    const res = await GET(req(BASE, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockDrain).toHaveBeenCalled();
  });

  it('valid Bearer via POST → 200', async () => {
    const res = await POST(req(BASE, { authorization: `Bearer ${SECRET}` }, 'POST'));
    expect(res.status).toBe(200);
    expect(mockDrain).toHaveBeenCalled();
  });

  it('wrong Bearer token → 401, drain never runs', async () => {
    const res = await GET(req(BASE, { authorization: 'Bearer wrong-token-wrong-token' }));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('missing token entirely → 401', async () => {
    const res = await GET(req(BASE));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('POST-FIX: query-only token (?secret=) → 401, drain never runs', async () => {
    const res = await GET(req(`${BASE}?secret=${SECRET}`));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('POST-FIX: query-only token via POST → 401', async () => {
    const res = await POST(req(`${BASE}?secret=${SECRET}`, {}, 'POST'));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('header+query conflict: wrong Bearer header + correct query → 401 (query is ignored)', async () => {
    const res = await GET(
      req(`${BASE}?secret=${SECRET}`, { authorization: 'Bearer wrong-token-wrong-token' })
    );
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('header+query conflict: malformed (non-Bearer) header + correct query → 401', async () => {
    const res = await GET(req(`${BASE}?secret=${SECRET}`, { authorization: `Token ${SECRET}` }));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it.each([
    ['Bearer with no token', 'Bearer'],
    ['Bearer with empty token', 'Bearer '],
    ['Basic scheme carrying the secret', `Basic ${SECRET}`],
    ['lowercase bearer scheme', `bearer ${SECRET}`],
    ['raw secret with no scheme', SECRET],
  ])('malformed Authorization header (%s) → 401', async (_label, header) => {
    const res = await GET(req(BASE, { authorization: header }));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('empty Bearer token + correct query → 401 (no fallback rescue)', async () => {
    const res = await GET(req(`${BASE}?secret=${SECRET}`, { authorization: 'Bearer ' }));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('CRON_SECRET absent (env validation fails) → fail closed: 401, no throw, no drain', async () => {
    envState.secret = null;
    const res = await GET(req(BASE, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('CRON_SECRET absent + query token → still 401 (fail closed on every transport)', async () => {
    envState.secret = null;
    const res = await GET(req(`${BASE}?secret=${SECRET}`));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('neither success nor error responses contain the secret value', async () => {
    const okRes = await GET(req(BASE, { authorization: `Bearer ${SECRET}` }));
    expect(JSON.stringify(await okRes.json())).not.toContain(SECRET);

    const errRes = await GET(req(`${BASE}?secret=${SECRET}`));
    expect(errRes.status).toBe(401);
    const errBody = JSON.stringify(await errRes.json());
    expect(errBody).not.toContain(SECRET);
    expect(errBody).toBe(JSON.stringify({ error: 'Unauthorized' }));
  });
});
