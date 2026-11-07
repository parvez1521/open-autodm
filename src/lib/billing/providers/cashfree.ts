/**
 * Phase 12 — Cashfree MOCK adapter. Same core interface where the verified
 * contract supports it; capability flags where it differs (see assessment).
 * No payment SDK dependency — hand-rolled only. NO real API calls.
 * Lifecycle from official docs (fetched 2026-11-06):
 * https://www.cashfree.com/docs/payments/subscription/create
 * Signature: current docs use x-webhook-signature = base64 HMAC-SHA256 of
 * `${timestamp}.${rawBody}`; legacy v1 used a sorted cf_* field hash. This
 * mock implements the current header scheme for real (timingSafeEqual).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingProvider, ProviderCapabilities, ProviderSubscriptionSnapshot } from '../provider';
import { mapStatus } from '../provider';
import type { SubscriptionStatus } from '../lifecycle';

export const CASHFREE_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  INITIALIZED: 'incomplete', BANK_APPROVAL_PENDING: 'incomplete',
  ACTIVE: 'active', ON_HOLD: 'past_due',
  PAUSED: 'paused', CUSTOMER_PAUSED: 'paused',
  COMPLETED: 'expired', CANCELLED: 'cancelled', CUSTOMER_CANCELLED: 'cancelled',
  EXPIRED: 'expired', LINK_EXPIRED: 'expired', CARD_EXPIRED: 'past_due',
};
export const CASHFREE_CAPABILITIES: ProviderCapabilities = {
  supportsUpiAutopay: true, supportsENach: true, supportsEmandate: true,
  supportsTrials: false, // no trial primitive verified in fetched Cashfree subscription docs — flagged, not assumed
  supportsPause: true, supportsCustomerPause: true, // customer can pause/cancel from UPI app per official FAQ
  supportsProration: false, // no proration documented; plan change = CHANGE_PLAN / cancel+recreate per docs
  supportsInPlacePlanChange: true, // via Manage Subscription CHANGE_PLAN (not supported for On-Demand)
  supportsInternationalCards: true, supportsRefundsViaApi: true,
  currencies: ['INR', 'USD'], settlementCurrency: 'INR',
  webhookSignatureScheme: 'base64 HMAC-SHA256 of `${x-webhook-timestamp}.${rawBody}` (current); legacy v1 sorted cf_* hash differs',
};
export class CashfreeMockProvider implements BillingProvider {
  readonly id = 'cashfree' as const;
  readonly capabilities = CASHFREE_CAPABILITIES;
  readonly statusMap = CASHFREE_STATUS_MAP;
  readonly transport = { subs: new Map<string, ProviderSubscriptionSnapshot & { raw: string }>(), failFetch: false };
  mapProviderStatus(raw: string): SubscriptionStatus { return mapStatus(this.statusMap, raw); }
  seedSubscription(snap: ProviderSubscriptionSnapshot & { raw: string }): void { this.transport.subs.set(snap.providerSubscriptionId, snap); }
  async createCustomer(input: { workspaceId: string; email: string }) { return { providerCustomerId: `cf_cust_mock_${input.workspaceId}`, email: input.email }; }
  async createSubscriptionCheckout(input: { providerCustomerId: string; currency: 'INR' | 'USD'; amountMinor: number }) {
    const id = `CF_SUB_mock_${this.transport.subs.size + 1}`;
    const snap = { providerSubscriptionId: id, providerStatusRaw: 'INITIALIZED', status: 'incomplete' as SubscriptionStatus, currency: input.currency, amountMinor: input.amountMinor, currentPeriodEnd: null, raw: 'INITIALIZED' };
    this.transport.subs.set(id, snap);
    return { providerSubscriptionId: id, checkoutUrl: `https://mock.invalid/cashfree/checkout/${id}`, status: snap.status, currency: input.currency, amountMinor: input.amountMinor };
  }
  async fetchSubscription(id: string): Promise<ProviderSubscriptionSnapshot> {
    if (this.transport.failFetch) throw new Error('provider timeout (mock)');
    const s = this.transport.subs.get(id); if (!s) throw new Error(`Cashfree subscription not found (mock): ${id}`);
    return { providerSubscriptionId: s.providerSubscriptionId, providerStatusRaw: s.providerStatusRaw, status: s.status, currency: s.currency, amountMinor: s.amountMinor, currentPeriodEnd: s.currentPeriodEnd };
  }
  verifyWebhookSignature(rawBody: string, signature: string, secret: string, timestamp?: string): boolean {
    if (!secret || !signature) return false;
    const data = timestamp ? `${timestamp}.${rawBody}` : rawBody;
    const expected = createHmac('sha256', secret).update(data).digest('base64');
    const a = Buffer.from(expected); const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async cancelSubscription(id: string) { return this.mutate(id, 'CANCELLED'); }
  async pauseSubscription(id: string) { return this.mutate(id, 'PAUSED'); }
  async resumeSubscription(id: string) { return this.mutate(id, 'ACTIVE'); }
  private async mutate(id: string, raw: string) { const s = await this.fetchSubscription(id); const next = { ...s, providerStatusRaw: raw, status: this.mapProviderStatus(raw) }; this.transport.subs.set(id, { ...next, raw }); return next; }
  async fetchPaymentStatus(id: string) { return { providerPaymentId: id, status: 'unknown' as const, amountMinor: 0, currency: 'INR' as const }; }
  async reconcileEvents(id: string) { return this.fetchSubscription(id); }
  static normalizeEvent(payload: Record<string, unknown>): import('../events').NormalizedPaymentEvent | null {
    const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
    const eventType = String(payload.type ?? data.cf_event ?? '');
    const subId = String(data.subscription_id ?? data.cf_subscriptionId ?? ''); if (!subId) return null;
    const rawStatus = String(data.subscription_status ?? data.cf_status ?? '');
    let claimed: SubscriptionStatus | null = null; try { claimed = rawStatus ? mapStatus(CASHFREE_STATUS_MAP, rawStatus) : null; } catch { claimed = null; }
    let type: import('../events').NormalizedEventType = 'unknown';
    if (eventType.includes('PAYMENT_SUCCESS') || eventType === 'SUBSCRIPTION_NEW_PAYMENT') { type = 'subscription_charged'; claimed = claimed ?? 'active'; }
    else if (eventType.includes('PAYMENT_FAILED') || eventType.includes('DECLINED')) { type = 'payment_failed'; claimed = 'past_due'; }
    else if (eventType.includes('AUTH_STATUS')) { type = 'subscription_activated'; }
    else if (eventType.includes('STATUS_CHANGE') || eventType === 'SUBSCRIPTION_STATUS_CHANGE') { type = 'subscription_updated'; }
    const ts = String(payload.event_time ?? data.event_time ?? '');
    const occurredAt = ts ? Date.parse(ts) || Date.now() : Date.now();
    const eventId = String(payload.event_id ?? data.cf_event_id ?? `cf_evt_${eventType}_${subId}_${occurredAt}`);
    return { provider: 'cashfree', providerEventId: eventId, providerSubscriptionId: subId, type, occurredAt, claimedStatus: claimed, amountMinor: null, currency: null };
  }
}
export function signCashfreePayload(rawBody: string, secret: string, timestamp: string): string { return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('base64'); }
