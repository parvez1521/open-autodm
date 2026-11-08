/**
 * Razorpay LIVE provider adapter — SaaS subscription wiring (2026-11-08).
 *
 * Implements the Phase 12 BillingProvider interface against Razorpay's
 * real REST API so the existing webhook core (src/lib/billing/webhook.ts,
 * processBillingWebhook) can process LIVE events unchanged:
 *
 *   - Signature verification delegates to verifyRazorpayWebhookSignature
 *     in ./razorpay.ts (HMAC-SHA-256 over the exact raw body, fail closed).
 *   - Server-side verification (the core's step 4 — "the server snapshot
 *     WINS over webhook claims") is fetchSubscription below: a signed
 *     webhook claim of "paid" is only ever believed after this adapter
 *     re-reads the order from Razorpay and finds it actually paid.
 *
 * ORDER MODEL — read this before re-using ids: this product sells via
 * one-time Razorpay ORDERS (checkout creates an order; see
 * src/app/api/billing/checkout/route.ts), not Razorpay Subscriptions.
 * The unit the webhook revolves around is therefore the ORDER, and
 * `providerSubscriptionId` throughout the Phase 12 core carries the
 * Razorpay ORDER id in this flow. The local binding of order →
 * workspace/plan/period lives in the billing_orders table
 * (migration …000035) and is resolved by the webhook route BEFORE the
 * core runs — never from payload claims.
 *
 * Capabilities are honest about the order model: no provider-side
 * trials (trials are OUR no-card flow, src/lib/billing/trial.ts), no
 * pause/resume, no in-place plan change, no proration. Methods the
 * order flow cannot express throw a typed UnsupportedRazorpayOperation
 * instead of pretending.
 *
 * Secrets rule: the key secret is used only to build the Basic-auth
 * header for server-side API reads. It is NEVER logged and NEVER
 * returned to clients.
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
  verifyRazorpayWebhookSignature,
  RazorpayApiError,
  type RazorpayConfig,
} from './razorpay';

export const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

/** Order-status → lifecycle mapping for the order model (explicit, auditable). */
export const RAZORPAY_ORDER_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  paid: 'active',
  created: 'incomplete',
  attempted: 'incomplete',
};

export const RAZORPAY_LIVE_CAPABILITIES: ProviderCapabilities = {
  supportsUpiAutopay: false, // orders, not autopay subscriptions
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
  webhookSignatureScheme: 'HMAC-SHA256 hex over exact raw body, header x-razorpay-signature',
};

export class UnsupportedRazorpayOperation extends Error {
  constructor(operation: string) {
    super(`Razorpay order-model adapter does not support: ${operation}`);
    this.name = 'UnsupportedRazorpayOperation';
  }
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface RazorpayOrderSnapshotRaw {
  id: string;
  status: string;
  amount: number;
  amountPaid: number;
  currency: string;
}

export class RazorpayLiveProvider implements BillingProvider {
  readonly id = 'razorpay' as const;
  readonly capabilities = RAZORPAY_LIVE_CAPABILITIES;
  readonly statusMap = RAZORPAY_ORDER_STATUS_MAP;

