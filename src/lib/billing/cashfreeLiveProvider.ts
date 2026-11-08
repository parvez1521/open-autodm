/**
 * Cashfree LIVE provider adapter — SaaS subscription wiring
 * (owner decision 2026-11-08 ~20:34 IST: Cashfree primary).
 *
 * Implements the Phase 12 BillingProvider interface against Cashfree's
 * real Payment Gateway REST API so the existing webhook core
 * (src/lib/billing/webhook.ts, processBillingWebhook) can process
 * LIVE Cashfree events unchanged — the exact role
 * RazorpayLiveProvider plays for Razorpay:
 *
 *   - Signature verification delegates to verifyCashfreeWebhookSignature
 *     in ./cashfree.ts (base64 HMAC-SHA-256 of
 *     `${x-webhook-timestamp}${rawBody}` with the client secret, over
 *     the EXACT raw body, fail closed). Cashfree signs webhooks with
 *     the CLIENT SECRET — there is no separate webhook secret.
 *   - Server-side verification (the core's step 4 — "the server
 *     snapshot WINS over webhook claims") is fetchSubscription below:
 *     a signed webhook claim of success is only ever believed after
 *     this adapter re-reads the order from Cashfree
 *     (GET /orders/{id}) and finds order_status actually 'PAID'.
 *
 * ORDER MODEL — same as Razorpay's: this product sells via one-time
 * provider ORDERS (checkout creates an order; see
 * src/app/api/billing/checkout/route.ts), not Cashfree Subscriptions.
 * `providerSubscriptionId` throughout the Phase 12 core therefore
 * carries the Cashfree ORDER id (our merchant order id, echoed by
 * Cashfree as order_id). The binding of order → workspace/plan/period
 * lives in billing_orders (migration …000035) and is resolved by the
 * webhook route BEFORE the core runs — never from payload claims.
 *
 * Capabilities are honest about the order model: no provider-side
 * trials (trials are OUR no-card flow, src/lib/billing/trial.ts), no
 * autopay mandates on one-time orders, no pause/resume, no in-place
 * plan change, no proration. Methods the order flow cannot express
 * throw a typed UnsupportedCashfreeOperation instead of pretending.
 *
 * Secrets rule: the client secret is used only for the x-client-secret
 * API header and webhook HMAC on the server. It is NEVER logged and
 * NEVER returned to clients — Cashfree Checkout needs only the
 * payment_session_id, which is not a secret.
 */

import type {
  BillingProvider,
  ProviderCapabilities,
  ProviderSubscriptionSnapshot,
} from './provider';
import { mapStatus } from './provider';
import type { SubscriptionStatus } from './lifecycle';
import type { NormalizedPaymentEvent } from './events';
import type { CurrencyCode } from './catalogue';
import {
  verifyCashfreeWebhookSignature,
  fetchCashfreeOrder,
  type CashfreeConfig,
  type CashfreeOrderSnapshotRaw,
} from './cashfree';

/**
 * Order-status → lifecycle mapping for the order model (explicit,
 * auditable). Only a server-read 'PAID' may activate; an 'EXPIRED'
 * (never-paid) order maps to 'incomplete' like an open one — it
 * grants nothing and must not move a workspace's plan.
 */
export const CASHFREE_ORDER_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  PAID: 'active',
  ACTIVE: 'incomplete',
  EXPIRED: 'incomplete',
};

export const CASHFREE_LIVE_CAPABILITIES: ProviderCapabilities = {
  supportsUpiAutopay: false, // one-time orders, not autopay subscriptions
  supportsENach: false,
  supportsEmandate: false,
  supportsTrials: false, // trials are handled by our own no-card flow
  supportsPause: false,
  supportsCustomerPause: false,
  supportsProration: false,
  supportsInPlacePlanChange: false,
  supportsInternationalCards: true,
  supportsRefundsViaApi: true,
  currencies: ['INR', 'USD'],
  settlementCurrency: 'INR',
  webhookSignatureScheme:
    'base64 HMAC-SHA256 of `${x-webhook-timestamp}${rawBody}` (plain concatenation) with the client secret; headers x-webhook-signature + x-webhook-timestamp',
};

export class UnsupportedCashfreeOperation extends Error {
  constructor(operation: string) {
    super(`Cashfree order-model adapter does not support: ${operation}`);
    this.name = 'UnsupportedCashfreeOperation';
  }
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type { CashfreeOrderSnapshotRaw };

export class CashfreeLiveProvider implements BillingProvider {
  readonly id = 'cashfree' as const;
  readonly capabilities = CASHFREE_LIVE_CAPABILITIES;
  readonly statusMap = CASHFREE_ORDER_STATUS_MAP;

