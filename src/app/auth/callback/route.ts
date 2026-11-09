/**
 * /auth/callback - Supabase auth code exchange (email confirmation links,
 * OAuth providers — Google sign-in since 2026-11-10). Sets session cookies
 * and forwards to the post-auth destination: the plan picker
 * (/pricing?welcome=1) for a customer who has never chosen a plan,
 * the dashboard otherwise (owner directive, 2026-11-10, Task F —
 * resolved by lib/billing/planChoiceServer, fail-open to /dashboard).
 *
 * S-02 gate (Phase 10.4): this route is where a confirmation/invite code
 * becomes a live session, so it is a session-MINTING surface. The exchanged
 * identity must pass the same signup-protection gate as the API layer
 * (src/lib/signupProtection.ts) before the session is kept: anonymous
 * identities, and identities outside the owner's INSTANCE_ALLOWED_*
 * allowlist when one is configured, are signed straight back out and
 * forwarded to the login page with an error — never to the dashboard.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { isIdentityAllowed } from '@/lib/signupProtection';
import { resolvePostAuthDestination } from '@/lib/billing/planChoiceServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/login?auth_error=${encodeURIComponent(error)}`, request.url));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    }
  );

  const { data: exchangeData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(new URL(`/login?auth_error=${encodeURIComponent(exchangeError.message)}`, request.url));
  }

  // Fail closed: no identifiable user, or an identity the instance does
  // not accept, gets no session — sign out whatever the exchange set and
  // send the browser back to the (sign-in only) landing page.
  const exchangedUser = exchangeData.user ?? exchangeData.session?.user ?? null;
  if (
    !exchangedUser ||
    !isIdentityAllowed({
      id: exchangedUser.id,
      email: exchangedUser.email,
      isAnonymous: exchangedUser.is_anonymous,
    })
  ) {
    await supabase.auth.signOut();
    return NextResponse.redirect(
      new URL(
        `/login?auth_error=${encodeURIComponent('This account is not provisioned for open-autoDM.')}`,
        request.url
      )
    );
  }
  // Owner's entry flow (2026-11-10, Task F): a brand-new customer
  // lands on "Choose your plan" first; everyone else on the
  // dashboard. The resolver fails open to /dashboard.
  const destination = await resolvePostAuthDestination({
    id: exchangedUser.id,
    appMetadata: exchangedUser.app_metadata,
  });
  return NextResponse.redirect(new URL(destination, request.url));
}
