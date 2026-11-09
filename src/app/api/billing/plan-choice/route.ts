/**
 * /api/billing/plan-choice — the one-time plan choice
 * (owner directive, 2026-11-10).
 *
 * POST — record the choice. Called from the /pricing plan picker
 * (welcome mode) when a signed-in user picks Free or dismisses
 * the picker: it stamps plan_choice_made_at into the user's
 * app_metadata, after which the post-auth routing never sends
 * them to the picker again (see src/lib/billing/planChoice.ts).
 * Paid-plan picks create real plan state through the trial /
 * checkout flow and ALSO call this (belt and braces: the click
 * itself is the choice, even if checkout is abandoned).
 *
 * GET — the post-auth destination (Task F, 2026-11-10). The
 * email/password forms sign in client-side, so after a successful
 * sign-in/sign-up they ask here where to go: the plan picker for
 * a customer who still owes the choice, the dashboard otherwise.
 * Resolved server-side by lib/billing/planChoiceServer from the
 * caller's verified identity — the same resolver the
 * /auth/callback route uses for email links and OAuth returns.
 *
 * app_metadata is writable only through the service-role admin
 * API — a user cannot set this marker for themselves through any
 * client surface, so the gate cannot be skipped by tampering.
 */

import { createLogger } from "@/lib/logger";
import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { PLAN_CHOICE_MADE_AT_KEY } from "@/lib/billing/planChoice";
import {
  PLAN_PICKER_DESTINATION,
  resolvePostAuthDestination,
} from "@/lib/billing/planChoiceServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:billing:plan-choice");

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  // The resolver reads the marker from the caller's server-side
  // record itself and fails open to the dashboard on any error.
  const destination = await resolvePostAuthDestination({ id: user.id });
  return Response.json({
    destination,
    needsPlanChoice: destination === PLAN_PICKER_DESTINATION,
  });
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  try {
    const db = createServiceClient();
    // Merge, never replace: app_metadata carries other keys owned
    // by other flows; read the current record first.
    const { data: existing, error: readError } = await db.auth.admin.getUserById(user.id);
    if (readError || !existing?.user) {
      throw new Error(readError?.message ?? "user not found");
    }
    const current = existing.user.app_metadata ?? {};
    if (typeof current[PLAN_CHOICE_MADE_AT_KEY] === "string") {
      // Already recorded — the write is idempotent.
      return Response.json({ ok: true, alreadyRecorded: true });
    }
    const { error } = await db.auth.admin.updateUserById(user.id, {
      app_metadata: { ...current, [PLAN_CHOICE_MADE_AT_KEY]: new Date().toISOString() },
    });
    if (error) throw new Error(error.message);
    return Response.json({ ok: true });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "plan-choice record failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Could not record the plan choice." },
      { status: 500 },
    );
  }
}
