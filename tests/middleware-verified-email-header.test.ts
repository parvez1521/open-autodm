/**
 * Middleware verified-user email header (2026-11-23 slow-load fix).
 *
 * The (main) layout used to run its own supabase.auth.getUser() on
 * every page load/navigation just for the sidebar email — one more
 * sequential Auth round-trip after the middleware had already
 * verified the same session for the same request. The middleware
 * now stamps that verified email onto the request headers forwarded
 * to the page (src/lib/verifiedUserEmailHeader.ts); the layout reads
 * it first and only falls back to getUser() when it is absent.
 *
 * Pins:
 *  - verified user ⇒ the final NextResponse.next() call forwards
 *    request headers carrying x-opendm-user-email = that user's
 *    email (and getUser was called exactly once — the single
 *    verification for the request);
 *  - unverified request ⇒ the header is DELETED even when the
 *    client sent a spoofed one (a spoof can never survive into a
 *    page render);
 *  - the helper readVerifiedUserEmail: present → value, absent /
 *    blank → null.
 *
 * The middleware module is imported dynamically (after the env the
 * module reads at import time is set); next/server and
 * @supabase/ssr are mocked, the code under test is real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

process.env['NEXT_PUBLIC_SUPABASE_URL'] = 'https://proj-mw.example.supabase.co';
process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = 'anon-key-for-mw-tests';

const mockNext = vi.hoisted(() => {
  const nextCalls: unknown[] = [];
  const next = vi.fn((opts?: unknown) => {
    nextCalls.push(opts);
    return {
      cookies: { set: vi.fn(), getAll: () => [] as Array<{ name: string; value: string }> },
      headers: new Headers(),
    };
  });
  const redirect = vi.fn((url: unknown) => ({ redirectedTo: url }));
  return { nextCalls, next, redirect };
});

const mockSsr = vi.hoisted(() => ({
  user: null as { id: string; email?: string; is_anonymous?: boolean } | null,
  getUser: vi.fn(async () => ({ data: { user: mockSsr.user }, error: null })),
}));

vi.mock('next/server', () => ({
  NextResponse: { next: mockNext.next, redirect: mockNext.redirect },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: mockSsr.getUser } }),
}));

vi.mock('@/lib/signupProtection', () => ({ isIdentityAllowed: () => true }));

import { VERIFIED_USER_EMAIL_HEADER, readVerifiedUserEmail } from '@/lib/verifiedUserEmailHeader';

type MiddlewareFn = (request: NextRequest) => Promise<unknown>;
let middleware: MiddlewareFn;

function fakeRequest(pathname: string, incomingHeaders?: Record<string, string>): NextRequest {
  const headers = new Headers(incomingHeaders);
  const cookiesMap = new Map<string, string>();
  return {
    cookies: {
      getAll: () => [...cookiesMap.entries()].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => {
        cookiesMap.set(name, value);
      },
      // Geo cookie present → the geo block is skipped in these tests.
      has: () => true,
    },
    headers,
    nextUrl: {
      pathname,
      clone: () => ({ pathname: '/login' }),
    },
  } as unknown as NextRequest;
}

/** The request headers of the FINAL NextResponse.next() call (the
 *  rebuilt passthrough). The first next() call passes the whole
 *  request object (it has nextUrl); the final one passes a plain
 *  { headers } — that is the distinction. */
function finalRequestHeaders(): Headers | null {
  for (let i = mockNext.nextCalls.length - 1; i >= 0; i--) {
    const opts = mockNext.nextCalls[i] as { request?: { headers?: unknown; nextUrl?: unknown } } | undefined;
    const req = opts?.request;
    if (req && req.headers instanceof Headers && req.nextUrl === undefined) return req.headers;
  }
  return null;
}

beforeEach(async () => {
  vi.resetModules();
  mockNext.nextCalls.length = 0;
  mockNext.next.mockClear();
  mockNext.redirect.mockClear();
  mockSsr.getUser.mockClear();
  mockSsr.user = null;
  const mod = await import('@/middleware');
  middleware = mod.middleware as MiddlewareFn;
});

describe('middleware stamps the verified user email', () => {
  it('verified user on a protected route ⇒ final headers carry x-opendm-user-email', async () => {
    mockSsr.user = { id: 'u-1', email: 'owner@example.com', is_anonymous: false };
    await middleware(fakeRequest('/dashboard'));
    expect(mockSsr.getUser).toHaveBeenCalledTimes(1);
    const headers = finalRequestHeaders();
    expect(headers, 'a final passthrough must exist').not.toBeNull();
    expect(headers!.get(VERIFIED_USER_EMAIL_HEADER)).toBe('owner@example.com');
  });

  it('verified user with no email ⇒ header absent (layout falls back to getUser)', async () => {
    mockSsr.user = { id: 'u-1', is_anonymous: false };
    await middleware(fakeRequest('/dashboard'));
    const headers = finalRequestHeaders();
    expect(headers, 'a final passthrough must exist').not.toBeNull();
    expect(headers!.has(VERIFIED_USER_EMAIL_HEADER)).toBe(false);
  });

  it('unverified request ⇒ a client-sent spoofed header is DELETED, never forwarded', async () => {
    mockSsr.user = null;
    await middleware(
      fakeRequest('/', { [VERIFIED_USER_EMAIL_HEADER]: 'spoof@example.com' }),
    );
    const headers = finalRequestHeaders();
    expect(headers, 'a final passthrough must exist').not.toBeNull();
    expect(headers!.has(VERIFIED_USER_EMAIL_HEADER)).toBe(false);
  });
});

describe('readVerifiedUserEmail helper', () => {
  it('present ⇒ trimmed value; absent / blank ⇒ null', () => {
    expect(readVerifiedUserEmail(new Headers({ [VERIFIED_USER_EMAIL_HEADER]: 'owner@example.com' }))).toBe(
      'owner@example.com',
    );
    expect(readVerifiedUserEmail(new Headers())).toBeNull();
    expect(readVerifiedUserEmail(new Headers({ [VERIFIED_USER_EMAIL_HEADER]: '   ' }))).toBeNull();
  });
});
