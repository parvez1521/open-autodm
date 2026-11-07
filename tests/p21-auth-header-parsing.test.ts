/**
 * Programme 21 — Authorization header parsing hardening.
 *
 * THE DEFECT (proven pre-fix in saas/phase21-probe-before.txt): both
 * user-auth layers recognised the Bearer scheme only via the literal
 * case-sensitive prefix `Bearer `, although RFC 9110 §11.1 makes scheme
 * names case-insensitive. A valid credential sent as `bearer <jwt>` or
 * `BEARER <jwt>` was therefore NOT recognised as Bearer at all and
 * silently fell through to cookie authentication — the request
 * authenticated as the cookie user (or failed), in both
 *   - src/lib/auth.ts                (getAuthenticatedUser), and
 *   - src/lib/supabase/userClient.ts (createUserRpcClient, F-J1 factory).
 * Workstream A fixed this with ONE shared parser
 * (src/lib/bearerToken.ts, parseBearerToken) used by both layers:
 * scheme compared ASCII case-insensitively; separator = one or more SP,
 * all consumed; token = remainder byte-for-byte; bare Bearer scheme ⇒
 * token '' (malformed ⇒ fail closed, never a cookie fallback); a tab is
 * not a separator. This suite is the AFTER evidence: it pins that both
 * REAL layers now agree on every header shape.
 *
 * Harness (modelled on tests/p19-user-jwt-client.test.ts +
 * tests/signup-protection.test.ts): only the transports beneath the two
 * real functions are mocked — never either function itself.
 *   - @supabase/supabase-js is mocked by WRAPPING the real createClient
 *     and injecting a capturing fake `global.fetch`: GET /auth/v1/user
 *     resolves a token→user map (unknown ⇒ 401 'invalid JWT'; an
 *     expired set ⇒ 401 'JWT expired'); /rest/v1/rpc/* ⇒ 200
 *     'rpc-result-id'; every request (url, method, normalized headers)
 *     is recorded. A hoisted flag makes the /auth/v1/user fetch THROW.
 *   - @supabase/ssr createServerClient is a stub that RECORDS
 *     constructions (url+key); auth.getUser() returns a configurable
 *     cookie user / error; rpc() records calls.
 *   - next/headers cookies() is a vi.fn with a call counter (hoisted
 *     counter + mock call log) and a hoisted flag to make it THROW.
 *   - @/lib/env getEnv is mocked behind a hoisted flag: normally the
 *     fake URL/anon key; when the flag is set it THROWS.
 *   - Console spies capture all log output (p19 style).
 *
 * Groups: A scheme casing · B cookie-fallback protection · C identity ·
 * D factory failure handling · E composed (real auth + real factory on
 * the SAME Request) · §5 regression pins incl. the layer-agreement
 * matrix. Wherever Bearer is selected, "cookie never consulted" is
 * asserted EXPLICITLY via counters (cookies() calls = 0 AND SSR
 * constructions = 0), never inferred from the outcome alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ANON_KEY = 'anon-key-for-p21-tests-0123456789';
const SUPABASE_URL = 'https://proj-p21.example.supabase.co';

const USER_X = { id: 'user-x-1111', email: 'x@example.com' };
const USER_Y = { id: 'user-y-2222', email: 'y@example.com' };

const TOKEN_X = 'jwt-for-x';
const TOKEN_Y = 'jwt-for-y';
const TOKEN_EXPIRED = 'jwt-expired';
const TOKEN_GARBAGE = 'jwt-garbage';
/** Mixed-case token mapped to USER_X: pins the token is never lowercased/trimmed — only the scheme is case-folded. */
const TOKEN_MIXED_CASE = 'JwT-MixedCase-X';
const ALL_TOKENS = [TOKEN_X, TOKEN_Y, TOKEN_EXPIRED, TOKEN_GARBAGE, TOKEN_MIXED_CASE];

/** Distinctive internals that must never leak into a serialized result or a log line. */
const VERIFIER_THROW_DETAIL = 'p21-simulated-verifier-network-failure-internal-detail';
const ENV_THROW_DETAIL = 'p21-simulated-env-unavailable-internal-detail';

