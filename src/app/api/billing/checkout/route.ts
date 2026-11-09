/**
 * POST /api/billing/checkout — create a payment-provider order for a plan.
 *
 * PROVIDER SELECTION (owner decision 2026-11-08 ~20:34 IST): Cashfree
 * is the PRIMARY gateway — when CASHFREE_CLIENT_ID +
 * CASHFREE_CLIENT_SECRET are configured, checkout creates a Cashfree
 * order. Razorpay is the fallback and stays fully wired: it is used
 * only when Cashfree is not configured and Razorpay keys are (see
 * lib/billing/activeProvider.ts). Customers are both Indian (UPI,
 * INR) and international (cards, USD) — the checkout currency follows
 * the caller's currency field, which the BillingPanel resolves from
 * the geo display currency (India → INR, else USD) — and since
 * 2026-11-09 the route VERIFIES that field against its own
 * server-side geo resolution (400 CURRENCY_MISMATCH; audit Bug 5)
 * and refuses annual periods outright (monthly only; audit Bug 6).
 *
 * SCAFFOLDING — deliberately inert until the owner enables it:
 *  - BILLING_ENABLED off (default)            → 503 BILLING_DISABLED
 *  - PAYMENTS_LIVE_MODE off (default), or no
 *    provider configured in env              → 503 PAYMENTS_NOT_CONFIGURED
 * Only when billing is enabled AND live mode is on AND a provider is
 * configured does this create a real order — and an order by itself
 * charges nobody. Payment completion is confirmed later, server-side,
 * via the signed webhook (see lib/billing/webhook.ts); this route
 * never marks anything paid.
 *
 * Prices come from the billing catalogue (lib/billing/catalogue.ts),
 * owner-approved on 2026-11-08. Plans without a self-serve price —
 * Free, and Enterprise (custom, sales-led) — are refused here with
 * PLAN_NOT_PURCHASABLE; Enterprise is sold by conversation only.
 *
 * Cashfree REQUIRES a customer phone for checkout: when Cashfree is
 * the active provider the body must carry `customerPhone` (10 digits,
 * collected by the BillingPanel — profiles/sessions carry no phone)
 * or the request is refused with 400 INVALID_CUSTOMER_PHONE before
 * any provider call.
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

import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logger";
import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { readBillingFlags } from "@/lib/billing/flags";
import { getPlan, type BillingPeriod, type CurrencyCode, type PlanId } from "@/lib/billing/catalogue";
import {
  createRazorpayOrder,
  RazorpayApiError,
} from "@/lib/billing/razorpay";
import {
  createCashfreeOrder,
  CashfreeApiError,
  type CashfreeConfig,
} from "@/lib/billing/cashfree";
import { resolveActiveBillingProvider } from "@/lib/billing/activeProvider";
import { serverCurrencyForRequest } from "@/lib/billing/geo";
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

/** Normalize a customer phone to exactly 10 digits, or null when invalid. */
function normalizeCustomerPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

