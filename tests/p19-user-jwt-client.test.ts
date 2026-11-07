/**
 * Programme 19 / F-J1 — user-JWT client factory tests
 * (src/lib/supabase/userClient.ts, REAL factory code).
 *
 * Mocking style follows tests/signup-protection.test.ts: the Supabase
 * modules and next/headers are mocked, the code under test is real.
 * For the Bearer path the @supabase/supabase-js mock WRAPS the real
 * createClient and injects a capturing `global.fetch`, so the RPC
 * assertions below observe the ACTUAL outgoing PostgREST request
 * headers (the factory passes global.headers.Authorization — the
 * injected fetch is how supabase-js would send it). The fake fetch
 * also serves Supabase Auth: GET /auth/v1/user resolves a token to a
 * user, rejecting unknown/expired tokens with 401 exactly as GoTrue
 * does. The cookie path's @supabase/ssr client is stubbed (the real
 * SSR cookie format is Next-internal; signup-protection stubs it the
 * same way) and records every construction for identity assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ANON_KEY = 'anon-key-for-p19-tests-0123456789';
const SUPABASE_URL = 'https://proj-p19.example.supabase.co';
const SERVICE_SENTINEL = 'SERVICE-ROLE-SENTINEL-MUST-NEVER-APPEAR-0123456789';

const USER_X = { id: 'user-x-1111', email: 'x@example.com' };
const USER_Y = { id: 'user-y-2222', email: 'y@example.com' };

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
  const ssrClients: Array<Record<string, unknown>> = [];
  const ssrRpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  let cookieUser: { id: string; email?: string } | null = null;
  let cookieError = false;

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
    ssrClients,
    ssrRpcCalls,
    fetchImpl,
    getCookieUser: () => cookieUser,
    setCookieUser: (u: { id: string; email?: string } | null) => {
      cookieUser = u;
    },
    getCookieError: () => cookieError,
    setCookieError: (v: boolean) => {
      cookieError = v;
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
    const client: Record<string, unknown> = {
      __isSsrClient: true,
      auth: {
        getUser: async () => {
          if (state.getCookieError() || !state.getCookieUser()) {
            return { data: { user: null }, error: { message: 'no session' } };
          }
          return { data: { user: state.getCookieUser() }, error: null };
        },
      },
      rpc: async (name: string, params: Record<string, unknown>) => {
        state.ssrRpcCalls.push({ name, params });
        return { data: 'cookie-rpc-result', error: null };
      },
    };
    state.ssrClients.push(client);
    return client;
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [{ name: 'sb-proj-p19-auth-token', value: 'opaque-session-cookie' }],
    set: vi.fn(),
    get: () => undefined,
  })),
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  }),
}));

import { createUserRpcClient } from '@/lib/supabase/userClient';

function bearerReq(token: string): Request {
  return new Request('https://app.example/api/workspaces', {
    headers: { authorization: `Bearer ${token}` },
  });
}
function plainReq(): Request {
  return new Request('https://app.example/api/workspaces');
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
let logOutput: string[] = [];

beforeEach(() => {
  state.tokenToUser.clear();
  state.tokenToUser.set('jwt-for-x', USER_X);
  state.tokenToUser.set('jwt-for-y', USER_Y);
  state.expiredTokens.clear();
  state.expiredTokens.add('jwt-expired');
  state.captured.length = 0;
  state.ssrCalls.length = 0;
  state.ssrClients.length = 0;
  state.ssrRpcCalls.length = 0;
  state.setCookieUser(null);
  state.setCookieError(false);
  logOutput = [];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logOutput.push(args.map((a) => String(a)).join(' '));
    }),
  );
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe('Bearer path', () => {
  it('valid JWT for the expected user ⇒ ok, and the RPC request carries Authorization: Bearer <jwt> (actual outgoing PostgREST headers)', async () => {
    const res = await createUserRpcClient(bearerReq('jwt-for-x'), USER_X.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    state.captured.length = 0; // drop the verification request; observe only the RPC
    const { data, error } = await res.client.rpc('create_workspace', { p_name: 'Studio' });
    expect(error).toBeNull();
    expect(data).toBe('rpc-result-id');
    const rpcReq = state.captured.find((c) => c.url.includes('/rest/v1/rpc/create_workspace'));
    expect(rpcReq, 'an RPC request must have been sent').toBeDefined();
    expect(rpcReq!.method).toBe('POST');
    expect(rpcReq!.headers['authorization']).toBe('Bearer jwt-for-x');
    expect(rpcReq!.headers['apikey']).toBe(ANON_KEY);
    expect(JSON.stringify(rpcReq!.headers)).not.toContain(SERVICE_SENTINEL);
  });

  it('missing Bearer + no cookie session ⇒ fail closed (401)', async () => {
    const res = await createUserRpcClient(plainReq(), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('invalid JWT ⇒ fail closed (401)', async () => {
    const res = await createUserRpcClient(bearerReq('jwt-garbage'), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('expired JWT ⇒ fail closed (401)', async () => {
    const res = await createUserRpcClient(bearerReq('jwt-expired'), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('valid JWT for a DIFFERENT user than expectedUserId ⇒ reject (403), no client issued', async () => {
    const res = await createUserRpcClient(bearerReq('jwt-for-y'), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(JSON.stringify(res)).not.toContain('jwt-for-y');
    }
  });

  it('invalid Bearer + valid cookie for the expected user ⇒ fail (NO cookie fallback; SSR path never consulted)', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(bearerReq('jwt-garbage'), USER_X.id);
    expect(res.ok).toBe(false);
    expect(state.ssrCalls).toEqual([]);
  });
});

describe('cookie path', () => {
  it('valid cookie session ⇒ ok; the returned client IS the SSR client (anon key), and its RPC is the user identity', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(plainReq(), USER_X.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(state.ssrCalls).toEqual([{ url: SUPABASE_URL, key: ANON_KEY }]);
    expect(res.client as unknown).toBe(state.ssrClients[0]);
    const { data, error } = await (res.client as unknown as Record<string, Function>)['rpc']!(
      'create_workspace',
      { p_name: 'Studio' },
    ) as { data: unknown; error: unknown };
    expect(error).toBeNull();
    expect(data).toBe('cookie-rpc-result');
    expect(state.ssrRpcCalls).toEqual([{ name: 'create_workspace', params: { p_name: 'Studio' } }]);
  });

  it('missing session ⇒ fail closed (401)', async () => {
    state.setCookieUser(null);
    const res = await createUserRpcClient(plainReq(), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('expired/invalid session (auth error) ⇒ fail closed (401)', async () => {
    state.setCookieUser(USER_X);
    state.setCookieError(true);
    const res = await createUserRpcClient(plainReq(), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('cookie user !== expectedUserId ⇒ reject (403)', async () => {
    state.setCookieUser(USER_Y);
    const res = await createUserRpcClient(plainReq(), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it('cookie-path client is built from the SSR path with the ANON key — no service-role identity anywhere', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(plainReq(), USER_X.id);
    expect(res.ok).toBe(true);
    expect(state.ssrCalls[0]!.key).toBe(ANON_KEY);
    expect(state.ssrCalls[0]!.key).not.toBe(SERVICE_SENTINEL);
    // The cookie path never builds a supabase-js (Bearer-style) client:
    // no fetch traffic was generated by construction.
    expect(state.captured.filter((c) => c.headers['apikey'] === SERVICE_SENTINEL)).toEqual([]);
  });
});

describe('transport conflicts (Bearer governs, exactly as getAuthenticatedUser)', () => {
  it('both transports, same user ⇒ ok via the Bearer client (SSR never consulted)', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(bearerReq('jwt-for-x'), USER_X.id);
    expect(res.ok).toBe(true);
    expect(state.ssrCalls).toEqual([]);
    if (!res.ok) return;
    state.captured.length = 0;
    await res.client.rpc('create_workspace', { p_name: 'S' });
    const rpcReq = state.captured.find((c) => c.url.includes('/rest/v1/rpc/'));
    expect(rpcReq!.headers['authorization']).toBe('Bearer jwt-for-x');
  });

  it('Bearer valid for expected X, cookie user Y ⇒ client is the Bearer one (ok)', async () => {
    state.setCookieUser(USER_Y);
    const res = await createUserRpcClient(bearerReq('jwt-for-x'), USER_X.id);
    expect(res.ok).toBe(true);
    expect(state.ssrCalls).toEqual([]);
    if (!res.ok) return;
    expect(res.client as unknown).not.toBe(state.ssrClients[0]);
  });

  it('Bearer valid for Y while the route user is X (cookie matches X) ⇒ reject — Bearer governs', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(bearerReq('jwt-for-y'), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });
});

describe('hygiene', () => {
  it('factory source contains no service-role key reference and no privileged-client factory reference (pin)', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/lib/supabase/userClient.ts'), 'utf8');
    expect(src).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(src).not.toContain('createServiceClient');
    expect(src).not.toContain('console.');
  });

  it('error results contain no token substring', async () => {
    const invalid = await createUserRpcClient(bearerReq('jwt-garbage-secret'), USER_X.id);
    expect(JSON.stringify(invalid)).not.toContain('jwt-garbage-secret');
    const mismatch = await createUserRpcClient(bearerReq('jwt-for-y'), USER_X.id);
    expect(JSON.stringify(mismatch)).not.toContain('jwt-for-y');
  });

  it('no caching: two factory calls return distinct client instances (Bearer and cookie paths)', async () => {
    const a = await createUserRpcClient(bearerReq('jwt-for-x'), USER_X.id);
    const b = await createUserRpcClient(bearerReq('jwt-for-x'), USER_X.id);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.client).not.toBe(b.client);

    state.setCookieUser(USER_X);
    const c = await createUserRpcClient(plainReq(), USER_X.id);
    const d = await createUserRpcClient(plainReq(), USER_X.id);
    expect(c.ok && d.ok).toBe(true);
    if (c.ok && d.ok) expect(c.client).not.toBe(d.client);
  });

  it('no JWT appears in any log output during factory + RPC flow', async () => {
    const res = await createUserRpcClient(bearerReq('jwt-for-x'), USER_X.id);
    expect(res.ok).toBe(true);
    if (res.ok) await res.client.rpc('create_workspace', { p_name: 'Studio' });
    await createUserRpcClient(bearerReq('jwt-garbage'), USER_X.id);
    expect(logOutput.join('\n')).not.toContain('jwt-for-x');
    expect(logOutput.join('\n')).not.toContain('jwt-garbage');
  });
});