const GENERIC_401 = 'Authentication required for this workspace operation';
const GENERIC_500 = 'Workspace authentication is unavailable';

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
  const counters = { cookies: 0 };
  let cookieUser: { id: string; email?: string } | null = null;
  let cookieError = false;
  let cookiesThrows = false;
  let authFetchThrows = false;
  let envThrows = false;

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
      if (authFetchThrows) {
        // Verifier transport failure (hoisted flag): the fetch itself throws.
        throw new Error('p21-simulated-verifier-network-failure-internal-detail');
      }
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
    counters,
    fetchImpl,
    getCookieUser: () => cookieUser,
    setCookieUser: (u: { id: string; email?: string } | null) => {
      cookieUser = u;
    },
    getCookieError: () => cookieError,
    setCookieError: (v: boolean) => {
      cookieError = v;
    },
    getCookiesThrows: () => cookiesThrows,
    setCookiesThrows: (v: boolean) => {
      cookiesThrows = v;
    },
    getAuthFetchThrows: () => authFetchThrows,
    setAuthFetchThrows: (v: boolean) => {
      authFetchThrows = v;
    },
    getEnvThrows: () => envThrows,
    setEnvThrows: (v: boolean) => {
      envThrows = v;
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
  cookies: vi.fn(async () => {
    state.counters.cookies++;
    if (state.getCookiesThrows()) {
      throw new Error('p21 simulated cookie store failure');
    }
    return {
      getAll: () => [{ name: 'sb-proj-p21-auth-token', value: 'opaque-session-cookie' }],
      set: vi.fn(),
      get: () => undefined,
    };
  }),
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => {
    if (state.getEnvThrows()) {
      throw new Error('p21-simulated-env-unavailable-internal-detail');
    }
    return {
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    };
  },
}));

import { createUserRpcClient, type UserRpcClientResult } from '@/lib/supabase/userClient';
import { getAuthenticatedUser } from '@/lib/auth';
import { cookies } from 'next/headers';

/** Build a request carrying an arbitrary RAW Authorization value (any casing); null ⇒ no header at all. */
function rawReq(authorization: string | null): Request {
  if (authorization === null) return new Request('https://app.example/api/workspaces');
  return new Request('https://app.example/api/workspaces', {
    headers: { authorization },
  });
}

/** Clear ONLY the transport-observation state (token map / cookie user / flags are kept). */
function resetTransportCounters(): void {
  state.captured.length = 0;
  state.ssrCalls.length = 0;
  state.ssrClients.length = 0;
  state.ssrRpcCalls.length = 0;
  state.counters.cookies = 0;
  vi.mocked(cookies).mockClear();
}

/**
 * EXPLICIT not-consulted pin for every Bearer-selected flow: the cookie
 * transport must not merely lose — it must never be touched at all.
 */
function expectCookieNeverConsulted(): void {
  expect(state.counters.cookies, 'cookies() call counter must be 0').toBe(0);
  expect(vi.mocked(cookies).mock.calls, 'cookies() mock must have no calls').toHaveLength(0);
  expect(state.ssrCalls, 'no SSR (cookie) client may be constructed').toEqual([]);
}

function expectFactory401(res: UserRpcClientResult): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(401);
    expect(res.error).toBe(GENERIC_401);
  }
}

