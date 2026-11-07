/**
 * Route-handler authentication.
 *
 * The user's identity ALWAYS comes from a verified Supabase JWT - never from
 * the request body or URL params. A verified identity must additionally
 * pass the S-02 signup-protection gate (src/lib/signupProtection.ts):
 * this product is invite-only, anonymous identities are never accepted,
 * and an owner-configured allowlist, when set, is enforced here so it
 * covers every API route at once. Two accepted transports:
 *   1. Authorization: Bearer <jwt>  (used by the in-app API client;
 *      the scheme is recognised ASCII case-insensitively via the
 *      shared parser in src/lib/bearerToken.ts)
 *   2. Supabase session cookies     (used by top-level browser navigations,
 *      e.g. the OAuth connect redirect)
 */

import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getEnv } from '@/lib/env';
import { isIdentityAllowed } from '@/lib/signupProtection';
import { parseBearerToken } from '@/lib/bearerToken';

export interface AuthenticatedUser {
  id: string;
  email: string | undefined;
  /** True for Supabase anonymous identities (never provisioned by this product). */
  isAnonymous?: boolean;
}

interface SupabaseUserLike {
  id: string;
  email?: string | undefined;
  is_anonymous?: boolean | undefined;
}

/**
 * S-02 gate (Phase 10.4): a verified JWT is necessary but not sufficient.
 * The identity must also pass the signup-protection gate — anonymous
 * identities are always rejected, and when the owner has configured an
 * INSTANCE_ALLOWED_* allowlist, only listed identities are accepted.
 * Rejection returns null, so every caller responds 401 exactly as it
 * does for an unverified token. See src/lib/signupProtection.ts.
 */
function acceptUser(user: SupabaseUserLike | null | undefined): AuthenticatedUser | null {
  if (!user) return null;
  if (!isIdentityAllowed({ id: user.id, email: user.email, isAnonymous: user.is_anonymous })) {
    return null;
  }
  return { id: user.id, email: user.email, isAnonymous: user.is_anonymous ?? false };
}

export async function getAuthenticatedUser(request: Request): Promise<AuthenticatedUser | null> {
  const env = getEnv();

  const parsed = parseBearerToken(request.headers.get('authorization'));
  if (parsed.kind === 'bearer') {
    // A Bearer credential was supplied: it governs, with NO cookie
    // fallback. A malformed (empty/whitespace-only) token fails
    // closed here — the same outcome as verification failing.
    if (parsed.token.trim() === '') return null;
    const jwt = parsed.token;
    const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) return null;
    return acceptUser(data.user);
  }

  // Cookie-based session (browser navigation)
  const cookieStore = await cookies();
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* read-only in route handlers that don't refresh sessions */
      },
    },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return acceptUser(data.user);
}

export function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized', message: 'Valid session required' }, { status: 401 });
}
