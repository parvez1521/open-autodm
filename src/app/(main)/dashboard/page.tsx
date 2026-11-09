import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabase/service";
import { isAdminEmail } from "@/lib/admin/panel";
import { resolveBillingWorkspace } from "@/lib/billing/access";
import { getWorkspaceSubscription } from "@/lib/billing/persistence";
import {
  hasPlanState,
  needsPlanChoice,
  planChoiceMadeAt,
} from "@/lib/billing/planChoice";
import DashboardClient from "@/components/dashboard/DashboardClient";

// Per-request rendering, always: the plan-choice decision reads
// the caller's live session, workspace and subscription state.
export const dynamic = "force-dynamic";

/**
 * Dashboard — server wrapper (owner directive, 2026-11-10).
 *
 * The interactive UI lives in components/dashboard/DashboardClient
 * (it was this file until today). This wrapper owns the ONE-TIME
 * plan-choice routing: a signed-in user whose billing workspace
 * has no plan state (no real subscription, no trial — see
 * lib/billing/planChoice) and who has not made/dismissed the
 * choice is redirected ONCE to /pricing?welcome=1, the plan
 * picker. Picking a paid plan creates plan state via trial /
 * checkout; picking Free or dismissing records the marker
 * (POST /api/billing/plan-choice) — either way the redirect never
 * fires again for that user.
 *
 * Failure posture: FAIL OPEN to the dashboard. Any error while
 * resolving (no workspace yet — first-ever load provisions it
 * client-side —, a database hiccup, missing env in a test build)
 * renders the dashboard rather than trapping the user in a
 * redirect loop; the next clean load re-evaluates. Anonymous
 * visitors never reach this wrapper (middleware sends them to
 * /login first).
 *
 * The wrapper also computes the two facts only the server may
 * know and hands them to the client as props: isAdmin (the
 * ADMIN_EMAILS gate, same as /admin — drives the Setup Wizard
 * button) and planChoiceDone (marker set OR plan state exists —
 * the getting-started checklist's first step).
 */
export default async function DashboardPage() {
  let isAdmin = false;
  let planChoiceDone = false;
  let routeToPicker = false;

  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      isAdmin = isAdminEmail(user.email, process.env);
      const markerMade = planChoiceMadeAt(user.app_metadata) !== null;
      planChoiceDone = markerMade;

      if (!markerMade) {
        const db = createServiceClient();
        const resolved = await resolveBillingWorkspace(db, user.id, null);
        if (resolved.ok) {
          const row = await getWorkspaceSubscription(db, resolved.ctx.workspaceId);
          const view = row
            ? { planId: row.planId, status: row.status, trialEndsAt: row.trialEndsAt }
            : null;
          planChoiceDone = hasPlanState(view);
          routeToPicker = needsPlanChoice(view, markerMade);
        }
      }
    }
  } catch {
    // Fail open (see header): render the dashboard.
    routeToPicker = false;
  }

  if (routeToPicker) redirect("/pricing?welcome=1");

  return <DashboardClient isAdmin={isAdmin} planChoiceDone={planChoiceDone} />;
}