/** Run an RPC on a factory-issued Bearer client and return the captured PostgREST request. */
async function captureRpc(
  client: { rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
): Promise<CapturedRequest | undefined> {
  state.captured.length = 0; // drop the verification request; observe only the RPC
  const { data, error } = await client.rpc('create_workspace', { p_name: 'Studio' });
  expect(error).toBeNull();
  expect(data).toBe('rpc-result-id');
  return state.captured.find((c) => c.url.includes('/rest/v1/rpc/create_workspace'));
}

const ALLOWLIST_KEYS = ['INSTANCE_ALLOWED_EMAILS', 'INSTANCE_ALLOWED_USER_IDS'] as const;
const savedAllowlist: Record<string, string | undefined> = {};

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
let logOutput: string[] = [];

beforeEach(() => {
  for (const key of ALLOWLIST_KEYS) {
    savedAllowlist[key] = process.env[key];
    delete process.env[key];
  }
  state.tokenToUser.clear();
  state.tokenToUser.set(TOKEN_X, USER_X);
  state.tokenToUser.set(TOKEN_Y, USER_Y);
  state.tokenToUser.set(TOKEN_MIXED_CASE, USER_X);
  state.expiredTokens.clear();
  state.expiredTokens.add(TOKEN_EXPIRED);
  resetTransportCounters();
  state.setCookieUser(null);
  state.setCookieError(false);
  state.setCookiesThrows(false);
  state.setAuthFetchThrows(false);
  state.setEnvThrows(false);
  logOutput = [];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logOutput.push(args.map((a) => String(a)).join(' '));
    }),
  );
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  for (const key of ALLOWLIST_KEYS) {
    if (savedAllowlist[key] === undefined) delete process.env[key];
    else process.env[key] = savedAllowlist[key];
  }
});

// ── GROUP A — scheme casing ──────────────────────────────────────────────

describe('A: scheme casing', () => {
  it.each(['bearer', 'BEARER', 'BeArEr'])(
    'A: factory accepts scheme "%s" for X; RPC carries canonical "Bearer jwt-for-x" + anon apikey; cookie never consulted',
    async (scheme) => {
      state.setCookieUser(USER_Y); // a foreign cookie must be irrelevant once Bearer is selected
      const res = await createUserRpcClient(rawReq(`${scheme} ${TOKEN_X}`), USER_X.id);
      expect(res.ok).toBe(true);
      expectCookieNeverConsulted();
      if (!res.ok) return;
      const rpcReq = await captureRpc(res.client);
      expect(rpcReq, 'an RPC request must have been sent').toBeDefined();
      // Canonical re-emission: whatever casing arrived, PostgREST sees exactly `Bearer <token>`.
      expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_X}`);
      expect(rpcReq!.headers['apikey']).toBe(ANON_KEY);
    },
  );

  it('A: factory token fidelity — "bearer JwT-MixedCase-X" verifies and is re-emitted byte-for-byte (token never case-folded)', async () => {
    const res = await createUserRpcClient(rawReq(`bearer ${TOKEN_MIXED_CASE}`), USER_X.id);
    expect(res.ok).toBe(true);
    expectCookieNeverConsulted();
    if (!res.ok) return;
    const rpcReq = await captureRpc(res.client);
    expect(rpcReq).toBeDefined();
    expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_MIXED_CASE}`);
    expect(rpcReq!.headers['apikey']).toBe(ANON_KEY);
  });

  it('A: auth layer — lowercase "bearer jwt-for-x" resolves USER_X, not the cookie user Y; cookie never consulted', async () => {
    state.setCookieUser(USER_Y);
    const user = await getAuthenticatedUser(rawReq(`bearer ${TOKEN_X}`));
    expect(user).toMatchObject({ id: USER_X.id, email: USER_X.email });
    expectCookieNeverConsulted();
  });

  it('A: auth layer — uppercase "BEARER jwt-for-x" resolves USER_X, not the cookie user Y; cookie never consulted', async () => {
    state.setCookieUser(USER_Y);
    const user = await getAuthenticatedUser(rawReq(`BEARER ${TOKEN_X}`));
    expect(user).toMatchObject({ id: USER_X.id, email: USER_X.email });
    expectCookieNeverConsulted();
  });

  it('A: factory — INVALID lowercase "bearer jwt-garbage" + valid cookie for the EXPECTED user ⇒ 401, cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(rawReq(`bearer ${TOKEN_GARBAGE}`), USER_X.id);
    expectFactory401(res);
    expectCookieNeverConsulted();
  });

  it('A: auth — INVALID lowercase "bearer jwt-garbage" + valid cookie for the EXPECTED user ⇒ null, cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const user = await getAuthenticatedUser(rawReq(`bearer ${TOKEN_GARBAGE}`));
    expect(user).toBeNull();
    expectCookieNeverConsulted();
  });

  it('A: factory — INVALID lowercase "bearer jwt-garbage" + valid cookie for a DIFFERENT user ⇒ 401, cookie never consulted', async () => {
    state.setCookieUser(USER_Y);
    const res = await createUserRpcClient(rawReq(`bearer ${TOKEN_GARBAGE}`), USER_X.id);
    expectFactory401(res);
    expectCookieNeverConsulted();
  });

  it('A: auth — INVALID lowercase "bearer jwt-garbage" + valid cookie for a DIFFERENT user ⇒ null (not the cookie user), cookie never consulted', async () => {
    state.setCookieUser(USER_Y);
    const user = await getAuthenticatedUser(rawReq(`bearer ${TOKEN_GARBAGE}`));
    expect(user).toBeNull();
    expectCookieNeverConsulted();
  });

  it('A: factory — bare "bearer" (no token) + valid cookie ⇒ 401, cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(rawReq('bearer'), USER_X.id);
    expectFactory401(res);
    expectCookieNeverConsulted();
  });

  it('A: auth — "Bearer " (trailing space) + valid cookie ⇒ null, cookie never consulted', async () => {
    // NOTE: `new Request` header normalization trims trailing spaces, so a
    // 'Bearer ' value arrives as bare 'Bearer' — that IS the empty-token
    // case, and it must fail closed exactly like the literal bare scheme.
    const req = rawReq('Bearer ');
    expect(req.headers.get('authorization')).toBe('Bearer');
    state.setCookieUser(USER_X);
    const user = await getAuthenticatedUser(req);
    expect(user).toBeNull();
    expectCookieNeverConsulted();
  });

  it('A: factory — bare "BEARER" (no token) + valid cookie ⇒ 401, cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(rawReq('BEARER'), USER_X.id);
    expectFactory401(res);
    expectCookieNeverConsulted();
  });
});

