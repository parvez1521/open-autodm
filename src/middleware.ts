/**
 * Next.js middleware.
 *  1. Refreshes the Supabase session cookie (required by @supabase/ssr).
 *  2. Protects app routes; redirects unauthenticated users to the login page.
 *  3. Stamps the geo display-currency cookie (owner instruction,
 *     2026-11-08 ~19:38 IST): the Vercel edge country header decides
 *     whether pricing surfaces render INR or USD — never both. Set
 *     once, only when absent, on the final pass-through response so
 *     the Supabase cookie rebuild above cannot drop it.
 *
 * /api/* is fully excluded: the webhook and cron endpoints must never be
 * touched by session logic, and app API routes authenticate via Bearer JWT.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { isIdentityAllowed } from '@/lib/signupProtection';
import { GEO_CURRENCY_COOKIE, currencyForCountry } from '@/lib/billing/geo';

const SUPABASE_URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!;
const SUPABASE_ANON_KEY = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!;

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
      },
    },
  });

  // getUser() also refreshes the session token when needed - call it before
  // any redirect decisions.
  const {
    data: { user: verifiedUser },
  } = await supabase.auth.getUser();

  // S-02 gate (Phase 10.4): page protection applies the same
  // signup-protection decision as the API layer (src/lib/auth.ts) — an
  // anonymous identity, or one outside the owner's INSTANCE_ALLOWED_*
  // allowlist when configured, is treated as unauthenticated here too.
  const user =
    verifiedUser &&
    isIdentityAllowed({
      id: verifiedUser.id,
      email: verifiedUser.email,
      isAnonymous: verifiedUser.is_anonymous,
    })
      ? verifiedUser
      : null;

  const pathname = request.nextUrl.pathname;
  const isProtectedRoute =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/automations') ||
    pathname.startsWith('/analytics') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/script-writer') ||
    pathname.startsWith('/studio') ||
    pathname.startsWith('/setup');

  if (isProtectedRoute && !user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    return NextResponse.redirect(redirectUrl);
  }

  // Thumbnail Editor paused (owner decision, 2026-11-07): the tool is
  // hidden from the Studio navigation, the Studio directory and the
  // landing page, and its route redirects to the Studio home. The
  // editor's code stays in the tree untouched — removing this block
  // (and restoring the hidden entries) brings it back.
  if (
    user &&
    (pathname === '/studio/thumbnail' || pathname.startsWith('/studio/thumbnail/'))
  ) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/studio';
    return NextResponse.redirect(redirectUrl);
  }

  // Homepage bounce REMOVED (owner directive, 2026-11-10, Task F):
  // signed-in users used to be redirected from / to /dashboard,
  // which made the homepage unreachable while logged in ("homepage
  // hi gayab kar diya"). The landing page now renders for everyone;
  // its CTAs point at /login, and the middleware rule below carries
  // a signed-in visitor from /login onward to the console. The
  // post-login destination itself (plan picker vs dashboard) is
  // decided at the auth surfaces — see lib/billing/planChoiceServer.

  if (pathname === '/login' && user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/dashboard';
    return NextResponse.redirect(redirectUrl);
  }

  // Geo display currency (see header note 3): read the edge country
  // header — x-vercel-ip-country on Vercel, cf-ipcountry on
  // Cloudflare — and persist the resolved currency as a cookie the
  // client pricing surfaces read (lib/billing/useDisplayCurrency).
  // No header (local dev, tests) → no cookie; the client falls back
  // to timezone, then INR.
  if (!request.cookies.has(GEO_CURRENCY_COOKIE)) {
    const country =
      request.headers.get('x-vercel-ip-country') ?? request.headers.get('cf-ipcountry');
    if (country) {
      supabaseResponse.cookies.set(GEO_CURRENCY_COOKIE, currencyForCountry(country), {
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
        sameSite: 'lax',
      });
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Everything EXCEPT:
     *  - /api/* (webhook + cron + Bearer-authenticated app APIs)
     *  - _next static assets, favicon, auth callback
     */
    '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|logo.svg|auth/).*)',
  ],
};
