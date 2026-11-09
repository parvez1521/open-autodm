/**
 * POST /api/billing/trial — start the 15-day free trial (no card).
 *
 * Owner policy (catalogue.ts): every self-serve paid plan starts with
 * a 15-day free trial, no card upfront; at expiry the workspace drops
 * back to Free unless its owner checks out. Starting a trial therefore
 * needs NO payment provider at all — this route is gated only by
 * BILLING_ENABLED (503 while off, the default) and deliberately does
 * NOT require PAYMENTS_LIVE_MODE or Razorpay keys.
 *
 * The caller must be authenticated; the workspace is resolved through
 * src/lib/billing/access.ts (selector or single-membership default);
 * only the workspace OWNER (manageBilling) may start a trial. The
 * subscription row moves to `trialing` with the trial window recorded
 * (trial_ends_at), which is what the entitlement service reads:
 * `trialing` grants the plan (limits included, e.g. 1/3/5 Instagram
 * accounts) until the window closes, after which the lapse logic in
 * lib/billing/trial.ts resolves the workspace back to Free.
 *
 * One trial per workspace (see evaluateTrialStart): already-active →
 * 409 ALREADY_SUBSCRIBED, already-trialing → 409 ALREADY_TRIALING,
 * trial previously used → 409 TRIAL_ALREADY_USED. Re-posting the same
 * start while trialing the SAME plan is treated as an idempotent
 * read of the running trial (200, no state change) so client retries
 * are safe.
 */

import { createLogger } from "@/lib/logger";
import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { readBillingFlags } from "@/lib/billing/flags";
import { getPlan, type BillingPeriod, type CurrencyCode, type PlanId } from "@/lib/billing/catalogue";
import {
  billingWorkspaceSelector,
  resolveBillingWorkspace,
  billingManagerFailure,
  workspaceFailureResponse,
} from "@/lib/billing/access";
import {
  getWorkspaceSubscription,
  upsertWorkspaceSubscription,
} from "@/lib/billing/persistence";
import {
  evaluateTrialStart,
  trialWindow,
  trialDaysRemaining,
} from "@/lib/billing/trial";
import { applyPeriodLapse } from "@/lib/billing/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:billing:trial");

const PLAN_IDS: readonly PlanId[] = ["free", "starter", "creator-pro", "agency", "enterprise"];
const CURRENCIES: readonly CurrencyCode[] = ["INR", "USD"];
const PERIODS: readonly BillingPeriod[] = ["monthly", "annual"];

export async function POST(request: Request): Promise<Response> {
  const flags = readBillingFlags(process.env);
  if (!flags.billingEnabled) {
    return Response.json(
      { ok: false, code: "BILLING_DISABLED", message: "Billing is not enabled on this deployment." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, code: "INVALID_BODY", message: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const fields = (body ?? {}) as {
    planId?: unknown;
    currency?: unknown;
    period?: unknown;
    workspaceId?: unknown;
  };
  if (typeof fields.planId !== "string" || !(PLAN_IDS as readonly string[]).includes(fields.planId)) {
    return Response.json(
      { ok: false, code: "UNKNOWN_PLAN", message: "Unknown plan." },
      { status: 400 },
    );
  }
  const planId = fields.planId as PlanId;
  const currency = (fields.currency ?? "INR") as CurrencyCode;
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    return Response.json(
      { ok: false, code: "INVALID_CURRENCY", message: "Currency must be INR or USD." },
      { status: 400 },
    );
  }
  const period = (fields.period ?? "monthly") as BillingPeriod;
  if (!(PERIODS as readonly string[]).includes(period)) {
    return Response.json(
      { ok: false, code: "INVALID_PERIOD", message: "Period must be monthly or annual." },
      { status: 400 },
    );
  }

  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const db = createServiceClient();
  const resolved = await resolveBillingWorkspace(
    db,
    user.id,
    billingWorkspaceSelector(request, fields.workspaceId),
  );
  if (!resolved.ok) return workspaceFailureResponse(resolved);
  const managerFailure = billingManagerFailure(resolved.ctx);
  if (managerFailure) return workspaceFailureResponse(managerFailure);
  const workspaceId = resolved.ctx.workspaceId;

  try {
    const existing = await getWorkspaceSubscription(db, workspaceId);
    // Period lapse (Bug 1 fix, 2026-11-09): the decision reads the
    // EFFECTIVE state — an `active` row whose paid period has ended
    // is expired for decision purposes, not "already subscribed"
    // (it falls through to the trial-marker rules below instead:
    // a workspace that never trialed may trial; one that converted
    // from a trial still hits TRIAL_ALREADY_USED). The stored row
    // itself is not rewritten by this read.
    const view = applyPeriodLapse(
      existing
        ? {
            planId: existing.planId,
            status: existing.status,
            trialEndsAt: existing.trialEndsAt,
            currentPeriodEnd: existing.currentPeriodEnd,
          }
        : null,
      new Date(),
    );

    // Idempotent re-post: already trialing THIS plan → return the
    // running trial unchanged (no window extension, no state change).
    if (existing && existing.status === "trialing" && existing.planId === planId) {
      return Response.json({
        ok: true,
        alreadyTrialing: true,
        workspaceId,
        subscription: {
          planId: existing.planId,
          status: existing.status,
          trialEndsAt: existing.trialEndsAt,
          trialDaysRemaining: trialDaysRemaining(existing.trialEndsAt, new Date()),
        },
      });
    }

    const decision = evaluateTrialStart(view, planId);
    if (!decision.ok) {
      const status = decision.code === "TRIAL_NOT_AVAILABLE" ? 400 : 409;
      return Response.json(
        { ok: false, code: decision.code, message: decision.message },
        { status },
      );
    }

    if (existing && existing.currency !== currency) {
      return Response.json(
        {
          ok: false,
          code: "CURRENCY_LOCKED",
          message: `This workspace's subscription is in ${existing.currency}; its currency cannot be changed.`,
        },
        { status: 409 },
      );
    }

    const now = new Date();
    const window = trialWindow(now);
    const plan = getPlan(planId);
    const row = await upsertWorkspaceSubscription(db, workspaceId, {
      planId: plan.id,
      status: "trialing",
      provider: null,
      providerSubscriptionId: null,
      billingPeriod: period,
      amountMinor: 0,
      currency,
      currentPeriodStart: window.startsAt.toISOString(),
      currentPeriodEnd: window.endsAt.toISOString(),
      trialEndsAt: window.endsAt.toISOString(),
    });
    logger.info({ workspaceId, planId: plan.id, trialEndsAt: row.trialEndsAt }, "trial started");
    return Response.json({
      ok: true,
      workspaceId,
      subscription: {
        planId: row.planId,
        status: row.status,
        trialEndsAt: row.trialEndsAt,
        trialDaysRemaining: trialDaysRemaining(row.trialEndsAt, now),
      },
    });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "trial start failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Could not start the trial." },
      { status: 500 },
    );
  }
}
