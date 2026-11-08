/**
 * POST /api/billing/checkout — create a Razorpay order for a plan.
 *
 * SCAFFOLDING — deliberately inert until the owner enables it:
 *  - BILLING_ENABLED off (default)            → 503 BILLING_DISABLED
 *  - PAYMENTS_LIVE_MODE off (default), or
 *    Razorpay keys missing from env           → 503 PAYMENTS_NOT_CONFIGURED
 * Only when billing is enabled AND live mode is on AND the Razorpay
 * keys are configured does this create a real order — and an order by
 * itself charges nobody. Payment completion is confirmed later,
 * server-side, via the signed webhook (see lib/billing/razorpay.ts and
 * lib/billing/webhook.ts); this route never marks anything paid.
 *
 * Prices come from the billing catalogue (lib/billing/catalogue.ts),
 * owner-approved on 2026-11-08. Plans without a self-serve price —
 * Free, and Enterprise (custom, sales-led) — are refused here with
 * PLAN_NOT_PURCHASABLE; Enterprise is sold by conversation only.
 *
 * Workspace binding (subscription wiring, 2026-11-08): once the plan
 * is validated, the caller must be authenticated and the workspace is
 * resolved through src/lib/billing/access.ts (selector, or the
 * caller's single membership re-resolved). Only the workspace OWNER
 * (manageBilling) may check out. The created order is recorded in
 * billing_orders against that workspace BEFORE the response returns —
 * that record is what the signed webhook later resolves the workspace
 * and plan from; a request whose order cannot be recorded fails
 * loudly (500 ORDER_RECORD_FAILED) instead of returning an order the
 * webhook would have to ignore as unknown.
 */

import { createLogger } from "@/lib/logger";
import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { readBillingFlags } from "@/lib/billing/flags";
import { getPlan, type BillingPeriod, type CurrencyCode, type PlanId } from "@/lib/billing/catalogue";
import {
  createRazorpayOrder,
  readRazorpayConfig,
  RazorpayApiError,
} from "@/lib/billing/razorpay";
import {
  billingWorkspaceSelector,
  resolveBillingWorkspace,
  billingManagerFailure,
  workspaceFailureResponse,
} from "@/lib/billing/access";
import {
  createBillingOrder,
  getWorkspaceSubscription,
  BillingPersistenceError,
} from "@/lib/billing/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:billing:checkout");

const PLAN_IDS: readonly PlanId[] = ["free", "starter", "creator-pro", "agency", "enterprise"];
const CURRENCIES: readonly CurrencyCode[] = ["INR", "USD"];
const PERIODS: readonly BillingPeriod[] = ["monthly", "annual"];

function notConfigured(code: string, message: string): Response {
  return Response.json({ ok: false, code, message }, { status: 503 });
}

export async function POST(request: Request): Promise<Response> {
  const flags = readBillingFlags(process.env);
  if (!flags.billingEnabled) {
    return notConfigured(
      "BILLING_DISABLED",
      "Billing is not enabled on this deployment.",
    );
  }
  const config = readRazorpayConfig(process.env);
  if (!flags.paymentsLiveMode || !config.configured) {
    return notConfigured(
      "PAYMENTS_NOT_CONFIGURED",
      "Payments are not configured yet. The owner still needs to connect a payment provider.",
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
  const planId = fields.planId;
  if (typeof planId !== "string" || !(PLAN_IDS as readonly string[]).includes(planId)) {
    return Response.json(
      { ok: false, code: "UNKNOWN_PLAN", message: "Unknown plan." },
      { status: 400 },
    );
  }
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

  const plan = getPlan(planId as PlanId);
  const price = plan.prices[currency];
  const amountMinor = period === "annual" ? price.annualTotalMinor : price.monthlyMinor;
  if (amountMinor <= 0) {
    return Response.json(
      {
        ok: false,
        code: "PLAN_NOT_PURCHASABLE",
        message: "This plan has no price to charge. Paid plans only.",
      },
      { status: 400 },
    );
  }

  // ── Workspace binding: authenticated caller, resolved workspace,
  // owner-only (manageBilling). The order is recorded against this
  // workspace below — never against a client-claimed id alone.
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

  // A subscription's currency is immutable once issued (…000027
  // trigger): a workspace with an existing row in another currency
  // must finish/cancel that subscription first — refuse here, before
  // any provider order exists.
  try {
    const existingSub = await getWorkspaceSubscription(db, workspaceId);
    if (existingSub && existingSub.currency !== currency) {
      return Response.json(
        {
          ok: false,
          code: "CURRENCY_LOCKED",
          message: `This workspace's subscription is in ${existingSub.currency}; its currency cannot be changed.`,
        },
        { status: 409 },
      );
    }
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "checkout subscription pre-check failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Checkout failed. Nothing was charged." },
      { status: 500 },
    );
  }

  const receipt = `opdm_${plan.id}_${period}_${Date.now().toString(36)}`.slice(0, 40);
  try {
    const order = await createRazorpayOrder(config, {
      amountMinor,
      currency,
      receipt,
      notes: { planId: plan.id, period, currency, workspaceId, source: "opendm-checkout" },
    });
    // Record the order against the workspace BEFORE returning it: the
    // signed webhook resolves workspace + plan from this row.
    try {
      await createBillingOrder(db, {
        workspaceId,
        provider: "razorpay",
        providerOrderId: order.id,
        planId: plan.id,
        billingPeriod: period,
        amountMinor,
        currency,
        receipt,
      });
    } catch (err) {
      if (err instanceof BillingPersistenceError) {
        logger.error(
          { orderId: order.id, workspaceId },
          "razorpay order created but could not be recorded; failing loudly",
        );
        return Response.json(
          {
            ok: false,
            code: "ORDER_RECORD_FAILED",
            message: "The payment order could not be recorded. Nothing was charged; please retry.",
          },
          { status: 500 },
        );
      }
      throw err;
    }
    logger.info(
      { orderId: order.id, workspaceId, planId: plan.id, period, currency, amountMinor },
      "razorpay order created",
    );
    return Response.json({
      ok: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        status: order.status,
        receipt: order.receipt,
      },
      // The KEY ID is public (Razorpay Checkout needs it client-side).
      // The key secret never leaves the server.
      keyId: config.keyId,
      planId: plan.id,
      period,
      workspaceId,
    });
  } catch (err) {
    if (err instanceof RazorpayApiError) {
      logger.error(
        { status: err.status, providerCode: err.providerCode },
        "razorpay order creation failed",
      );
      return Response.json(
        {
          ok: false,
          code: "PROVIDER_ERROR",
          message: "The payment provider could not create an order. Nothing was charged.",
        },
        { status: 502 },
      );
    }
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "checkout failed unexpectedly",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Checkout failed. Nothing was charged." },
      { status: 500 },
    );
  }
}
