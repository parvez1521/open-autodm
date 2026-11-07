import { describe, it, expect } from 'vitest';
import { RazorpayMockProvider } from '@/lib/billing/providers/razorpay';
import { CashfreeMockProvider } from '@/lib/billing/providers/cashfree';
import { InMemoryBillingEventStore } from '@/lib/billing/events';
import { StaticSecretsProvider } from '@/lib/billing/provider';
import { processBillingWebhook, normalizeForProvider } from '@/lib/billing/webhook';
import type { SubscriptionStatus } from '@/lib/billing/lifecycle';
import { TEST_RAZORPAY_SECRET, TEST_CASHFREE_SECRET, razorpayEvent, cashfreeEvent } from './fixtures/payment-events';

function setup(localStatus: SubscriptionStatus, serverRaw: string, serverStatus: SubscriptionStatus, lastEventAt = 0) {
  const provider = new RazorpayMockProvider();
  provider.seedSubscription({ providerSubscriptionId: 'sub_1', providerStatusRaw: serverRaw, status: serverStatus, currency: 'INR', amountMinor: 49900, currentPeriodEnd: null, raw: serverRaw });
  const store = new InMemoryBillingEventStore();
  store.ensureSubscription({ providerSubscriptionId: 'sub_1', provider: 'razorpay', workspaceId: 'ws1', status: localStatus, currency: 'INR', lastEventAt, version: 0 });
  const secrets = new StaticSecretsProvider({ razorpay: TEST_RAZORPAY_SECRET });
  const deps = { provider, store, secrets, normalize: (p: Record<string, unknown>) => normalizeForProvider('razorpay', p) };
  return { provider, store, deps };
}
const act = (id: string, sec: number) => razorpayEvent({ eventId: id, event: 'subscription.activated', subscriptionId: 'sub_1', status: 'active', createdAtSec: sec });