  constructor(
    private readonly config: RazorpayConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  mapProviderStatus(raw: string): SubscriptionStatus {
    return mapStatus(this.statusMap, raw);
  }

  private authHeader(): string {
    if (!this.config.configured || !this.config.keyId || !this.config.keySecret) {
      throw new Error('Razorpay is not configured: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing.');
    }
    return `Basic ${Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64')}`;
  }

  /** Read one order from Razorpay (server-side truth for the webhook core). */
  async fetchOrder(providerOrderId: string): Promise<RazorpayOrderSnapshotRaw> {
    const res = await this.fetchImpl(`${RAZORPAY_API_BASE}/orders/${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
      headers: { Authorization: this.authHeader() },
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (data?.error ?? {}) as { code?: string; description?: string };
      throw new RazorpayApiError(
        res.status,
        typeof err.code === 'string' ? err.code : null,
        typeof err.description === 'string' ? err.description : 'order fetch failed',
      );
    }
    const o = (data ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? providerOrderId),
      status: String(o.status ?? ''),
      amount: Number(o.amount ?? 0),
      amountPaid: Number(o.amount_paid ?? 0),
      currency: String(o.currency ?? 'INR'),
    };
  }

  /**
   * Phase 12 core step 4: re-read the order from Razorpay. An order is
   * 'active' ONLY when Razorpay itself reports it paid; anything else
   * (created / attempted / unknown raw status) resolves to 'incomplete'
   * so a webhook claim can never grant entitlement on its own.
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
      providerSubscriptionId: order.id,
      providerStatusRaw: order.status,
      status,
      currency: (order.currency === 'USD' ? 'USD' : 'INR') as CurrencyCode,
      amountMinor: status === 'active' ? order.amountPaid || order.amount : order.amount,
      currentPeriodEnd: null,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
    return verifyRazorpayWebhookSignature(rawBody, signature, secret);
  }

  // ── Operations the order model does not express ─────────────────────
  // Checkout creates orders directly (./razorpay.ts createRazorpayOrder);
  // there is no provider-side customer/subscription lifecycle to drive.

  async createCustomer(): Promise<never> {
    throw new UnsupportedRazorpayOperation('createCustomer (orders carry no provider customer)');
  }
  async createSubscriptionCheckout(): Promise<never> {
    throw new UnsupportedRazorpayOperation('createSubscriptionCheckout (use createRazorpayOrder)');
  }
  async cancelSubscription(): Promise<never> {
    throw new UnsupportedRazorpayOperation('cancelSubscription (orders cannot be cancelled)');
  }
  async fetchPaymentStatus(providerPaymentId: string) {
    const res = await this.fetchImpl(`${RAZORPAY_API_BASE}/payments/${encodeURIComponent(providerPaymentId)}`, {
      method: 'GET',
      headers: { Authorization: this.authHeader() },
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (data?.error ?? {}) as { code?: string; description?: string };
      throw new RazorpayApiError(
        res.status,
        typeof err.code === 'string' ? err.code : null,
        typeof err.description === 'string' ? err.description : 'payment fetch failed',
      );
    }
    const p = (data ?? {}) as Record<string, unknown>;
    const raw = String(p.status ?? '');
    const status = raw === 'captured' || raw === 'authorized'
      ? 'succeeded' as const
      : raw === 'failed' ? 'failed' as const : raw === 'created' ? 'pending' as const : 'unknown' as const;
    return {
      providerPaymentId: String(p.id ?? providerPaymentId),
      status,
      amountMinor: Number(p.amount ?? 0),
      currency: (String(p.currency ?? 'INR') === 'USD' ? 'USD' : 'INR') as CurrencyCode,
    };
  }
  async reconcileEvents(providerOrderId: string): Promise<ProviderSubscriptionSnapshot> {
    return this.fetchSubscription(providerOrderId);
  }

  /**
   * Normalize a LIVE Razorpay webhook payload (already signature-verified
   * by the core before this is trusted). Only order/payment events are
   * meaningful in the order model; everything else returns null and the
   * route acknowledges-and-ignores it.
   *
   * Idempotency key: the provider event id is derived from the event
   * name + the PAYMENT id (`payment.captured:pay_…`), which is unique
   * per payment and identical across Razorpay redeliveries of the same
   * event — so a duplicate delivery is recognised by the event store
   * and never double-activates. A payment also emits `order.paid`;
   * that is a second, distinct event whose lifecycle effect is a
   * same-state no-op once the first has activated the subscription.
   */
  static normalizeEvent(payload: Record<string, unknown>): NormalizedPaymentEvent | null {
    const event = String(payload.event ?? '');
    const body = (payload.payload ?? {}) as Record<string, unknown>;
    const payment = (body.payment as Record<string, unknown> | undefined)?.entity as Record<string, unknown> | undefined;
    const order = (body.order as Record<string, unknown> | undefined)?.entity as Record<string, unknown> | undefined;
    const occurredAt = Number(payload.created_at ?? 0) * 1000 || Date.now();

    if (event === 'payment.captured' || event === 'payment.failed') {
      const orderId = String(payment?.order_id ?? '');
      const paymentId = String(payment?.id ?? '');
      if (!orderId || !paymentId) return null;
      const captured = event === 'payment.captured';
      return {
        provider: 'razorpay',
        providerEventId: `${event}:${paymentId}`,
        providerSubscriptionId: orderId,
        type: captured ? 'subscription_activated' : 'payment_failed',
        occurredAt,
        claimedStatus: captured ? 'active' : null,
        amountMinor: typeof payment?.amount === 'number' ? payment.amount : null,
        currency: (payment?.currency === 'USD' ? 'USD' : payment?.currency === 'INR' ? 'INR' : null) as CurrencyCode | null,
      };
    }
    if (event === 'order.paid') {
      const orderId = String(order?.id ?? payment?.order_id ?? '');
      if (!orderId) return null;
      const paymentId = String(payment?.id ?? '');
      return {
        provider: 'razorpay',
        providerEventId: paymentId ? `${event}:${paymentId}` : `${event}:${orderId}:${String(payload.created_at ?? '')}`,
        providerSubscriptionId: orderId,
        type: 'subscription_activated',
        occurredAt,
        claimedStatus: 'active',
        amountMinor: typeof order?.amount_paid === 'number' ? order.amount_paid : null,
        currency: (order?.currency === 'USD' ? 'USD' : order?.currency === 'INR' ? 'INR' : null) as CurrencyCode | null,
      };
    }
    return null;
  }
}