// ── GROUP B — cookie-fallback protection ─────────────────────────────────

describe('B: cookie-fallback protection', () => {
  it('B: factory — EXPIRED lowercase "bearer jwt-expired" + valid cookie (expected user) ⇒ 401, cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(rawReq(`bearer ${TOKEN_EXPIRED}`), USER_X.id);
    expectFactory401(res);
    expectCookieNeverConsulted();
  });

  it('B: auth — EXPIRED lowercase "bearer jwt-expired" + valid cookie (expected user) ⇒ null, cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const user = await getAuthenticatedUser(rawReq(`bearer ${TOKEN_EXPIRED}`));
    expect(user).toBeNull();
    expectCookieNeverConsulted();
  });

  it('B: factory — invalid "Bearer jwt-garbage" + FOREIGN cookie (P20 gap case) ⇒ 401, cookie never consulted, no RPC issued', async () => {
    // The P20-recorded coverage gap at factory level with the canonical
    // scheme casing: an invalid Bearer beside a foreign (different-user)
    // cookie must fail as unauthenticated — never resolve via the cookie
    // and never reach an identity comparison against it.
    state.setCookieUser(USER_Y);
    const res = await createUserRpcClient(rawReq(`Bearer ${TOKEN_GARBAGE}`), USER_X.id);
    expectFactory401(res);
    expectCookieNeverConsulted();
    expect(state.captured.filter((c) => c.url.includes('/rest/v1/rpc/'))).toEqual([]);
  });

  it('B: factory — valid Bearer + ERRORING cookie store (cookies() throws) ⇒ ok via Bearer; cookies() calls = 0, SSR constructions = 0', async () => {
    state.setCookiesThrows(true);
    state.setCookieUser(USER_X);
    const res = await createUserRpcClient(rawReq(`Bearer ${TOKEN_X}`), USER_X.id);
    expect(res.ok).toBe(true);
    expectCookieNeverConsulted();
    if (!res.ok) return;
    const rpcReq = await captureRpc(res.client);
    expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_X}`);
  });

  it('B: auth — valid lowercase Bearer + ERRORING cookie store (cookies() throws) ⇒ resolves X; cookies() calls = 0, SSR constructions = 0', async () => {
    state.setCookiesThrows(true);
    state.setCookieUser(USER_X);
    const user = await getAuthenticatedUser(rawReq(`bearer ${TOKEN_X}`));
    expect(user).toMatchObject({ id: USER_X.id, email: USER_X.email });
    expectCookieNeverConsulted();
  });
});

// ── GROUP C — identity ───────────────────────────────────────────────────

describe('C: identity', () => {
  it('C: factory — valid "bearer jwt-for-y" with expectedUserId = X ⇒ 403 BEFORE any client/RPC; no /rest/v1/rpc/ request captured', async () => {
    const res = await createUserRpcClient(rawReq(`bearer ${TOKEN_Y}`), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(JSON.stringify(res)).not.toContain(TOKEN_Y);
    }
    expect(state.captured.filter((c) => c.url.includes('/rest/v1/rpc/'))).toEqual([]);
    expectCookieNeverConsulted();
  });

  it('C: factory — different-user cookie (Y) + valid lowercase Bearer for X ⇒ ok as X (cookie cannot change the selected identity)', async () => {
    state.setCookieUser(USER_Y);
    const res = await createUserRpcClient(rawReq(`bearer ${TOKEN_X}`), USER_X.id);
    expect(res.ok).toBe(true);
    expectCookieNeverConsulted();
    if (!res.ok) return;
    const rpcReq = await captureRpc(res.client);
    expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_X}`);
    expect(rpcReq!.headers['apikey']).toBe(ANON_KEY);
  });

  it('C: auth — different-user cookie (Y) + valid "BEARER jwt-for-x" ⇒ returns X', async () => {
    state.setCookieUser(USER_Y);
    const user = await getAuthenticatedUser(rawReq(`BEARER ${TOKEN_X}`));
    expect(user).toMatchObject({ id: USER_X.id, email: USER_X.email });
    expectCookieNeverConsulted();
  });
});

