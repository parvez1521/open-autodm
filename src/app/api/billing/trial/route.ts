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
 * trial previously used → 409 TRIAL_ALREADY_USED. Since 2026-11-09
 * the route ALSO enforces one trial per USER: a trial already used
 * in another workspace the caller owns refuses with the same
 * TRIAL_ALREADY_USED (trial/workspace farming fix). Re-posting the same
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
import { serverCurrencyForRequest } from "@/lib/billing/geo";
import { createPerUserRateLimiter } from "@/lib/studio/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:billing:trial");

// Rate limiting (security audit Phase B, 2026-11-10 — finding #8):
// the shared per-user limiter the Studio AI / script-writer routes
// already use (lib/studio/groq.ts), same defaults (10/min burst,
// 50/day per user), counted on authenticated attempts so trial
// starts cannot be churned per account.
const limiter = createPerUserRateLimiter();

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
  // Currency is decided SERVER-SIDE from the caller's geo, exactly
  // as in checkout (audit Bug 5 fix, 2026-11-09): a body currency
  // that disagrees with the geo resolution is refused (400
  // CURRENCY_MISMATCH) whenever a geo signal exists; an omitted
  // currency falls back to the geo resolution.
  const serverCurrency = serverCurrencyForRequest(request);
  if (fields.currency !== undefined && fields.currency !== null) {
    if (!(CURRENCIES as readonly string[]).includes(fields.currency as CurrencyCode)) {
      return Response.json(
        { ok: false, code: "INVALID_CURRENCY", message: "Currency must be INR or USD." },
        { status: 400 },
      );
    }
    if (serverCurrency && fields.currency !== serverCurrency) {
      return Response.json(
        {
          ok: false,
          code: "CURRENCY_MISMATCH",
          message: `Prices for your region are in ${serverCurrency}; a trial cannot be started in ${String(fields.currency)}.`,
        },
        { status: 400 },
      );
    }
  }
  const currency = (fields.currency ?? serverCurrency ?? "INR") as CurrencyCode;
  const period = (fields.period ?? "monthly") as BillingPeriod;
  if (!(PERIODS as readonly string[]).includes(period)) {
    return Response.json(
      { ok: false, code: "INVALID_PERIOD", message: "Period must be monthly or annual." },
      { status: 400 },
    );
  }
  // Monthly only (owner instruction 2026-11-08; audit Bug 6 fix,
  // 2026-11-09): trials are monthly, like everything else.
  if (period !== "monthly") {
    return Response.json(
      { ok: false, code: "PERIOD_NOT_OFFERED", message: "Only monthly billing is offered." },
      { status: 400 },
    );
  }

  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const refusal = limiter.check(user.id);
  if (refusal) {
    logger.warn({ userId: user.id, refusal }, "trial start refused by per-user limiter");
    return Response.json(
      {
        ok: false,
        code: refusal === "daily_quota_reached" ? "DAILY_QUOTA_REACHED" : "RATE_LIMITED",
        message:
          refusal === "daily_quota_reached"
            ? "You have reached today's billing request limit. Please try again tomorrow."
            : "Too many billing requests in a row. Please wait a minute and try again.",
      },
      { status: 429 },
    );
  }
  limiter.record(user.id);
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

    // Trial farming fix (2026-11-09): the trial is one per USER,
    // not one per workspace. evaluateTrialStart above only sees
    // THIS workspace's row; a user who already trialed in another
    // workspace they own must not get a second trial by minting a
    // fresh workspace. Any OTHER owned workspace whose subscription
    // row carries the trial-used marker (trial_ends_at — payment
    // conversion deliberately keeps it as history) refuses the
    // start with the same TRIAL_ALREADY_USED code.
    const { data: ownedRows } = await db
      .from("workspace_memberships")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("role", "owner");
    const otherOwnedIds = (ownedRows ?? [])
      .map((r) => (r as { workspace_id?: unknown }).workspace_id)
      .filter((v): v is string => typeof v === "string" && v !== workspaceId);
    if (otherOwnedIds.length > 0) {
      let trialedElsewhere = false;
      for (const otherId of otherOwnedIds) {
        const otherSub = await getWorkspaceSubscription(db, otherId);
        if (otherSub?.trialEndsAt) {
          trialedElsewhere = true;
          break;
        }
      }
      if (trialedElsewhere) {
        return Response.json(
          {
            ok: false,
            code: "TRIAL_ALREADY_USED",
            message: "You have already used your free trial in another workspace.",
          },
          { status: 409 },
        );
      }
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
