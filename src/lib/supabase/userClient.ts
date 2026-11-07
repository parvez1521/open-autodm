/**
 * User-JWT Supabase client factory — server-side only.
 *
 * Programme 19 / Finding F-J1 fix. NEVER import this from client
 * components.
 *
 * THE DEFECT (F-J1): the four membership RPCs of migration …000031
 * (create_workspace, accept_workspace_invitation, change_member_role,
 * remove_member) are SECURITY DEFINER functions that derive their
 * actor from `(SELECT auth.uid())` and raise 'authentication required'
 * when it is NULL. The workspace routes originally called them through
 * the service-role client, whose PostgREST JWT carries no `sub` claim,
 * so auth.uid() was NULL on real Supabase and every call failed closed.
 * The fix is client-side only (the RPCs are fixed): the RPC must run
 * through a client whose PostgREST Authorization is the CALLER's own
 * access token, so auth.uid() inside the RPC is the authenticated user.
 *
 * This factory builds exactly that client. It NEVER uses the
 * service-role credential and never touches the privileged client
 * factory — its only keys are the public URL + anon key from getEnv().
 *
 * TRANSPORT PRECEDENCE — mirrors getAuthenticatedUser (src/lib/auth.ts)
 * exactly; do not invent a parallel flow:
 *   1. `Authorization: Bearer <jwt>` present ⇒ Bearer path ONLY (the
 *      scheme is recognised ASCII case-insensitively via the shared
 *      parser in src/lib/bearerToken.ts, exactly as in auth.ts). The
 *      JWT is verified server-side via Supabase Auth
 *      (auth.getUser(jwt) on an anon-key client — never a local decode)
 *      and the RPC client is a fresh anon-key client carrying
 *      `Authorization: Bearer <jwt>` as a global header, so PostgREST
 *      executes the RPC with auth.uid() = that user.
 *   2. No Bearer header ⇒ cookie path. The @supabase/ssr server client
 *      (next/headers cookies, the auth.ts pattern) resolves the session
 *      via auth.getUser(); THAT client is returned — it carries the
 *      session cookie, so its PostgREST Authorization is the user's
 *      access token.
 *   If BOTH transports are present, the Bearer path governs and the
 *   cookie is ignored. A present-but-invalid Bearer token NEVER falls
 *   back to the cookie transport — it fails closed, exactly as
 *   getAuthenticatedUser returns null with no cookie fallback.
 *
 * ADDITIONAL INVARIANTS:
 *   - The verified identity must equal `expectedUserId` (the identity
 *     the route already authenticated); any mismatch fails closed.
 *   - No caching: a fresh client instance is built on every call.
 *   - Nothing is logged — no tokens, headers, or cookies — and failure
 *     results carry generic messages only, never credential material.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getEnv } from '@/lib/env';
import { parseBearerToken } from '@/lib/bearerToken';

export type UserRpcClientResult =
  | { ok: true; client: SupabaseClient }
  | { ok: false; status: number; error: string };

const UNAUTHENTICATED: UserRpcClientResult = {
  ok: false,
  status: 401,
  error: 'Authentication required for this workspace operation',
};

const IDENTITY_MISMATCH: UserRpcClientResult = {
  ok: false,
  status: 403,
  error: 'Authenticated identity does not match the authorized user',
};

const UNAVAILABLE: UserRpcClientResult = {
  ok: false,
  status: 500,
  error: 'Workspace authentication is unavailable',
};

export async function createUserRpcClient(
  request: Request,
  expectedUserId: string,
): Promise<UserRpcClientResult> {
  if (!expectedUserId) return UNAUTHENTICATED;

  let url: string;
  let anonKey: string;
  try {
    const env = getEnv();
    url = env.NEXT_PUBLIC_SUPABASE_URL;
    anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  } catch {
    return UNAVAILABLE;
  }

  const parsed = parseBearerToken(request.headers.get('authorization'));
  if (parsed.kind === 'bearer') {
    // ── Bearer path (governs whenever a Bearer credential is present) ──
    const jwt = parsed.token;
    if (jwt.trim() === '') return UNAUTHENTICATED;

    let verifiedUserId: string | null = null;
    try {
      const verifier = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const { data, error } = await verifier.auth.getUser(jwt);
      if (error || !data.user) return UNAUTHENTICATED;
      verifiedUserId = data.user.id;
    } catch {
      return UNAUTHENTICATED;
    }
    if (verifiedUserId !== expectedUserId) return IDENTITY_MISMATCH;

    const client = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return { ok: true, client };
  }

  // ── Cookie path (only when no Bearer header is present) ─────────────
  try {
    const cookieStore = await cookies();
    const client = createServerClient(url, anonKey, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          /* read-only in route handlers that don't refresh sessions */
        },
      },
    });
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return UNAUTHENTICATED;
    if (data.user.id !== expectedUserId) return IDENTITY_MISMATCH;
    return { ok: true, client: client as unknown as SupabaseClient };
  } catch {
    return UNAUTHENTICATED;
  }
}