// ── GROUP D — factory failure handling ───────────────────────────────────

describe('D: factory failure handling', () => {
  it('D: verifier throws (fetch throws on /auth/v1/user) ⇒ 401 with ONLY the generic error; no token, no thrown internals in the result', async () => {
    state.setAuthFetchThrows(true);
    const res = await createUserRpcClient(rawReq(`Bearer ${TOKEN_X}`), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toBe(GENERIC_401);
    }
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(TOKEN_X);
    expect(serialized).not.toContain(VERIFIER_THROW_DETAIL);
  });

  it('D: env unavailable (getEnv throws) ⇒ 500 with ONLY the generic error; no token, no thrown internals, no fetch traffic', async () => {
    state.setEnvThrows(true);
    const res = await createUserRpcClient(rawReq(`Bearer ${TOKEN_X}`), USER_X.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(500);
      expect(res.error).toBe(GENERIC_500);
    }
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(TOKEN_X);
    expect(serialized).not.toContain(ENV_THROW_DETAIL);
    expect(state.captured).toEqual([]);
    expectCookieNeverConsulted();
  });

  it('D: empty expectedUserId ("") with a valid Bearer ⇒ 401 AND zero fetch traffic (short-circuit before any verification)', async () => {
    const res = await createUserRpcClient(rawReq(`Bearer ${TOKEN_X}`), '');
    expectFactory401(res);
    expect(state.captured).toEqual([]);
    expectCookieNeverConsulted();
  });
});

// ── GROUP E — composed: REAL auth + REAL factory on the SAME Request ────

