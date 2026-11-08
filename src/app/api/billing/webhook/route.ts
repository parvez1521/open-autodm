/**
 * POST /api/billing/webhook — payment-provider webhook receiver (public).
 *
 * ONE public URL serves both gateways; the handler is chosen by the
 * signature headers, which never overlap:
 *   - Cashfree sends `x-webhook-signature` + `x-webhook-timestamp`
 *     (owner decision 2026-11-08 ~20:34 IST: Cashfree is primary).
 *   - Razorpay sends `x-razorpay-signature` (fallback, unchanged).
 * Set THIS URL — https://opendm.in/api/billing/webhook — as the
 * webhook/notify URL in both dashboards.
 *
 * This is the ONLY path that turns a payment into access, for either
 * provider. The flow follows the Phase 12 discipline in
 * src/lib/billing/webhook.ts:
 *
 *   1. BILLING_ENABLED off (default) → 503, fully inert. (Test mode
 *      also delivers webhooks, so PAYMENTS_LIVE_MODE is NOT required
 *      here — the webhook signature is the gate.)
 *   2. The EXACT raw body is signature-verified BEFORE parsing, fail
 *      closed: Razorpay via verifyRazorpayWebhookSignature against
 *      RAZORPAY_WEBHOOK_SECRET (missing secret → 503, bad signature →
 *      401); Cashfree via verifyCashfreeWebhookSignature — base64
 *      HMAC-SHA-256 of `${x-webhook-timestamp}${rawBody}` keyed with
 *      the CLIENT SECRET (not configured → 503, bad/missing
 *      signature or timestamp → 401).
 *   3. The event is normalized (order-model events only) and the
 *      ORDER is resolved from billing_orders scoped to the event's
 *      provider — the workspace, plan and period come from THAT row
 *      (recorded at checkout), never from anything the payload
 *      claims. Unknown orders are acknowledged (200) and ignored, so
 *      the provider does not retry-storm over a foreign order on the
 *      same merchant account.
 *   4. processBillingWebhook (the existing core) re-verifies the
 *      signature, checks idempotency against the durable event store,
 *      and — decisively — re-reads the order from the provider
 *      server-side: the server snapshot wins over the webhook claim,
 *      so a success claim for an unpaid order grants NOTHING.
 *   5. The outcome is persisted (billing_events + subscriptions +
 *      billing_orders) by lib/billing/persistence.ts. A confirmed
 *      payment thereby ACTIVATES the workspace's entitlement for the
 *      purchased plan/period. Duplicate deliveries are recognised by
 *      provider event id and never double-activate.
 *
 * Responses: applied / noop / duplicate / stale / illegal → 200 (a
 * retry cannot change them). verification-unavailable → 503 so the
 * provider's redelivery retries once it recovers.
 *
 * No secret (key/client secret, webhook secret) is ever logged or
 * returned.
 */

import { createLogger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase/service";
import { readBillingFlags } from "@/lib/billing/flags";
import { readRazorpayConfig, verifyRazorpayWebhookSignature } from "@/lib/billing/razorpay";
import { RazorpayLiveProvider } from "@/lib/billing/liveProvider";
import { readCashfreeConfig, verifyCashfreeWebhookSignature } from "@/lib/billing/cashfree";
import { CashfreeLiveProvider } from "@/lib/billing/cashfreeLiveProvider";
import { processBillingWebhook } from "@/lib/billing/webhook";
import { StaticSecretsProvider } from "@/lib/billing/provider";
import {
  getBillingOrderByProviderOrderId,
  loadWebhookStore,
  orderContextOf,
  persistWebhookOutcome,
} from "@/lib/billing/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:billing:webhook");

export async function POST(request: Request): Promise<Response> {
  const flags = readBillingFlags(process.env);
  if (!flags.billingEnabled) {
    return Response.json(
      { ok: false, code: "BILLING_DISABLED", message: "Billing is not enabled on this deployment." },
      { status: 503 },
    );
  }
  // Provider dispatch by signature headers (they never overlap). A
  // request with neither provider's headers falls through to the
  // Razorpay handler, which fails closed on its missing signature —
  // the same response such a request has always received.
  const db = createServiceClient();
  const hasCashfreeHeaders =
    request.headers.get("x-webhook-signature") !== null ||
    request.headers.get("x-webhook-timestamp") !== null;
  if (hasCashfreeHeaders) return handleCashfreeWebhook(request, db);
  return handleRazorpayWebhook(request, db);
}

type BillingDb = ReturnType<typeof createServiceClient>;