describe('billing webhook processing', () => {
  it('duplicate success webhook is applied once', async () => {
    const { store, deps } = setup('incomplete', 'active', 'active');
    const fx = act('evt_dup', 2000);
    const r1 = await processBillingWebhook(deps, fx);
    expect(r1.outcome).toBe('applied'); expect(r1.subscriptionStatus).toBe('active'); expect(r1.entitlementGranted).toBe(true);
    const v = store.getSubscription('sub_1')!.version;
    const r2 = await processBillingWebhook(deps, fx);
    expect(r2.outcome).toBe('duplicate'); expect(store.getSubscription('sub_1')!.version).toBe(v);
    expect(store.logs().filter((l) => l.providerEventId === 'evt_dup')).toHaveLength(1);
  });
  it('payment failure webhook moves active → past_due (no entitlement)', async () => {
    const { deps } = setup('active', 'pending', 'past_due');
    const fx = razorpayEvent({ eventId: 'evt_fail', event: 'subscription.pending', subscriptionId: 'sub_1', status: 'pending', createdAtSec: 3000 });
    const r = await processBillingWebhook(deps, fx);
    expect(r.outcome).toBe('applied'); expect(r.subscriptionStatus).toBe('past_due'); expect(r.entitlementGranted).toBe(false);
  });
  it('delayed event does not move state backwards', async () => {
    const { store, deps } = setup('active', 'active', 'active', 5000);
    const r = await processBillingWebhook(deps, act('evt_delayed', 3));
    expect(r.outcome).toBe('stale'); expect(store.getSubscription('sub_1')!.status).toBe('active');
  });
  it('old event after cancellation must not resurrect the subscription', async () => {
    const { store, deps } = setup('cancelled', 'active', 'active', 9000);
    const r = await processBillingWebhook(deps, act('evt_old', 4));
    expect(r.subscriptionStatus).toBe('cancelled'); expect(r.entitlementGranted).toBe(false);
    expect(store.getSubscription('sub_1')!.status).toBe('cancelled');
  });
  it('a fresh activation claim against a cancelled record is rejected as illegal transition', async () => {
    const { deps } = setup('cancelled', 'active', 'active', 1000);
    const r = await processBillingWebhook(deps, act('evt_fresh', 5000));
    expect(r.outcome).toBe('illegal-transition'); expect(r.subscriptionStatus).toBe('cancelled');
  });
  it('invalid signature is rejected with no state change', async () => {
    const { store, deps } = setup('incomplete', 'active', 'active');
    const fx = act('evt_bad', 2000);
    const r = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: 'deadbeef' });
    expect(r.outcome).toBe('invalid-signature'); expect(store.getSubscription('sub_1')!.status).toBe('incomplete');
    expect(store.hasEvent('evt_bad')).toBe(false);
  });
  it('missing secret fails closed', async () => {
    const { provider, store } = setup('incomplete', 'active', 'active');
    const deps = { provider, store, secrets: new StaticSecretsProvider({}), normalize: (p: Record<string, unknown>) => normalizeForProvider('razorpay', p) };
    const r = await processBillingWebhook(deps, act('evt_nosecret', 2000));
    expect(r.outcome).toBe('missing-secret'); expect(r.entitlementGranted).toBe(false);
    expect(store.getSubscription('sub_1')!.status).toBe('incomplete');
  });
  it('replay of an old event ID after a later cancellation is a duplicate, not a resurrection', async () => {
    const { provider, store, deps } = setup('incomplete', 'active', 'active');
    const fx = act('evt_replay', 2000);
    await processBillingWebhook(deps, fx);
    provider.seedSubscription({ providerSubscriptionId: 'sub_1', providerStatusRaw: 'cancelled', status: 'cancelled', currency: 'INR', amountMinor: 49900, currentPeriodEnd: null, raw: 'cancelled' });
    const cancelFx = razorpayEvent({ eventId: 'evt_cancel', event: 'subscription.cancelled', subscriptionId: 'sub_1', status: 'cancelled', createdAtSec: 4000 });
    const rc = await processBillingWebhook(deps, cancelFx);
    expect(rc.subscriptionStatus).toBe('cancelled');
    const rr = await processBillingWebhook(deps, fx);
    expect(rr.outcome).toBe('duplicate'); expect(store.getSubscription('sub_1')!.status).toBe('cancelled');
  });
  it('provider timeout on status verification grants no entitlement', async () => {
    const { provider, store, deps } = setup('incomplete', 'active', 'active');
    provider.transport.failFetch = true;
    const r = await processBillingWebhook(deps, act('evt_timeout', 2000));
    expect(r.outcome).toBe('verification-unavailable'); expect(r.entitlementGranted).toBe(false);
    expect(store.getSubscription('sub_1')!.status).toBe('incomplete');
    expect(store.hasEvent('evt_timeout')).toBe(false); // not consumed — retryable
  });
  it('API response mismatch: webhook claims active, server fetch wins', async () => {
    const { deps } = setup('active', 'pending', 'past_due');
    const fx = act('evt_mismatch', 6000); // claims active via event+status
    const r = await processBillingWebhook(deps, fx);
    expect(r.subscriptionStatus).toBe('past_due'); expect(r.entitlementGranted).toBe(false);
  });
  it('provider outage: no free paid access when verification is unavailable (cashfree path)', async () => {
    const provider = new CashfreeMockProvider();
    provider.seedSubscription({ providerSubscriptionId: 'CF1', providerStatusRaw: 'ACTIVE', status: 'active', currency: 'INR', amountMinor: 49900, currentPeriodEnd: null, raw: 'ACTIVE' });
    provider.transport.failFetch = true;
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'CF1', provider: 'cashfree', workspaceId: 'ws1', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });
    const fx = cashfreeEvent({ eventId: 'cf_evt_outage', type: 'SUBSCRIPTION_PAYMENT_SUCCESS', subscriptionId: 'CF1', status: 'ACTIVE', eventTimeIso: '2026-11-06T00:00:00Z' });
    const deps = { provider, store, secrets: new StaticSecretsProvider({ cashfree: TEST_CASHFREE_SECRET }), normalize: (p: Record<string, unknown>) => normalizeForProvider('cashfree', p), signatureTimestamp: fx.timestamp };
    const r = await processBillingWebhook(deps, fx);
    expect(r.outcome).toBe('verification-unavailable'); expect(r.entitlementGranted).toBe(false);
    expect(store.getSubscription('CF1')!.status).toBe('incomplete');
  });
  it('cashfree success webhook applies when server agrees', async () => {
    const provider = new CashfreeMockProvider();
    provider.seedSubscription({ providerSubscriptionId: 'CF1', providerStatusRaw: 'ACTIVE', status: 'active', currency: 'INR', amountMinor: 49900, currentPeriodEnd: null, raw: 'ACTIVE' });
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'CF1', provider: 'cashfree', workspaceId: 'ws1', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });
    const fx = cashfreeEvent({ eventId: 'cf_evt_ok', type: 'SUBSCRIPTION_PAYMENT_SUCCESS', subscriptionId: 'CF1', status: 'ACTIVE', eventTimeIso: '2026-11-06T00:00:00Z' });
    const deps = { provider, store, secrets: new StaticSecretsProvider({ cashfree: TEST_CASHFREE_SECRET }), normalize: (p: Record<string, unknown>) => normalizeForProvider('cashfree', p), signatureTimestamp: fx.timestamp };
    const r = await processBillingWebhook(deps, fx);
    expect(r.outcome).toBe('applied'); expect(r.subscriptionStatus).toBe('active'); expect(r.entitlementGranted).toBe(true);
    // sanitized logs carry no payload / secret material
    expect(JSON.stringify(store.logs())).not.toContain(TEST_CASHFREE_SECRET);
  });
});