export async function POST(request: Request): Promise<Response> {
  const flags = readBillingFlags(process.env);
  if (!flags.billingEnabled) {
    return notConfigured(
      "BILLING_DISABLED",
      "Billing is not enabled on this deployment.",
    );
  }
  const active = resolveActiveBillingProvider(process.env);
  if (!flags.paymentsLiveMode || !active) {
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
    customerPhone?: unknown;
  };
  const planId = fields.planId;
  if (typeof planId !== "string" || !(PLAN_IDS as readonly string[]).includes(planId)) {
    return Response.json(
      { ok: false, code: "UNKNOWN_PLAN", message: "Unknown plan." },
      { status: 400 },
    );
  }
  // Currency is decided SERVER-SIDE from the caller's geo (audit
  // Bug 5 fix, 2026-11-09): the body's currency is only accepted
  // when it matches the geo resolution (edge country header /
  // geo cookie — see lib/billing/geo.ts serverCurrencyForRequest).
  // A mismatch is refused (400 CURRENCY_MISMATCH) instead of
  // silently charging the cheaper figure; with no geo signal at
  // all (local/non-edge runtimes) the body's currency stands, and
  // an omitted currency falls back to the geo resolution.
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
          message: `Prices for your region are in ${serverCurrency}; checkout cannot be opened in ${String(fields.currency)}.`,
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
  // 2026-11-09): no UI offers annual, and the API no longer sells
  // it either — an annual request is refused, not discounted.
  if (period !== "monthly") {
    return Response.json(
      {
        ok: false,
        code: "PERIOD_NOT_OFFERED",
        message: "Only monthly billing is offered.",
      },
      { status: 400 },
    );
  }

  const plan = getPlan(planId as PlanId);
  const price = plan.prices[currency];
  // Monthly-only (the guard above has already refused 'annual').
  const amountMinor = price.monthlyMinor;
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

  // Cashfree requires a customer phone to open checkout. Profiles and
  // sessions carry no phone, so the panel collects it per checkout and
  // the route refuses without it — before auth or any provider call.
  let customerPhone: string | null = null;
  if (active.providerId === "cashfree") {
    customerPhone = normalizeCustomerPhone(fields.customerPhone);
    if (!customerPhone) {
      return Response.json(
        {
          ok: false,
          code: "INVALID_CUSTOMER_PHONE",
          message: "A 10-digit mobile number is required to open the payment window.",
        },
        { status: 400 },
      );
    }
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

  if (active.providerId === "cashfree") {
    return cashfreeCheckout({
      request,
      db,
      config: active.cashfree,
      plan,
      period,
      currency,
      amountMinor,
      workspaceId,
      customerPhone: customerPhone!,
      customerEmail: user.email,
    });
  }

  const config = active.razorpay;
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
      provider: "razorpay",
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

interface CashfreeCheckoutArgs {
  request: Request;
  db: ReturnType<typeof createServiceClient>;
  config: CashfreeConfig;
  plan: ReturnType<typeof getPlan>;
  period: BillingPeriod;
  currency: CurrencyCode;
  amountMinor: number;
  workspaceId: string;
  customerPhone: string;
  customerEmail: string | undefined;
}

/**
 * Cashfree branch of checkout: create the order at Cashfree (with OUR
 * order id, which Cashfree echoes and the webhook later resolves),
 * record it in billing_orders BEFORE responding, and return the
 * payment_session_id the Cashfree JS SDK needs. Nothing secret is
 * returned — the SDK runs on the session id + mode alone.
 */
async function cashfreeCheckout(args: CashfreeCheckoutArgs): Promise<Response> {
  const { db, config, plan, period, currency, amountMinor, workspaceId } = args;
  const orderId = `opdm_${plan.id}_${period}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`.slice(0, 50);
  const origin = new URL(args.request.url).origin;
  try {
    const order = await createCashfreeOrder(config, {
      orderId,
      amountMinor,
      currency,
      customer: {
        customerId: `ws_${workspaceId}`,
        phone: args.customerPhone,
        ...(args.customerEmail ? { email: args.customerEmail } : {}),
      },
      returnUrl: `${origin}/billing`,
      notifyUrl: `${origin}/api/billing/webhook`,
      note: `${plan.name} plan — ${period}`,
    });
    // Record the order against the workspace BEFORE returning it: the
    // signed webhook resolves workspace + plan from this row.
    try {
      await createBillingOrder(db, {
        workspaceId,
        provider: "cashfree",
        providerOrderId: order.orderId,
        planId: plan.id,
        billingPeriod: period,
        amountMinor,
        currency,
        receipt: orderId,
      });
    } catch (err) {
      if (err instanceof BillingPersistenceError) {
        logger.error(
          { orderId: order.orderId, workspaceId },
          "cashfree order created but could not be recorded; failing loudly",
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
      { orderId: order.orderId, workspaceId, planId: plan.id, period, currency, amountMinor },
      "cashfree order created",
    );
    return Response.json({
      ok: true,
      provider: "cashfree",
      order: {
        id: order.orderId,
        amount: amountMinor,
        currency,
        status: order.orderStatus,
        receipt: orderId,
      },
      // The payment session id is what the Cashfree JS SDK checks out
      // with. It is a session handle, not a credential — the client
      // secret never leaves the server.
      paymentSessionId: order.paymentSessionId,
      mode: config.environment,
      planId: plan.id,
      period,
      workspaceId,
    });
  } catch (err) {
    if (err instanceof CashfreeApiError) {
      logger.error(
        { status: err.status, providerCode: err.providerCode },
        "cashfree order creation failed",
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
      "cashfree checkout failed unexpectedly",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Checkout failed. Nothing was charged." },
      { status: 500 },
    );
  }
}
