import { cookies } from "next/headers";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabase/service";
import { isAdminEmail } from "@/lib/admin/panel";
import { resolveBillingWorkspace } from "@/lib/billing/access";
import { getWorkspaceSubscription } from "@/lib/billing/persistence";
import { hasPlanState, planChoiceMadeAt } from "@/lib/billing/planChoice";
import DashboardClient from "@/components/dashboard/DashboardClient";

// Per-request rendering, always: the plan-choice flag reads the
// caller's live session, workspace and subscription state.
export const dynamic = "force-dynamic";

/**
 * Dashboard — server wrapper (owner directive, 2026-11-10).
 *
 * The interactive UI lives in components/dashboard/DashboardClient
 * (it was this file until today). This wrapper computes the two
 * facts only the server may know and hands them to the client as
 * props: isAdmin (the ADMIN_EMAILS gate, same as /admin — drives
 * the Setup Wizard button) and planChoiceDone (marker set OR plan
 * state exists — the getting-started checklist's first step).
 *
 * Task F correction (2026-11-10, later the same day): the wrapper
 * NO LONGER redirects anyone. The one-time redirect to
 * /pricing?welcome=1 shipped this morning fired on EVERY
 * dashboard entry — including the signed-in owner opening the
 * homepage, who got bounced off it ("homepage hi gayab kar
 * diya"). The plan picker is now reached the way the owner
 * specified: homepage → login → sign in/sign up → picker, with
 * the routing decided at the auth surfaces (lib/billing/
 * planChoiceServer). The dashboard renders for every signed-in
 * user; a customer who still owes the choice sees it here as the
 * checklist step + a dismissible banner — never a forced
 * navigation.
 *
 * Failure posture: FAIL OPEN. Any error while resolving renders
 * the dashboard with default flags rather than erroring the page.
 * Anonymous visitors never reach this wrapper (middleware sends
 * them to /login first).
 */
export default async function DashboardPage() {
  let isAdmin = false;
  let planChoiceDone = false;

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
        }
      }
    }
  } catch {
    // Fail open (see header): render the dashboard.
  }

  return <DashboardClient isAdmin={isAdmin} planChoiceDone={planChoiceDone} />;
}
