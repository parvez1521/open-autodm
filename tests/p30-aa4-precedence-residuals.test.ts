/**
 * Programme 30 / AA-4 — V-7 residual precedence edge pins.
 *
 * Register item AA-4: diff the PHASE_20 transport report §1c
 * "Not covered" list against Programme 21's unit coverage (45 tests)
 * and Programme 22's live matrix (11/11 on real tokens), and add unit
 * pins ONLY for genuinely uncovered sub-cases. The full coverage map
 * is in saas/PHASE_30_REGISTER_AA6_AA4.md §2. Of the seven §1c
 * bullets, exactly two residuals survived the diff:
 *
 *   R1 — expired Bearer + a valid cookie for a DIFFERENT user.
 *        P21 pinned expired×own-cookie (group B, both layers) and
 *        invalid×foreign-cookie (groups A/B), but the
 *        expired×foreign cell of the grid was pinned nowhere.
 *   R2 — the composed case in its literal form: a REAL route handler
 *        (POST /api/workspaces) with the REAL getAuthenticatedUser
 *        and the REAL createUserRpcClient beneath it — V-7's wording
 *        is "composed real getAuthenticatedUser + real factory in a
 *        route". P21's group E composed the two real functions in
 *        sequence but not through a route handler; P22 exercised
 *        real routes only at Tier-3 (real stack). This file closes
 *        the unit-tier form.
 *
 * Harness: the Programme 21 transport harness, replicated — only the
 * transports beneath the real functions are mocked (capturing fake
 * fetch on the real @supabase/supabase-js client, recording SSR stub,
 * counting cookies() mock, getEnv behind a flag). Neither
 * getAuthenticatedUser, createUserRpcClient, nor the route handler
 * is mocked. "Cookie never consulted" is asserted by counters
 * (cookies() calls = 0 AND SSR constructions = 0), as in P21.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ANON_KEY = 'anon-key-for-p30-tests-0123456789';
const SUPABASE_URL = 'https://proj-p30.example.supabase.co';

const USER_X = { id: 'user-x-1111', email: 'x@example.com' };
const USER_Y = { id: 'user-y-2222', email: 'y@example.com' };

const TOKEN_X = 'jwt-for-x';
const TOKEN_Y = 'jwt-for-y';
const TOKEN_EXPIRED = 'jwt-expired';
const TOKEN_GARBAGE = 'jwt-garbage';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const state = vi.hoisted(() => {
  const tokenToUser = new Map<string, { id: string; email?: string }>();
  const expiredTokens = new Set<string>();
  const captured: CapturedRequest[] = [];
  const ssrCalls: Array<{ url: string; key: string }> = [];
  const counters = { cookies: 0 };
  let cookieUser: { id: string; email?: string } | null = null;

  function normalizeHeaders(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw) return out;
    if (typeof (raw as { forEach?: unknown }).forEach === 'function') {
      (raw as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      return out;
    }
    if (Array.isArray(raw)) {
      for (const [k, v] of raw as Array<[string, string]>) out[k.toLowerCase()] = v;
      return out;
    }
    for (const [k, v] of Object.entries(raw as Record<string, string>)) {
      out[k.toLowerCase()] = String(v);
    }
    return out;
  }

  const fetchImpl = async (input: unknown, init?: { method?: string; headers?: unknown }): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url: string }).url ?? String(input));
    const headers = normalizeHeaders(init?.headers ?? (input as { headers?: unknown })?.headers);
    captured.push({ url, method: init?.method ?? 'GET', headers });
    const json = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.includes('/auth/v1/user')) {
      const auth = headers['authorization'] ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (expiredTokens.has(token)) return json({ message: 'JWT expired' }, 401);
      const user = tokenToUser.get(token);
      if (!user) return json({ message: 'invalid JWT' }, 401);
      return json({ id: user.id, email: user.email, is_anonymous: false }, 200);
    }
    if (url.includes('/rest/v1/rpc/')) {
      return json('rpc-result-id', 200);
    }
    return json({}, 200);
  };

  return {
    tokenToUser,
    expiredTokens,
    captured,
    ssrCalls,
    counters,
    fetchImpl,
    getCookieUser: () => cookieUser,
    setCookieUser: (u: { id: string; email?: string } | null) => {
      cookieUser = u;
    },
  };
});

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  const realCreate = actual.createClient;
  return {
    ...actual,
    createClient: (url: string, key: string, opts?: Record<string, unknown>) => {
      const o = (opts ?? {}) as { global?: Record<string, unknown> };
      return realCreate(url, key, {
        ...(opts as object),
        global: { ...(o.global ?? {}), fetch: state.fetchImpl },
      } as never);
    },
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: (url: string, key: string) => {
    state.ssrCalls.push({ url, key });
    return {
      __isSsrClient: true,
      auth: {
        getUser: async () => {
          if (!state.getCookieUser()) {
            return { data: { user: null }, error: { message: 'no session' } };
          }
          return { data: { user: state.getCookieUser() }, error: null };
        },
      },
      rpc: async () => ({ data: 'cookie-rpc-result', error: null }),
    };
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => {
    state.counters.cookies++;
    return {
      getAll: () => [{ name: 'sb-proj-p30-auth-token', value: 'opaque-session-cookie' }],
      set: vi.fn(),
      get: () => undefined,
    };
  }),
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  }),
}));

import { createUserRpcClient } from '@/lib/supabase/userClient';
import { getAuthenticatedUser } from '@/lib/auth';
import { POST as createWorkspaceRoute } from '@/app/api/workspaces/route';
import { cookies } from 'next/headers';

function rawReq(authorization: string): Request {
  return new Request('https://app.example/api/workspaces', {
    headers: { authorization },
  });
}

function expectCookieNeverConsulted(): void {
  expect(state.counters.cookies, 'cookies() call counter must be 0').toBe(0);
  expect(vi.mocked(cookies).mock.calls, 'cookies() mock must have no calls').toHaveLength(0);
  expect(state.ssrCalls, 'no SSR (cookie) client may be constructed').toEqual([]);
}

const ALLOWLIST_KEYS = ['INSTANCE_ALLOWED_EMAILS', 'INSTANCE_ALLOWED_USER_IDS'] as const;
const savedAllowlist: Record<string, string | undefined> = {};
const ORIGINAL_FLAG = process.env['WORKSPACE_RUNTIME_ENABLED'];

beforeEach(() => {
  for (const key of ALLOWLIST_KEYS) {
    savedAllowlist[key] = process.env[key];
    delete process.env[key];
  }
  state.tokenToUser.clear();
  state.tokenToUser.set(TOKEN_X, USER_X);
  state.tokenToUser.set(TOKEN_Y, USER_Y);
  state.expiredTokens.clear();
  state.expiredTokens.add(TOKEN_EXPIRED);
  state.captured.length = 0;
  state.ssrCalls.length = 0;
  state.counters.cookies = 0;
  vi.mocked(cookies).mockClear();
  state.setCookieUser(null);
});

afterEach(() => {
  for (const key of ALLOWLIST_KEYS) {
    if (savedAllowlist[key] === undefined) delete process.env[key];
    else process.env[key] = savedAllowlist[key];
  }
  if (ORIGINAL_FLAG === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = ORIGINAL_FLAG;
});

describe('R1: expired Bearer + valid FOREIGN-user cookie (the unpinned grid cell)', () => {
  it('R1: factory — EXPIRED lowercase "bearer" + valid cookie for a DIFFERENT user ⇒ 401, cookie never consulted', async () => {
    state.setCookieUser(USER_Y);
    const res = await createUserRpcClient(rawReq(`bearer ${TOKEN_EXPIRED}`), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toBe('Authentication required for this workspace operation');
    }
    expectCookieNeverConsulted();
  });

  it('R1: auth — EXPIRED canonical "Bearer" + valid cookie for a DIFFERENT user ⇒ null (not the cookie user), cookie never consulted', async () => {
    state.setCookieUser(USER_Y);
    const user = await getAuthenticatedUser(rawReq(`Bearer ${TOKEN_EXPIRED}`));
    expect(user).toBeNull();
    expectCookieNeverConsulted();
  });
});

describe('R2: composed in-route (real route handler + real auth + real factory)', () => {
  beforeEach(() => {
    process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  });

  function routeReq(authorization: string): Request {
    return new Request('https://app.example/api/workspaces', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Studio' }),
    });
  }

  it('R2: lowercase "bearer" for X + cookie for Y ⇒ 201; the create_workspace RPC captured carrying X\u2019s JWT + anon apikey; cookie never consulted anywhere in the route flow', async () => {
    state.setCookieUser(USER_Y);
    const res = await createWorkspaceRoute(routeReq(`bearer ${TOKEN_X}`));
    expect(res.status).toBe(201);
    const rpcReq = state.captured.find((c) => c.url.includes('/rest/v1/rpc/create_workspace'));
    expect(rpcReq, 'the RPC must have been issued through the factory client').toBeDefined();
    expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_X}`);
    expect(rpcReq!.headers['apikey']).toBe(ANON_KEY);
    expectCookieNeverConsulted();
  });

  it('R2: canonical "Bearer" for Y + cookie for X ⇒ 201 as the BEARER user (the route user is Y, not the cookie user X)', async () => {
    state.setCookieUser(USER_X);
    const res = await createWorkspaceRoute(routeReq(`Bearer ${TOKEN_Y}`));
    expect(res.status).toBe(201);
    const rpcReq = state.captured.find((c) => c.url.includes('/rest/v1/rpc/create_workspace'));
    expect(rpcReq).toBeDefined();
    expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_Y}`);
    expectCookieNeverConsulted();
  });

  it('R2: INVALID bearer + valid cookie ⇒ 401 from the route; zero RPC requests captured; cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const res = await createWorkspaceRoute(routeReq(`bearer ${TOKEN_GARBAGE}`));
    expect(res.status).toBe(401);
    expect(state.captured.filter((c) => c.url.includes('/rest/v1/rpc/'))).toEqual([]);
    expectCookieNeverConsulted();
  });
});
