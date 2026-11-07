/**
 * Phase 10.4 Workstream A — S-02 signup hardening.
 *
 * Product posture: invite-only. There is NO self-registration in the app:
 * the owner creates users in the Supabase dashboard (Authentication →
 * Users → Add user, Auto Confirm) and must turn OFF "Allow new users to
 * sign up" there (docs/SELF_HOSTING.md). S-02 was that this safety rested
 * ONLY on that dashboard toggle — no in-code guard existed.
 *
 * What this suite pins:
 *  (1) No app endpoint / UI path performs signup (source scan over src/).
 *  (2) No API route creates users (route inventory scan + behavioural 401s).
 *  (3) A dashboard-created ("invited") user can still authenticate through
 *      the REAL src/lib/auth.ts (Supabase mocked, no real credentials).
 *  (4) Existing-user login via the cookie transport is unaffected.
 *  (5) Missing/malformed signup-related configuration fails closed:
 *      a malformed INSTANCE_ALLOWED_* value denies EVERYONE, and an
 *      anonymous Supabase identity is denied even with no allowlist set.
 *  (6) Malformed Authorization is rejected by the real auth helper.
 *  (7) A direct-API signup bypass attempt — a verified Supabase identity
 *      that was NOT provisioned by the owner (not on the owner's allowlist,
 *      or an anonymous identity) — is rejected by getAuthenticatedUser(),
 *      the single gate every API route uses, and by the page middleware
 *      and the /auth/callback session-minting route.
 *
 * The data model cannot distinguish a dashboard-created user from a
 * self-registered one (the profiles row is auto-created by a DB trigger
 * for EVERY auth.users insert), so the in-code guard is: anonymous
 * identities always denied + an OPTIONAL owner-configured allowlist
 * (INSTANCE_ALLOWED_EMAILS / INSTANCE_ALLOWED_USER_IDS). With no
 * allowlist configured, any verified non-anonymous identity is accepted
 * and the residual control remains the Supabase dashboard toggle —
 * see phase10.4-scratch-A-signup.md for the full justification and the
 * owner verification procedure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Mocked Supabase transports (same pattern as tests/setup-route.test.ts:
//    mock the client factories, run the REAL code under test) ─────────────

const mocks = vi.hoisted(() => ({
  bearerGetUser: vi.fn(),
  cookieGetUser: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mocks.bearerGetUser } })),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: mocks.cookieGetUser,
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      signOut: mocks.signOut,
    },
  })),
}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: vi.fn(), get: () => undefined })),
}));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: 'https://project-ref.example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-for-tests-only-0123456789',
  }),
}));

import { getAuthenticatedUser } from '@/lib/auth';

const SRC_ROOT = path.resolve(__dirname, '..', 'src');

// ── Actors ────────────────────────────────────────────────────────────────
// UUID-shaped ids (the allowlist parser validates the shape).

const OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email' },
};
const INVITED = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'invited@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email' },
};
const STRANGER = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'stranger@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email' },
};
const ANONYMOUS = {
  id: '44444444-4444-4444-8444-444444444444',
  email: undefined,
  is_anonymous: true,
  app_metadata: { provider: 'anonymous' },
};

const TOKEN_TO_USER: Record<string, typeof OWNER | typeof INVITED | typeof STRANGER | typeof ANONYMOUS> = {
  'owner-token': OWNER,
  'invited-token': INVITED,
  'stranger-token': STRANGER,
  'anon-token': ANONYMOUS,
};

const CODE_TO_USER: Record<string, typeof OWNER | typeof INVITED | typeof STRANGER | typeof ANONYMOUS> = {
  'owner-code': OWNER,
  'invited-code': INVITED,
  'stranger-code': STRANGER,
  'anon-code': ANONYMOUS,
};

function bearerRequest(token: string): Request {
  return new Request('https://app.opendm.in/api/automations', {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Map a Supabase-shaped actor to the gate's IdentityLike shape. */
function asIdentity(u: typeof OWNER | typeof INVITED | typeof STRANGER | typeof ANONYMOUS) {
  return { id: u.id, email: u.email, isAnonymous: u.is_anonymous };
}

