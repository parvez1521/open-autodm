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
 * NOTE (pre-live wiring, intentionally not invented here): in
 * production this route must be bound to the caller's authenticated
 * workspace session and record the order against that workspace before
 * returning it. That binding belongs to the billing go-live step, not
 * to this scaffolding.
 */

import { createLogger } from "@/lib/logger";
import { readBillingFlags } from "@/lib/billing/flags";
import { getPlan, type BillingPeriod, type CurrencyCode, type PlanId } from "@/lib/billing/catalogue";
import {
  createRazorpayOrder,
  readRazorpayConfig,
  RazorpayApiError,
} from "@/lib/billing/razorpay";

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

  const receipt = `opdm_${plan.id}_${period}_${Date.now().toString(36)}`.slice(0, 40);
  try {
    const order = await createRazorpayOrder(config, {
      amountMinor,
      currency,
      receipt,
      notes: { planId: plan.id, period, currency, source: "opendm-checkout" },
    });
    logger.info(
      { orderId: order.id, planId: plan.id, period, currency, amountMinor },
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
