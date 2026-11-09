/**
 * Post-auth plan-choice routing (owner directive, 2026-11-10,
 * Task F — supersedes the dashboard-entry redirect shipped the
 * same morning in 84f71487).
 *
 * The owner's flow: homepage → its CTA → login page → sign in /
 * sign up → THEN, if the customer has never chosen a plan, the
 * "Choose your plan" pricing page (/pricing?welcome=1); everyone
 * else goes straight to the dashboard. The dashboard itself never
 * force-navigates anyone (F2): the choice also lives there as a
 * checklist step + dismissible banner.
 *
 * This module is the ONE server-side resolver every post-auth
 * choke point consults:
 *  - src/app/auth/callback/route.ts (email confirmation links and
 *    OAuth returns — Google sign-in included),
 *  - GET /api/billing/plan-choice (the email/password forms ask
 *    for their destination after a client-side sign-in/sign-up).
 *
 * The decision itself is the pure needsPlanChoice() from
 * lib/billing/planChoice (marker in app_metadata OR any real plan
 * state — subscription or trial — means the choice is done).
 *
 * Failure posture: FAIL OPEN to the dashboard. Any resolution
 * error (no workspace yet, a database hiccup, missing env in a
 * test build) lands the user in the console rather than trapping
 * them; the next sign-in re-evaluates.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { resolveBillingWorkspace } from '@/lib/billing/access';
import { getWorkspaceSubscription } from '@/lib/billing/persistence';
import { needsPlanChoice, planChoiceMadeAt } from '@/lib/billing/planChoice';

/** Where a customer who still owes a plan choice is sent. */
export const PLAN_PICKER_DESTINATION = '/pricing?welcome=1';

/** The default post-auth landing: the console. */
export const POST_AUTH_DESTINATION = '/dashboard';

/**
 * Resolve where a freshly authenticated user should land.
 * `appMetadata` may be omitted when the caller only has the user
 * id (the API destination endpoint): the fresh record is then
 * read through the service role so the marker check sees the
 * server-side truth, never client-supplied data.
 */
export async function resolvePostAuthDestination(user: {
  id: string;
  appMetadata?: unknown;
}): Promise<string> {
  try {
    let appMetadata = user.appMetadata;
    const db = createServiceClient();
    if (appMetadata === undefined) {
      const { data } = await db.auth.admin.getUserById(user.id);
      appMetadata = data?.user?.app_metadata ?? null;
    }
    if (planChoiceMadeAt(appMetadata) !== null) return POST_AUTH_DESTINATION;

    const resolved = await resolveBillingWorkspace(db, user.id, null);
    if (!resolved.ok) return POST_AUTH_DESTINATION;
    const row = await getWorkspaceSubscription(db, resolved.ctx.workspaceId);
    const view = row
      ? { planId: row.planId, status: row.status, trialEndsAt: row.trialEndsAt }
      : null;
    return needsPlanChoice(view, false) ? PLAN_PICKER_DESTINATION : POST_AUTH_DESTINATION;
  } catch {
    // Fail open (see header): the console, never a trap.
    return POST_AUTH_DESTINATION;
  }
}