const ENV_KEYS = [
  'INSTANCE_ALLOWED_EMAILS',
  'INSTANCE_ALLOWED_USER_IDS',
  'OWNER_USER_ID',
  'OWNER_EMAIL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mocks.bearerGetUser.mockReset();
  mocks.bearerGetUser.mockImplementation(async (jwt?: string) => {
    const user = jwt ? TOKEN_TO_USER[jwt] : undefined;
    return user
      ? { data: { user }, error: null }
      : { data: { user: null }, error: { message: 'invalid JWT' } };
  });
  mocks.cookieGetUser.mockReset();
  mocks.cookieGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } });
  mocks.exchangeCodeForSession.mockReset();
  mocks.exchangeCodeForSession.mockImplementation(async (code: string) => {
    const user = CODE_TO_USER[code];
    return user
      ? { data: { session: { user }, user }, error: null }
      : { data: { session: null, user: null }, error: { message: 'invalid code' } };
  });
  mocks.signOut.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ── Source-scan helpers (style of tests/security-regression.test.ts) ─────

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

/** Every Supabase Auth call that can CREATE or provision an account. */
const USER_CREATION_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'signUp', re: /\.signUp\s*\(/ },
  { label: 'signInAnonymously', re: /\.signInAnonymously\s*\(/ },
  { label: 'signInWithOtp', re: /\.signInWithOtp\s*\(/ },
  { label: 'signInWithOAuth', re: /\.signInWithOAuth\s*\(/ },
  { label: 'verifyOtp', re: /\.verifyOtp\s*\(/ },
  { label: 'resetPasswordForEmail', re: /\.resetPasswordForEmail\s*\(/ },
  { label: 'auth.admin.createUser', re: /admin\s*\.\s*createUser\s*\(/ },
  { label: 'auth.admin.inviteUserByEmail', re: /admin\s*\.\s*inviteUserByEmail\s*\(/ },
  { label: 'auth.admin.generateLink', re: /admin\s*\.\s*generateLink\s*\(/ },
  { label: 'direct GoTrue signup REST call', re: /auth\/v1\/signup/ },
];

// ── (1) No app endpoint / UI path performs signup ─────────────────────────

describe('S-02 (1): no signup path exists anywhere in src/', () => {
  it('no source file calls any user-creation / self-provisioning auth method', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const { label, re } of USER_CREATION_PATTERNS) {
        if (re.test(src)) {
          offenders.push(`${path.relative(SRC_ROOT, file).replace(/\\/g, '/')} → ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no route or page is named for signup/registration', () => {
    const appDir = path.join(SRC_ROOT, 'app');
    const badNames = collectSourceFiles(appDir).filter((f) =>
      path
        .relative(appDir, f)
        .split(path.sep)
        .some((segment) => /^(sign[-_]?up|register|registration)$/i.test(segment.replace(/\.tsx?$/, '')))
    );
    expect(badNames).toEqual([]);
  });

  it('LoginForm is sign-in only: password sign-in present, no registration affordance', () => {
    const src = readSrc('components/auth/LoginForm.tsx');
    expect(src).toContain('signInWithPassword');
    for (const { re } of USER_CREATION_PATTERNS) expect(src).not.toMatch(re);
    expect(src.toLowerCase()).toContain('invite-only');
    // No link/route to a registration page.
    expect(src).not.toMatch(/href=["'][^"']*(sign[-_]?up|register)/i);
  });

  it('the only client auth-call sites are the known, non-creating ones', () => {
    const allowed = new Set([
      'signInWithPassword',
      'signOut',
      'getSession',
      'getUser',
      'onAuthStateChange',
      'exchangeCodeForSession',
    ]);
    const seen = new Map<string, Set<string>>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.auth\.(\w+)\s*\(/g)) {
        const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
        if (!seen.has(rel)) seen.set(rel, new Set());
        seen.get(rel)!.add(m[1]!);
      }
    }
    for (const [file, methods] of seen) {
      for (const method of methods) {
        expect(allowed.has(method), `${file} uses unexpected auth method ${method}`).toBe(true);
      }
    }
    // Sanity: the inventory is non-empty and includes the login call.
    expect(seen.get('components/auth/LoginForm.tsx')).toEqual(new Set(['signInWithPassword']));
  });
});

// ── (2) No API route creates users ────────────────────────────────────────

describe('S-02 (2): no API route creates users; unauthenticated calls are rejected', () => {
  it('every route handler file is free of user-creation calls', () => {
    const routeFiles = collectSourceFiles(path.join(SRC_ROOT, 'app')).filter((f) =>
      /route\.ts$/.test(f)
    );
    expect(routeFiles.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, 'utf8');
      for (const { label, re } of USER_CREATION_PATTERNS) {
        if (re.test(src)) {
          offenders.push(`${path.relative(SRC_ROOT, file).replace(/\\/g, '/')} → ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the setup route (the only route that writes instance config) creates no users', () => {
    const src = readSrc('app/api/setup/route.ts');
    for (const { re } of USER_CREATION_PATTERNS) expect(src).not.toMatch(re);
    expect(src).not.toContain("from('auth");
    expect(src).not.toContain('auth.users');
  });

  it('the signup-status surface exposes no creation verb (GET only)', async () => {
    const mod = (await import('@/app/api/auth/signup-status/route')) as Record<string, unknown>;
    expect(typeof mod.GET).toBe('function');
    expect(mod.POST).toBeUndefined();
    expect(mod.PUT).toBeUndefined();
    expect(mod.DELETE).toBeUndefined();
  });

  it('signup-status rejects an unauthenticated caller with 401', async () => {
    const { GET } = await import('@/app/api/auth/signup-status/route');
    const res = await GET(new Request('https://app.opendm.in/api/auth/signup-status'));
    expect(res.status).toBe(401);
  });
});

// ── Allowlist unit behaviour (src/lib/signupProtection.ts) ────────────────

describe('S-02: signupProtection allowlist evaluation', () => {
  it('with no allowlist configured, verified non-anonymous identities are accepted (dashboard toggle remains the control)', async () => {
    const { evaluateInstanceAccess, getAllowlistState } = await import('@/lib/signupProtection');
    expect(getAllowlistState()).toMatchObject({ configured: false, invalid: false });
    expect(evaluateInstanceAccess(asIdentity(INVITED)).allowed).toBe(true);
    expect(evaluateInstanceAccess(asIdentity(OWNER)).allowed).toBe(true);
  });

  it('anonymous identities are ALWAYS denied, allowlist or not', async () => {
    const { evaluateInstanceAccess } = await import('@/lib/signupProtection');
    expect(evaluateInstanceAccess(asIdentity(ANONYMOUS))).toMatchObject({ allowed: false, reason: 'anonymous-identity' });
    process.env['INSTANCE_ALLOWED_USER_IDS'] = ANONYMOUS.id;
    expect(evaluateInstanceAccess(asIdentity(ANONYMOUS)).allowed).toBe(false);
  });

  it('email allowlist admits listed (case-insensitive) and denies unlisted', async () => {
    const { evaluateInstanceAccess } = await import('@/lib/signupProtection');
    process.env['INSTANCE_ALLOWED_EMAILS'] = 'Owner@Example.com, invited@example.com';
    expect(evaluateInstanceAccess(asIdentity(OWNER)).allowed).toBe(true);
    expect(evaluateInstanceAccess(asIdentity(INVITED)).allowed).toBe(true);
    expect(evaluateInstanceAccess(asIdentity(STRANGER))).toMatchObject({ allowed: false, reason: 'not-on-allowlist' });
  });

  it('user-id allowlist admits listed and denies unlisted', async () => {
    const { evaluateInstanceAccess } = await import('@/lib/signupProtection');
    process.env['INSTANCE_ALLOWED_USER_IDS'] = INVITED.id;
    expect(evaluateInstanceAccess(asIdentity(INVITED)).allowed).toBe(true);
    expect(evaluateInstanceAccess(asIdentity(OWNER)).allowed).toBe(false);
  });

  it('posture report is honest: dashboard toggle is NOT detectable from the app', async () => {
    const { getSignupPosture } = await import('@/lib/signupProtection');
    const posture = getSignupPosture();
    expect(posture.mode).toBe('invite-only');
    expect(posture.appInitiatedSignup).toBe(false);
    expect(posture.dashboardToggleDetectableFromApp).toBe(false);
    expect(posture.supabaseDashboardSignupToggle).toBe('owner-verification-required');
    expect(posture.anonymousIdentities).toBe('denied');
  });
});

// ── (5) Missing/malformed configuration fails closed ─────────────────────

describe('S-02 (5): malformed signup-related configuration fails closed', () => {
  it('a malformed email allowlist entry invalidates the whole list: everyone is denied', async () => {
    const { evaluateInstanceAccess, getAllowlistState } = await import('@/lib/signupProtection');
    process.env['INSTANCE_ALLOWED_EMAILS'] = 'invited@example.com, not-an-email';
    expect(getAllowlistState().invalid).toBe(true);
    expect(evaluateInstanceAccess(asIdentity(INVITED))).toMatchObject({ allowed: false, reason: 'allowlist-invalid-config' });
    expect(evaluateInstanceAccess(asIdentity(OWNER)).allowed).toBe(false);
  });

  it('a malformed user-id allowlist entry invalidates the whole list', async () => {
    const { evaluateInstanceAccess, getAllowlistState } = await import('@/lib/signupProtection');
    process.env['INSTANCE_ALLOWED_USER_IDS'] = 'not-a-uuid';
    expect(getAllowlistState().invalid).toBe(true);
    expect(evaluateInstanceAccess(asIdentity(INVITED)).allowed).toBe(false);
  });

  it('blank allowlist variables count as unconfigured, never as an allow-everything switch', async () => {
    const { getAllowlistState } = await import('@/lib/signupProtection');
    process.env['INSTANCE_ALLOWED_EMAILS'] = '   ';
    process.env['INSTANCE_ALLOWED_USER_IDS'] = '';
    expect(getAllowlistState().configured).toBe(false);
  });

  it('getAuthenticatedUser denies everyone while the allowlist config is malformed', async () => {
    process.env['INSTANCE_ALLOWED_EMAILS'] = 'not-an-email';
    expect(await getAuthenticatedUser(bearerRequest('invited-token'))).toBeNull();
    expect(await getAuthenticatedUser(bearerRequest('owner-token'))).toBeNull();
  });
});

// ── (3)(4)(6)(7): the REAL getAuthenticatedUser gate ─────────────────────

describe('S-02 (3)(4)(6)(7): getAuthenticatedUser (real src/lib/auth.ts, mocked Supabase)', () => {
  it('(3) a dashboard-created invited user authenticates via Bearer token', async () => {
    const user = await getAuthenticatedUser(bearerRequest('invited-token'));
    expect(user).toMatchObject({ id: INVITED.id, email: INVITED.email });
  });

  it('(3) an invited user on the owner allowlist still authenticates', async () => {
    process.env['INSTANCE_ALLOWED_EMAILS'] = 'invited@example.com';
    const user = await getAuthenticatedUser(bearerRequest('invited-token'));
    expect(user).toMatchObject({ id: INVITED.id, email: INVITED.email });
  });

  it('(4) an existing user on the cookie transport is unaffected when no allowlist is set', async () => {
    mocks.cookieGetUser.mockResolvedValue({ data: { user: INVITED }, error: null });
    const user = await getAuthenticatedUser(new Request('https://app.opendm.in/api/automations'));
    expect(user).toMatchObject({ id: INVITED.id, email: INVITED.email });
  });

  it('(6) malformed Authorization is rejected: unknown token, wrong scheme, empty bearer', async () => {
    expect(await getAuthenticatedUser(bearerRequest('garbage-token'))).toBeNull();
    const wrongScheme = new Request('https://app.opendm.in/api/automations', {
      headers: { authorization: 'Token invited-token' },
    });
    expect(await getAuthenticatedUser(wrongScheme)).toBeNull();
    const emptyBearer = new Request('https://app.opendm.in/api/automations', {
      headers: { authorization: 'Bearer ' },
    });
    expect(await getAuthenticatedUser(emptyBearer)).toBeNull();
    expect(await getAuthenticatedUser(new Request('https://app.opendm.in/api/automations'))).toBeNull();
  });

  it('(7) an anonymous Supabase identity is rejected even though its JWT verifies', async () => {
    expect(await getAuthenticatedUser(bearerRequest('anon-token'))).toBeNull();
  });

  it('(7) a self-registered stranger bypassing the UI is rejected when the owner allowlist is set', async () => {
    process.env['INSTANCE_ALLOWED_EMAILS'] = 'owner@example.com, invited@example.com';
    expect(await getAuthenticatedUser(bearerRequest('stranger-token'))).toBeNull();
    // …while the provisioned users keep working.
    expect(await getAuthenticatedUser(bearerRequest('invited-token'))).toMatchObject({ id: INVITED.id });
    expect(await getAuthenticatedUser(bearerRequest('owner-token'))).toMatchObject({ id: OWNER.id });
  });
});

// ── (7) Page middleware gate ──────────────────────────────────────────────

describe('S-02 (7): middleware treats a gated-out identity as unauthenticated', () => {
  it('anonymous session is redirected off /dashboard; invited session passes; stranger off the allowlist is redirected', async () => {
    process.env['NEXT_PUBLIC_SUPABASE_URL'] = 'https://project-ref.example.supabase.co';
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = 'anon-key-for-tests-only-0123456789';
    const { NextRequest } = await import('next/server');
    const { middleware } = await import('@/middleware');

    mocks.cookieGetUser.mockResolvedValue({ data: { user: ANONYMOUS }, error: null });
    const anonRes = await middleware(new NextRequest('https://app.opendm.in/dashboard'));
    expect(anonRes.status).toBe(307);
    expect(anonRes.headers.get('location')).toBe('https://app.opendm.in/login');

    mocks.cookieGetUser.mockResolvedValue({ data: { user: INVITED }, error: null });
    const invitedRes = await middleware(new NextRequest('https://app.opendm.in/dashboard'));
    expect(invitedRes.headers.get('location')).toBeNull();

    process.env['INSTANCE_ALLOWED_EMAILS'] = 'invited@example.com';
    mocks.cookieGetUser.mockResolvedValue({ data: { user: STRANGER }, error: null });
    const strangerRes = await middleware(new NextRequest('https://app.opendm.in/dashboard'));
    expect(strangerRes.status).toBe(307);
    expect(strangerRes.headers.get('location')).toBe('https://app.opendm.in/login');
  });

  it('middleware source routes its decision through the shared gate', () => {
    const src = readSrc('middleware.ts');
    expect(src).toContain('signupProtection');
    expect(src).toContain('isIdentityAllowed');
  });
});

// ── (7) /auth/callback session-minting gate ──────────────────────────────

describe('S-02 (7): /auth/callback refuses to mint a session for a gated-out identity', () => {
  it('invited user code → dashboard; anonymous code → error redirect + signOut; stranger off allowlist → error redirect', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/auth/callback/route');

    const invitedRes = await GET(new NextRequest('https://app.opendm.in/auth/callback?code=invited-code'));
    expect(invitedRes.headers.get('location')).toBe('https://app.opendm.in/dashboard');

    const anonRes = await GET(new NextRequest('https://app.opendm.in/auth/callback?code=anon-code'));
    expect(anonRes.headers.get('location')).toContain('auth_error=');
    expect(mocks.signOut).toHaveBeenCalled();

    process.env['INSTANCE_ALLOWED_EMAILS'] = 'invited@example.com';
    const strangerRes = await GET(new NextRequest('https://app.opendm.in/auth/callback?code=stranger-code'));
    expect(strangerRes.headers.get('location')).toContain('auth_error=');
  });
});

// ── Signup-status surface (owner-gated, fail-closed) ─────────────────────

describe('S-02: GET /api/auth/signup-status (owner-only posture surface)', () => {
  it('returns the posture to the configured owner', async () => {
    process.env['OWNER_USER_ID'] = OWNER.id;
    const { GET } = await import('@/app/api/auth/signup-status/route');
    const res = await GET(bearerRequest('owner-token'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['mode']).toBe('invite-only');
    expect(body['appInitiatedSignup']).toBe(false);
    expect(body['supabaseDashboardSignupToggle']).toBe('owner-verification-required');
  });

  it('forbids a non-owner authenticated user (403)', async () => {
    process.env['OWNER_USER_ID'] = OWNER.id;
    const { GET } = await import('@/app/api/auth/signup-status/route');
    const res = await GET(bearerRequest('invited-token'));
    expect(res.status).toBe(403);
  });

  it('fails closed for everyone when no owner is configured (403, not open data)', async () => {
    const { GET } = await import('@/app/api/auth/signup-status/route');
    const res = await GET(bearerRequest('owner-token'));
    expect(res.status).toBe(403);
  });
});