async function handleCashfreeWebhook(request: Request, db: BillingDb): Promise<Response> {
  const cfConfig = readCashfreeConfig(process.env);
  const clientSecret = cfConfig.clientSecret;
  if (!cfConfig.configured || !clientSecret) {
    return Response.json(
      { ok: false, code: "PAYMENTS_NOT_CONFIGURED", message: "Payments are not configured yet." },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-webhook-signature") ?? "";
  const timestamp = request.headers.get("x-webhook-timestamp") ?? "";
  if (!verifyCashfreeWebhookSignature(rawBody, signature, clientSecret, timestamp)) {
    logger.warn({ reason: "invalid-signature" }, "cashfree webhook rejected: invalid signature");
    return Response.json(
      { ok: false, code: "INVALID_SIGNATURE", message: "Webhook signature verification failed." },
      { status: 401 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // A retry can never fix an unparseable body — acknowledge and stop.
    return Response.json({ ok: true, outcome: "unparseable" });
  }
  const event = CashfreeLiveProvider.normalizeEvent(payload);
  if (!event) {
    // Some other Cashfree event type (user-dropped, refund, …): not
    // part of the order model — acknowledge and ignore.
    return Response.json({ ok: true, outcome: "ignored" });
  }

  let order;
  try {
    order = await getBillingOrderByProviderOrderId(db, "cashfree", event.providerSubscriptionId);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "cashfree webhook order lookup failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Webhook processing failed." },
      { status: 500 },
    );
  }
  if (!order) {
    logger.warn(
      { providerOrderId: event.providerSubscriptionId, eventType: event.type },
      "cashfree webhook for unknown order ignored",
    );
    return Response.json({ ok: true, outcome: "unknown-order" });
  }

  const orderCtx = orderContextOf(order);
  try {
    const { store } = await loadWebhookStore(
      db,
      "cashfree",
      event.providerSubscriptionId,
      event.providerEventId,
      orderCtx,
    );
    const provider = new CashfreeLiveProvider(cfConfig);
    const result = await processBillingWebhook(
      {
        provider,
        store,
        secrets: new StaticSecretsProvider({ cashfree: clientSecret }),
        normalize: (p) => CashfreeLiveProvider.normalizeEvent(p),
        signatureTimestamp: timestamp,
      },
      { rawBody, signature, workspaceId: orderCtx.workspaceId },
    );

    if (result.outcome === "verification-unavailable") {
      // Nothing was granted and nothing was recorded; a 503 invites
      // Cashfree redelivery once the provider is reachable again.
      logger.warn({ providerOrderId: order.providerOrderId }, "cashfree webhook verification unavailable");
      return Response.json(
        { ok: false, code: "VERIFICATION_UNAVAILABLE", outcome: result.outcome },
        { status: 503 },
      );
    }

    const finalRecord = store.getSubscription(event.providerSubscriptionId);
    await persistWebhookOutcome(db, {
      provider: "cashfree",
      order,
      orderCtx,
      event,
      outcome: result.outcome,
      finalRecord,
      // The Cashfree payment id rides in the normalized event id
      // (`<TYPE>:<cf_payment_id>`); pass it explicitly so the order
      // row records the real payment id.
      providerPaymentId: event.providerEventId.split(":")[1] ?? null,
    });
    logger.info(
      {
        providerOrderId: order.providerOrderId,
        workspaceId: orderCtx.workspaceId,
        outcome: result.outcome,
        entitlementGranted: result.entitlementGranted,
      },
      "cashfree webhook processed",
    );
    return Response.json({
      ok: true,
      outcome: result.outcome,
      entitlementGranted: result.entitlementGranted,
      subscriptionStatus: result.subscriptionStatus,
    });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "cashfree webhook processing failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Webhook processing failed." },
      { status: 500 },
    );
  }
}

async function handleRazorpayWebhook(request: Request, db: BillingDb): Promise<Response> {
  const config = readRazorpayConfig(process.env);
  if (!config.webhookSecret) {
    return Response.json(
      { ok: false, code: "PAYMENTS_NOT_CONFIGURED", message: "Payments are not configured yet." },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!verifyRazorpayWebhookSignature(rawBody, signature, config.webhookSecret)) {
    logger.warn({ reason: "invalid-signature" }, "razorpay webhook rejected: invalid signature");
    return Response.json(
      { ok: false, code: "INVALID_SIGNATURE", message: "Webhook signature verification failed." },
      { status: 401 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // A retry can never fix an unparseable body — acknowledge and stop.
    return Response.json({ ok: true, outcome: "unparseable" });
  }
  const event = RazorpayLiveProvider.normalizeEvent(payload);
  if (!event) {
    // Some other Razorpay event type (refund, subscription, …): not
    // part of the order model — acknowledge and ignore.
    return Response.json({ ok: true, outcome: "ignored" });
  }

  let order;
  try {
    order = await getBillingOrderByProviderOrderId(db, "razorpay", event.providerSubscriptionId);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "webhook order lookup failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Webhook processing failed." },
      { status: 500 },
    );
  }
  if (!order) {
    logger.warn(
      { providerOrderId: event.providerSubscriptionId, eventType: event.type },
      "webhook for unknown order ignored",
    );
    return Response.json({ ok: true, outcome: "unknown-order" });
  }

  const orderCtx = orderContextOf(order);
  try {
    const { store } = await loadWebhookStore(
      db,
      "razorpay",
      event.providerSubscriptionId,
      event.providerEventId,
      orderCtx,
    );
    const provider = new RazorpayLiveProvider(config);
    const result = await processBillingWebhook(
      {
        provider,
        store,
        secrets: new StaticSecretsProvider({ razorpay: config.webhookSecret }),
        normalize: (p) => RazorpayLiveProvider.normalizeEvent(p),
      },
      { rawBody, signature, workspaceId: orderCtx.workspaceId },
    );

    if (result.outcome === "verification-unavailable") {
      // Nothing was granted and nothing was recorded; a 503 invites
      // Razorpay redelivery once the provider is reachable again.
      logger.warn({ providerOrderId: order.providerOrderId }, "webhook verification unavailable");
      return Response.json(
        { ok: false, code: "VERIFICATION_UNAVAILABLE", outcome: result.outcome },
        { status: 503 },
      );
    }

    const finalRecord = store.getSubscription(event.providerSubscriptionId);
    await persistWebhookOutcome(db, {
      provider: "razorpay",
      order,
      orderCtx,
      event,
      outcome: result.outcome,
      finalRecord,
    });
    logger.info(
      {
        providerOrderId: order.providerOrderId,
        workspaceId: orderCtx.workspaceId,
        outcome: result.outcome,
        entitlementGranted: result.entitlementGranted,
      },
      "razorpay webhook processed",
    );
    return Response.json({
      ok: true,
      outcome: result.outcome,
      entitlementGranted: result.entitlementGranted,
      subscriptionStatus: result.subscriptionStatus,
    });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "webhook processing failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Webhook processing failed." },
      { status: 500 },
    );
  }
}
