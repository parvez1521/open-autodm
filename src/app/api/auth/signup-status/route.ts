/**
 * GET /api/auth/signup-status — owner-only signup-posture surface
 * (Phase 10.4 Workstream A, finding S-02).
 *
 * Reports what the APP layer can truthfully state about this instance's
 * invite-only posture: that the app contains no self-registration path
 * (an invariant pinned by tests/signup-protection.test.ts), that
 * anonymous identities are denied, and whether the owner has configured
 * the INSTANCE_ALLOWED_* allowlist.
 *
 * It deliberately does NOT claim to report the Supabase dashboard's
 * "Allow new users to sign up" toggle: that setting lives in Supabase
 * project configuration and is not readable from app code or runtime.
 * The response names it `owner-verification-required` so the owner is
 * pointed at the dashboard check (procedure in
 * phase10.4-scratch-A-signup.md) instead of being given false assurance.
 *
 * Access: a verified identity is required (401 otherwise), and only the
 * instance owner receives the report (403 otherwise). When no owner is
 * configured the surface fails closed — nobody gets it — mirroring the
 * AI drafting endpoint (src/app/api/ai/generate/route.ts).
 * This route is read-only: it creates nothing and changes nothing.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { isInstanceOwner } from '@/lib/owner';
import { getSignupPosture } from '@/lib/signupProtection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  if (!isInstanceOwner(user)) {
    return Response.json(
      {
        error: 'Forbidden',
        message: 'Signup posture is available only to the instance owner',
      },
      { status: 403 }
    );
  }

  return Response.json(getSignupPosture());
}