describe('E: composed (real getAuthenticatedUser + real createUserRpcClient, same Request)', () => {
  it('E: lowercase "bearer jwt-for-x" — auth ⇒ X; factory(req, X.id) ⇒ ok; RPC create_workspace captured with the user JWT + anon apikey', async () => {
    state.setCookieUser(USER_Y); // foreign cookie present: Bearer must govern the whole composed flow
    const req = rawReq(`bearer ${TOKEN_X}`);
    const user = await getAuthenticatedUser(req);
    expect(user).toMatchObject({ id: USER_X.id, email: USER_X.email });
    const res = await createUserRpcClient(req, user!.id);
    expect(res.ok).toBe(true);
    expectCookieNeverConsulted();
    if (!res.ok) return;
    const rpcReq = await captureRpc(res.client);
    expect(rpcReq).toBeDefined();
    expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_X}`);
    expect(rpcReq!.headers['apikey']).toBe(ANON_KEY);
  });

  it('E: uppercase "BEARER jwt-for-x" — auth ⇒ X; factory(req, X.id) ⇒ ok; RPC create_workspace captured with the user JWT + anon apikey', async () => {
    state.setCookieUser(USER_Y);
    const req = rawReq(`BEARER ${TOKEN_X}`);
    const user = await getAuthenticatedUser(req);
    expect(user).toMatchObject({ id: USER_X.id, email: USER_X.email });
    const res = await createUserRpcClient(req, user!.id);
    expect(res.ok).toBe(true);
    expectCookieNeverConsulted();
    if (!res.ok) return;
    const rpcReq = await captureRpc(res.client);
    expect(rpcReq).toBeDefined();
    expect(rpcReq!.headers['authorization']).toBe(`Bearer ${TOKEN_X}`);
    expect(rpcReq!.headers['apikey']).toBe(ANON_KEY);
  });

  it('E: invalid lowercase bearer — auth ⇒ null and cookie counters stay 0 (the route would 401 before the factory is ever called)', async () => {
    state.setCookieUser(USER_X);
    const req = rawReq(`bearer ${TOKEN_GARBAGE}`);
    const user = await getAuthenticatedUser(req);
    expect(user).toBeNull();
    // Route sequence stops here: createUserRpcClient is never invoked on a
    // null route identity, so there is nothing further to compose.
    expectCookieNeverConsulted();
  });

  it('E: Bearer for Y + cookie for X — auth ⇒ Y (Bearer governs); factory(req, Y.id) ⇒ ok; factory(req, X.id) ⇒ 403', async () => {
    state.setCookieUser(USER_X);
    const req = rawReq(`Bearer ${TOKEN_Y}`);
    const user = await getAuthenticatedUser(req);
    expect(user).toMatchObject({ id: USER_Y.id, email: USER_Y.email });

    const asY = await createUserRpcClient(req, USER_Y.id);
    expect(asY.ok).toBe(true);

    const asX = await createUserRpcClient(req, USER_X.id);
    expect(asX.ok).toBe(false);
    if (!asX.ok) expect(asX.status).toBe(403);

    expectCookieNeverConsulted();
  });

  it('E: bare "bearer" + valid cookie for X — auth ⇒ null, cookie never consulted', async () => {
    state.setCookieUser(USER_X);
    const req = rawReq('bearer');
    const user = await getAuthenticatedUser(req);
    expect(user).toBeNull();
    expectCookieNeverConsulted();
  });
});

// ── §5 REGRESSION PINS ───────────────────────────────────────────────────

describe('§5: regression pins', () => {
  const readSrc = (rel: string): string =>
    readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

  it('§5: source pin — userClient.ts contains no service-role key reference and no privileged-client factory', () => {
    const src = readSrc('lib/supabase/userClient.ts');
    expect(src).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(src).not.toContain('createServiceClient');
  });

  it('§5: source pin — bearerToken.ts contains no service-role key reference and no privileged-client factory', () => {
    const src = readSrc('lib/bearerToken.ts');
    expect(src).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(src).not.toContain('createServiceClient');
  });

  it('§5: source pin — auth.ts contains no service-role key reference and no privileged-client factory', () => {
    const src = readSrc('lib/auth.ts');
    expect(src).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(src).not.toContain('createServiceClient');
  });

  it('§5: source pin — bearerToken.ts is pure: no logging and no environment access', () => {
    const src = readSrc('lib/bearerToken.ts');
    expect(src).not.toContain('console.');
    expect(src).not.toContain('process.env');
  });

  type TransportClass = 'bearer-selected' | 'cookie-selected' | 'fail-closed-without-cookie';

  function classify(ok: boolean, cookiesCalls: number, ssrCalls: number): TransportClass {
    const consulted = cookiesCalls > 0 || ssrCalls > 0;
    if (!consulted) return ok ? 'bearer-selected' : 'fail-closed-without-cookie';
    return 'cookie-selected';
  }

  const MATRIX: Array<{ label: string; header: string | null; expected: TransportClass }> = [
    { label: "canonical 'Bearer jwt-for-x'", header: `Bearer ${TOKEN_X}`, expected: 'bearer-selected' },
    { label: "lowercase 'bearer jwt-for-x'", header: `bearer ${TOKEN_X}`, expected: 'bearer-selected' },
    { label: "uppercase 'BEARER jwt-for-x'", header: `BEARER ${TOKEN_X}`, expected: 'bearer-selected' },
    { label: "mixed-case 'BeArEr jwt-for-x'", header: `BeArEr ${TOKEN_X}`, expected: 'bearer-selected' },
    { label: "lowercase invalid 'bearer jwt-garbage'", header: `bearer ${TOKEN_GARBAGE}`, expected: 'fail-closed-without-cookie' },
    { label: "bare 'Bearer'", header: 'Bearer', expected: 'fail-closed-without-cookie' },
    { label: "other scheme 'Basic abc'", header: 'Basic abc', expected: 'cookie-selected' },
    { label: "other scheme 'Token abc'", header: 'Token abc', expected: 'cookie-selected' },
    { label: 'no Authorization header', header: null, expected: 'cookie-selected' },
    { label: "expired 'Bearer jwt-expired'", header: `Bearer ${TOKEN_EXPIRED}`, expected: 'fail-closed-without-cookie' },
  ];

  it.each(MATRIX)(
    '§5: layer-agreement matrix — $label ⇒ both layers select "$expected"',
    async ({ header, expected }) => {
      state.setCookieUser(USER_X); // a valid cookie for the expected user is always available

      // Layer 1: REAL getAuthenticatedUser on its own Request.
      const authUser = await getAuthenticatedUser(rawReq(header));
      const authClass = classify(authUser !== null, state.counters.cookies, state.ssrCalls.length);
      if (expected === 'fail-closed-without-cookie') {
        expect(authUser).toBeNull();
      } else {
        expect(authUser).toMatchObject({ id: USER_X.id });
      }

      // Layer 2: REAL createUserRpcClient on a fresh, identical Request,
      // with the transport counters reset so each layer is judged alone.
      resetTransportCounters();
      const factoryRes = await createUserRpcClient(rawReq(header), USER_X.id);
      const factoryClass = classify(factoryRes.ok, state.counters.cookies, state.ssrCalls.length);
      if (expected === 'fail-closed-without-cookie') {
        expect(factoryRes.ok).toBe(false);
        if (!factoryRes.ok) expect(factoryRes.status).toBe(401);
      } else {
        expect(factoryRes.ok).toBe(true);
      }

      // The pin itself: the two layers cannot disagree.
      expect(authClass).toBe(expected);
      expect(factoryClass).toBe(expected);
      expect(factoryClass).toBe(authClass);
    },
  );

  it('§5: instance isolation — two factory calls with a lowercase Bearer return distinct client instances', async () => {
    const a = await createUserRpcClient(rawReq(`bearer ${TOKEN_X}`), USER_X.id);
    const b = await createUserRpcClient(rawReq(`bearer ${TOKEN_X}`), USER_X.id);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.client).not.toBe(b.client);
  });

  it('§5: no logging — after a batch of Bearer/cookie flows, no token string appears in any console output', async () => {
    state.setCookieUser(USER_X);
    const okRes = await createUserRpcClient(rawReq(`bearer ${TOKEN_X}`), USER_X.id);
    expect(okRes.ok).toBe(true);
    if (okRes.ok) await okRes.client.rpc('create_workspace', { p_name: 'Studio' });
    await createUserRpcClient(rawReq(`Bearer ${TOKEN_MIXED_CASE}`), USER_X.id);
    await createUserRpcClient(rawReq(`bearer ${TOKEN_GARBAGE}`), USER_X.id);
    await createUserRpcClient(rawReq(`Bearer ${TOKEN_EXPIRED}`), USER_X.id);
    await createUserRpcClient(rawReq(`Bearer ${TOKEN_Y}`), USER_X.id);
    await getAuthenticatedUser(rawReq(`bearer ${TOKEN_X}`));
    await getAuthenticatedUser(rawReq(`bearer ${TOKEN_GARBAGE}`));
    const joined = logOutput.join('\n');
    for (const token of ALL_TOKENS) {
      expect(joined).not.toContain(token);
    }
  });
});
