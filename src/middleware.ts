/**
 * Next.js middleware.
 *  1. Refreshes the Supabase session cookie (required by @supabase/ssr).
 *  2. Protects app routes; redirects unauthenticated users to the login page.
 *
 * /api/* is fully excluded: the webhook and cron endpoints must never be
 * touched by session logic, and app API routes authenticate via Bearer JWT.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { isIdentityAllowed } from '@/lib/signupProtection';

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

  if (pathname === '/' && user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/dashboard';
    return NextResponse.redirect(redirectUrl);
  }

  if (pathname === '/login' && user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/dashboard';
    return NextResponse.redirect(redirectUrl);
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
