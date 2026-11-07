import { describe, it, expect } from 'vitest';
import type { BillingProvider } from '@/lib/billing/provider';
import { RazorpayMockProvider, RAZORPAY_STATUS_MAP } from '@/lib/billing/providers/razorpay';
import { CashfreeMockProvider, CASHFREE_STATUS_MAP } from '@/lib/billing/providers/cashfree';
import { StripeDisabledProvider } from '@/lib/billing/providers/stripe';
import { TEST_RAZORPAY_SECRET, TEST_CASHFREE_SECRET, TEST_CF_TIMESTAMP, razorpayEvent, cashfreeEvent } from './fixtures/payment-events';

describe('billing providers (mock adapters)', () => {
  it('razorpay status mapping follows the documented states', () => {
    expect(RAZORPAY_STATUS_MAP.created).toBe('incomplete');
    expect(RAZORPAY_STATUS_MAP.active).toBe('active');
    expect(RAZORPAY_STATUS_MAP.pending).toBe('past_due');
    expect(RAZORPAY_STATUS_MAP.halted).toBe('past_due');
    expect(RAZORPAY_STATUS_MAP.paused).toBe('paused');
    expect(RAZORPAY_STATUS_MAP.cancelled).toBe('cancelled');
    expect(RAZORPAY_STATUS_MAP.expired).toBe('expired');
    expect(RAZORPAY_STATUS_MAP.completed).toBe('expired');
  });
  it('cashfree status mapping follows the documented lifecycle', () => {
    expect(CASHFREE_STATUS_MAP.INITIALIZED).toBe('incomplete');
    expect(CASHFREE_STATUS_MAP.ACTIVE).toBe('active');
    expect(CASHFREE_STATUS_MAP.ON_HOLD).toBe('past_due');
    expect(CASHFREE_STATUS_MAP.PAUSED).toBe('paused');
    expect(CASHFREE_STATUS_MAP.CUSTOMER_PAUSED).toBe('paused');
    expect(CASHFREE_STATUS_MAP.CUSTOMER_CANCELLED).toBe('cancelled');
    expect(CASHFREE_STATUS_MAP.CARD_EXPIRED).toBe('past_due');
    expect(CASHFREE_STATUS_MAP.LINK_EXPIRED).toBe('expired');
  });
  it('capabilities differ explicitly between providers (never pretended identical)', () => {
    const rzp = new RazorpayMockProvider(); const cf = new CashfreeMockProvider();
    expect(rzp.capabilities.supportsUpiAutopay).toBe(true); expect(cf.capabilities.supportsUpiAutopay).toBe(true);
    expect(rzp.capabilities.supportsTrials).toBe(true); expect(cf.capabilities.supportsTrials).toBe(false);
    expect(rzp.capabilities.supportsProration).toBe(true); expect(cf.capabilities.supportsProration).toBe(false);
    expect(cf.capabilities.supportsCustomerPause).toBe(true); expect(rzp.capabilities.supportsCustomerPause).toBe(false);
    expect(rzp.capabilities.settlementCurrency).toBe('INR'); expect(cf.capabilities.settlementCurrency).toBe('INR');
    expect(rzp.capabilities.webhookSignatureScheme).not.toBe(cf.capabilities.webhookSignatureScheme);
  });
  it('razorpay webhook signature verifies for real (HMAC-SHA256, timing-safe)', () => {
    const p = new RazorpayMockProvider();
    const fx = razorpayEvent({ eventId: 'e1', event: 'subscription.activated', subscriptionId: 'sub_1', status: 'active', createdAtSec: 1730000000 });
    expect(p.verifyWebhookSignature(fx.rawBody, fx.signature, TEST_RAZORPAY_SECRET)).toBe(true);
    expect(p.verifyWebhookSignature(fx.rawBody, fx.signature, 'wrong-secret')).toBe(false);
    expect(p.verifyWebhookSignature(fx.rawBody + ' ', fx.signature, TEST_RAZORPAY_SECRET)).toBe(false);
    expect(p.verifyWebhookSignature(fx.rawBody, '', TEST_RAZORPAY_SECRET)).toBe(false);
  });
  it('cashfree webhook signature verifies (timestamp-bound HMAC)', () => {
    const p = new CashfreeMockProvider();
    const fx = cashfreeEvent({ eventId: 'e1', type: 'SUBSCRIPTION_PAYMENT_SUCCESS', subscriptionId: 'CF1', status: 'ACTIVE', eventTimeIso: '2026-11-06T00:00:00Z' });
    expect(p.verifyWebhookSignature(fx.rawBody, fx.signature, TEST_CASHFREE_SECRET, TEST_CF_TIMESTAMP)).toBe(true);
    expect(p.verifyWebhookSignature(fx.rawBody, fx.signature, TEST_CASHFREE_SECRET, '9999')).toBe(false);
    expect(p.verifyWebhookSignature(fx.rawBody, fx.signature, 'wrong', TEST_CF_TIMESTAMP)).toBe(false);
  });
  it('mock adapters create + fetch + cancel without any network', async () => {
    const p = new RazorpayMockProvider();
    // Phase 14 hygiene fix: the mock adapters declare a narrower checkout
    // input than the BillingProvider contract (they ignore workspaceId /
    // planId). Calling through the interface type checks the call against
    // the contract the test intends to exercise — same runtime objects,
    // same arguments, no behaviour change.
    const pContract: BillingProvider = p;
    const co = await pContract.createSubscriptionCheckout({ workspaceId: 'ws1', providerCustomerId: 'c1', planId: 'starter', currency: 'INR', amountMinor: 49900 });
    expect(co.status).toBe('incomplete'); expect(co.checkoutUrl).toContain('mock.invalid');
    const cancelled = await p.cancelSubscription(co.providerSubscriptionId);
    expect(cancelled.status).toBe('cancelled');
    const cf = new CashfreeMockProvider();
    const cfContract: BillingProvider = cf;
    const co2 = await cfContract.createSubscriptionCheckout({ workspaceId: 'ws1', providerCustomerId: 'c1', planId: 'starter', currency: 'INR', amountMinor: 49900 });
    expect((await cf.pauseSubscription(co2.providerSubscriptionId)).status).toBe('paused');
    expect((await cf.resumeSubscription(co2.providerSubscriptionId)).status).toBe('active');
  });
  it('stripe is disabled: every method throws provider-disabled', async () => {
    // Phase 14 hygiene fix: StripeDisabledProvider implements its methods
    // as zero-argument throwing stubs, so calling through the class type
    // rejects the (contract-correct) arguments. Typing the stub as the
    // BillingProvider interface it implements checks the calls against
    // the contract — same stub, same 'provider-disabled' throws.
    const s: BillingProvider = new StripeDisabledProvider();
    expect(() => s.verifyWebhookSignature('x', 'y', 'z')).toThrow('provider-disabled');
    await expect(s.fetchSubscription('sub_x')).rejects.toThrow('provider-disabled');
    await expect(s.createCustomer({ workspaceId: 'w', email: 'a@b.c' })).rejects.toThrow('provider-disabled');
  });
  it('unmapped provider statuses throw instead of guessing', () => {
    expect(() => new RazorpayMockProvider().mapProviderStatus('some_new_status')).toThrow('Unmapped provider status');
  });
});
