/**
 * Phase 12 — Razorpay MOCK adapter (sandbox-ready shape, in-memory fake
 * transport). NO real Razorpay API calls are made. Webhook signature
 * verification is implemented for real: HMAC-SHA256 hex over the exact
 * raw body, compared with crypto.timingSafeEqual.
 * Status mapping from official docs (fetched 2026-11-06):
 * https://razorpay.com/docs/payments/subscriptions/states
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingProvider, ProviderCapabilities, ProviderSubscriptionSnapshot } from '../provider';
import { mapStatus } from '../provider';
import type { SubscriptionStatus } from '../lifecycle';

export const RAZORPAY_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  created: 'incomplete',
  authenticated: 'trialing', // mandate authenticated; trial/auth phase before first full charge — see assessment doc caveat
  active: 'active',
  pending: 'past_due', // charge failed, provider retries periodically
  halted: 'past_due', // retries exhausted; recoverable via new card/manual charge — NOT terminal in our model
  paused: 'paused',
  cancelled: 'cancelled',
  expired: 'expired',
  completed: 'expired', // end of lifecycle per plan end_date
};
export const RAZORPAY_CAPABILITIES: ProviderCapabilities = {
  supportsUpiAutopay: true, supportsENach: true, supportsEmandate: true,
  supportsTrials: true, supportsPause: true, supportsCustomerPause: false,
  supportsProration: true, // eligible card flows only — see assessment
  supportsInPlacePlanChange: true, // cards only; UPI/eMandate do NOT support in-place updates per official docs
  supportsInternationalCards: true, supportsRefundsViaApi: true,
  currencies: ['INR', 'USD'], settlementCurrency: 'INR',
  webhookSignatureScheme: 'HMAC-SHA256 hex over exact raw body, header x-razorpay-signature',
};
export interface MockTransport { subs: Map<string, ProviderSubscriptionSnapshot & { raw: string }>; failFetch: boolean; }
export function createMockTransport(): MockTransport { return { subs: new Map(), failFetch: false }; }

export class RazorpayMockProvider implements BillingProvider {
  readonly id = 'razorpay' as const;
  readonly capabilities = RAZORPAY_CAPABILITIES;
  readonly statusMap = RAZORPAY_STATUS_MAP;
  constructor(readonly transport: MockTransport = createMockTransport()) {}
  mapProviderStatus(raw: string): SubscriptionStatus { return mapStatus(this.statusMap, raw); }
  seedSubscription(snap: ProviderSubscriptionSnapshot & { raw: string }): void { this.transport.subs.set(snap.providerSubscriptionId, snap); }
  async createCustomer(input: { workspaceId: string; email: string }) { return { providerCustomerId: `cust_mock_${input.workspaceId}`, email: input.email }; }
  async createSubscriptionCheckout(input: { providerCustomerId: string; currency: 'INR' | 'USD'; amountMinor: number }) {
    const id = `sub_mock_rzp_${this.transport.subs.size + 1}`;
    const snap = { providerSubscriptionId: id, providerStatusRaw: 'created', status: 'incomplete' as SubscriptionStatus, currency: input.currency, amountMinor: input.amountMinor, currentPeriodEnd: null, raw: 'created' };
    this.transport.subs.set(id, snap);
    return { providerSubscriptionId: id, checkoutUrl: `https://mock.invalid/razorpay/checkout/${id}`, status: snap.status, currency: input.currency, amountMinor: input.amountMinor };
  }
  async fetchSubscription(id: string): Promise<ProviderSubscriptionSnapshot> {
    if (this.transport.failFetch) throw new Error('provider timeout (mock)');
    const s = this.transport.subs.get(id); if (!s) throw new Error(`Razorpay subscription not found (mock): ${id}`);
    return { providerSubscriptionId: s.providerSubscriptionId, providerStatusRaw: s.providerStatusRaw, status: s.status, currency: s.currency, amountMinor: s.amountMinor, currentPeriodEnd: s.currentPeriodEnd };
  }
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
    if (!secret || !signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected); const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async cancelSubscription(id: string) { return this.mutate(id, 'cancelled'); }
  async pauseSubscription(id: string) { return this.mutate(id, 'paused'); }
  async resumeSubscription(id: string) { return this.mutate(id, 'active'); }
  private async mutate(id: string, raw: string) { const s = await this.fetchSubscription(id); const next = { ...s, providerStatusRaw: raw, status: this.mapProviderStatus(raw) }; this.transport.subs.set(id, { ...next, raw }); return next; }
  async fetchPaymentStatus(id: string) { return { providerPaymentId: id, status: 'unknown' as const, amountMinor: 0, currency: 'INR' as const }; }
  async reconcileEvents(id: string) { return this.fetchSubscription(id); }
  /** Normalize a Razorpay-shaped webhook payload (already JSON-parsed AFTER signature verification). */
  static normalizeEvent(payload: Record<string, unknown>): import('../events').NormalizedPaymentEvent | null {
    const event = String(payload.event ?? '');
    const sub = (payload.payload as Record<string, unknown> | undefined)?.subscription as Record<string, unknown> | undefined;
    const entity = (sub?.entity ?? {}) as Record<string, unknown>;
    const id = String(entity.id ?? ''); if (!id) return null;
    const typeMap: Record<string, import('../events').NormalizedEventType> = {
      'subscription.activated': 'subscription_activated', 'subscription.charged': 'subscription_charged',
      'subscription.pending': 'payment_failed', 'subscription.halted': 'payment_failed',
      'subscription.cancelled': 'subscription_cancelled', 'subscription.paused': 'subscription_paused',
      'subscription.resumed': 'subscription_activated', 'subscription.completed': 'subscription_expired',
      'subscription.authenticated': 'subscription_activated', 'subscription.updated': 'subscription_updated',
      'payment.failed': 'payment_failed',
    };
    const rawStatus = String(entity.status ?? '');
    let claimed: SubscriptionStatus | null = null; try { claimed = rawStatus ? mapStatus(RAZORPAY_STATUS_MAP, rawStatus) : null; } catch { claimed = null; }
    if (event === 'subscription.pending' || event === 'subscription.halted') claimed = 'past_due';
    if (event === 'subscription.charged') claimed = 'active';
    return { provider: 'razorpay', providerEventId: String(payload.id ?? `rzp_evt_${event}_${id}_${String(payload.created_at ?? '')}`), providerSubscriptionId: id, type: typeMap[event] ?? 'unknown', occurredAt: Number(payload.created_at ?? 0) * 1000 || Date.now(), claimedStatus: claimed, amountMinor: null, currency: null };
  }
}
export function signRazorpayPayload(rawBody: string, secret: string): string { return createHmac('sha256', secret).update(rawBody).digest('hex'); }