  constructor(
    private readonly config: CashfreeConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  mapProviderStatus(raw: string): SubscriptionStatus {
    return mapStatus(this.statusMap, raw);
  }

  /** Read one order from Cashfree (server-side truth for the webhook core). */
  async fetchOrder(providerOrderId: string): Promise<CashfreeOrderSnapshotRaw> {
    return fetchCashfreeOrder(this.config, providerOrderId, this.fetchImpl);
  }

  /**
   * Phase 12 core step 4: re-read the order from Cashfree. An order is
   * 'active' ONLY when Cashfree itself reports order_status 'PAID';
   * anything else (ACTIVE / EXPIRED / unknown raw status) resolves to
   * 'incomplete' so a webhook claim can never grant entitlement on
   * its own.
   */
  async fetchSubscription(providerOrderId: string): Promise<ProviderSubscriptionSnapshot> {
    const order = await this.fetchOrder(providerOrderId);
    let status: SubscriptionStatus = 'incomplete';
    try {
      status = this.mapProviderStatus(order.status);
    } catch {
      status = 'incomplete';
    }
    return {
      providerSubscriptionId: order.orderId,
      providerStatusRaw: order.status,
      status,
      currency: (order.currency === 'USD' ? 'USD' : 'INR') as CurrencyCode,
      amountMinor: order.amountMinor,
      currentPeriodEnd: null,
    };
  }

  verifyWebhookSignature(
    rawBody: string,
    signature: string,
    secret: string,
    timestamp?: string,
  ): boolean {
    return verifyCashfreeWebhookSignature(rawBody, signature, secret, timestamp);
  }

  // ── Operations the order model does not express ─────────────────────
  // Checkout creates orders directly (./cashfree.ts createCashfreeOrder);
  // there is no provider-side customer/subscription lifecycle to drive.

  async createCustomer(): Promise<never> {
    throw new UnsupportedCashfreeOperation('createCustomer (orders carry the customer inline)');
  }
  async createSubscriptionCheckout(): Promise<never> {
    throw new UnsupportedCashfreeOperation('createSubscriptionCheckout (use createCashfreeOrder)');
  }
  async cancelSubscription(): Promise<never> {
    throw new UnsupportedCashfreeOperation('cancelSubscription (orders cannot be cancelled)');
  }
  async fetchPaymentStatus(): Promise<never> {
    throw new UnsupportedCashfreeOperation(
      'fetchPaymentStatus (Cashfree reads payments per-order; the order re-read is the verification path)',
    );
  }
  async reconcileEvents(providerOrderId: string): Promise<ProviderSubscriptionSnapshot> {
    return this.fetchSubscription(providerOrderId);
  }

  /**
   * Normalize a LIVE Cashfree PG webhook payload (already
   * signature-verified by the route/core before this is trusted).
   * Only the two payment-outcome events are meaningful in the order
   * model; everything else (PAYMENT_USER_DROPPED_WEBHOOK, refund and
   * subscription events, …) returns null and the route
   * acknowledges-and-ignores it.
   *
   * Idempotency key: the provider event id is derived from the event
   * type + the Cashfree PAYMENT id (`PAYMENT_SUCCESS_WEBHOOK:<cf id>`).
   * Cashfree PG webhooks carry no event id of their own, but the
   * payment id is unique per payment and identical across redeliveries
   * of the same event — so a duplicate delivery is recognised by the
   * event store and never double-activates.
   */
  static normalizeEvent(payload: Record<string, unknown>): NormalizedPaymentEvent | null {
    const eventType = String(payload.type ?? '');
    if (eventType !== 'PAYMENT_SUCCESS_WEBHOOK' && eventType !== 'PAYMENT_FAILED_WEBHOOK') {
      return null;
    }
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const order = (data.order ?? {}) as Record<string, unknown>;
    const payment = (data.payment ?? {}) as Record<string, unknown>;
    const orderId = String(order.order_id ?? '');
    const cfPaymentId = payment.cf_payment_id != null ? String(payment.cf_payment_id) : '';
    if (!orderId || !cfPaymentId) return null;
    const success = eventType === 'PAYMENT_SUCCESS_WEBHOOK';
    const eventTime = typeof payload.event_time === 'string' ? Date.parse(payload.event_time) : NaN;
    const occurredAt = Number.isNaN(eventTime) ? Date.now() : eventTime;
    const currencyRaw = String(payment.payment_currency ?? order.order_currency ?? '');
    return {
      provider: 'cashfree',
      providerEventId: `${eventType}:${cfPaymentId}`,
      providerSubscriptionId: orderId,
      type: success ? 'subscription_activated' : 'payment_failed',
      occurredAt,
      claimedStatus: success ? 'active' : null,
      amountMinor:
        typeof payment.payment_amount === 'number'
          ? Math.round(payment.payment_amount * 100)
          : null,
      currency: (currencyRaw === 'USD' ? 'USD' : currencyRaw === 'INR' ? 'INR' : null) as CurrencyCode | null,
    };
  }
}
