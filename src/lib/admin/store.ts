/**
 * Phase 14 — in-memory admin data store over the Phase 12/13 billing +
 * tenancy model, plus the synthetic seed used by the (admin) UI
 * prototype and the tests. No database, no network, no real customers:
 * every record here is synthetic. In production shape this store is
 * replaced by service-role queries against workspaces / subscriptions /
 * billing_events / payment_attempts / usage_counters (…000024–000028)
 * and the Phase 14 tables in …000029.
 */
import type {
  InternalCancellationRequest,
  InternalInvoiceRecord,
  InternalPaymentEventRecord,
  InternalRefundRecord,
  InternalSubscriptionRecord,
  InternalUsageRecord,
  InternalWorkspaceRecord,
} from './types';

export class InMemoryAdminStore {
  readonly workspaces = new Map<string, InternalWorkspaceRecord>();
  readonly subscriptions = new Map<string, InternalSubscriptionRecord>(); // by subscriptionId
  readonly invoices: InternalInvoiceRecord[] = [];
  readonly paymentEvents: InternalPaymentEventRecord[] = [];
  readonly usage: InternalUsageRecord[] = [];
  readonly refunds: InternalRefundRecord[] = [];
  readonly cancellationRequests: InternalCancellationRequest[] = [];

  addWorkspace(r: InternalWorkspaceRecord): void {
    this.workspaces.set(r.workspaceId, r);
  }
  addSubscription(r: InternalSubscriptionRecord): void {
    this.subscriptions.set(r.subscriptionId, r);
  }
  subscriptionForWorkspace(workspaceId: string): InternalSubscriptionRecord | null {
    for (const s of this.subscriptions.values()) if (s.workspaceId === workspaceId) return s;
    return null;
  }
  addInvoice(r: InternalInvoiceRecord): void {
    this.invoices.push(r);
  }
  addPaymentEvent(r: InternalPaymentEventRecord): void {
    this.paymentEvents.push(r);
  }
  addUsage(r: InternalUsageRecord): void {
    this.usage.push(r);
  }
  addRefund(r: InternalRefundRecord): void {
    this.refunds.push(r);
  }
  addCancellationRequest(r: InternalCancellationRequest): void {
    this.cancellationRequests.push(r);
  }
}

function profile(email: string, legalName: string, country: string): InternalWorkspaceRecord['billingProfile'] {
  return {
    billingEmail: email,
    legalName,
    country,
    taxId: null,
    providerCustomerId: null,
    providerApiSecret: null,
    providerWebhookSecret: null,
  };
}

/** Synthetic seed — four fake workspaces exercising every admin list. */
export function createSyntheticAdminStore(): InMemoryAdminStore {
  const store = new InMemoryAdminStore();
  store.addWorkspace({
    workspaceId: 'ws-alpha', name: 'Alpha Creators (synthetic)', status: 'active',
    ownerUserId: 'user-owner-alpha', ownerEmail: 'owner@alpha.example', createdAt: '2026-09-02T10:00:00.000Z',
    billingProfile: profile('billing@alpha.example', 'Alpha Creators LLP', 'IN'),
  });
  store.addWorkspace({
    workspaceId: 'ws-beta', name: 'Beta Studio (synthetic)', status: 'active',
    ownerUserId: 'user-owner-beta', ownerEmail: 'owner@beta.example', createdAt: '2026-10-11T10:00:00.000Z',
    billingProfile: profile('billing@beta.example', 'Beta Studio Pvt Ltd', 'IN'),
  });
  store.addWorkspace({
    workspaceId: 'ws-gamma', name: 'Gamma Media (synthetic)', status: 'active',
    ownerUserId: 'user-owner-gamma', ownerEmail: 'owner@gamma.example', createdAt: '2026-08-19T10:00:00.000Z',
    billingProfile: profile('billing@gamma.example', 'Gamma Media LLC', 'US'),
  });
  store.addWorkspace({
    workspaceId: 'ws-delta', name: 'Delta Agency (synthetic)', status: 'active',
    ownerUserId: 'user-owner-delta', ownerEmail: 'owner@delta.example', createdAt: '2026-07-25T10:00:00.000Z',
    billingProfile: profile('billing@delta.example', 'Delta Agency Inc', 'US'),
  });

  store.addSubscription({
    subscriptionId: 'sub-alpha', workspaceId: 'ws-alpha', planId: 'starter', status: 'active',
    provider: 'razorpay', providerSubscriptionId: 'sub_mock_rzp_alpha', providerCustomerId: 'cust_mock_ws-alpha',
    currency: 'INR', amountMinor: 49900, billingPeriod: 'monthly',
    currentPeriodStart: '2026-11-01T00:00:00.000Z', currentPeriodEnd: '2026-12-01T00:00:00.000Z',
    trialEndsAt: '2026-10-16T00:00:00.000Z', hadTrial: true, cancelAtPeriodEnd: false,
    cancellationRequestedAt: null, pastDueSince: null,
    createdAt: '2026-10-02T10:00:00.000Z', cancelledAt: null, entitlementOverrides: [],
  });
  store.addSubscription({
    subscriptionId: 'sub-beta', workspaceId: 'ws-beta', planId: 'creator-pro', status: 'trialing',
    provider: 'razorpay', providerSubscriptionId: 'sub_mock_rzp_beta', providerCustomerId: 'cust_mock_ws-beta',
    currency: 'INR', amountMinor: 958800, billingPeriod: 'annual',
    currentPeriodStart: '2026-11-03T00:00:00.000Z', currentPeriodEnd: '2026-11-17T00:00:00.000Z',
    trialEndsAt: '2026-11-17T00:00:00.000Z', hadTrial: true, cancelAtPeriodEnd: false,
    cancellationRequestedAt: null, pastDueSince: null,
    createdAt: '2026-11-03T10:00:00.000Z', cancelledAt: null, entitlementOverrides: [],
  });
  store.addSubscription({
    subscriptionId: 'sub-gamma', workspaceId: 'ws-gamma', planId: 'starter', status: 'past_due',
    provider: 'cashfree', providerSubscriptionId: 'CF_SUB_mock_gamma', providerCustomerId: 'cf_cust_mock_ws-gamma',
    currency: 'USD', amountMinor: 900, billingPeriod: 'monthly',
    currentPeriodStart: '2026-10-20T00:00:00.000Z', currentPeriodEnd: '2026-11-20T00:00:00.000Z',
    trialEndsAt: null, hadTrial: false, cancelAtPeriodEnd: false,
    cancellationRequestedAt: null, pastDueSince: '2026-10-28T00:00:00.000Z',
    createdAt: '2026-09-20T10:00:00.000Z', cancelledAt: null, entitlementOverrides: [],
  });
  store.addSubscription({
    subscriptionId: 'sub-delta', workspaceId: 'ws-delta', planId: 'agency', status: 'cancelled',
    provider: 'razorpay', providerSubscriptionId: 'sub_mock_rzp_delta', providerCustomerId: 'cust_mock_ws-delta',
    currency: 'USD', amountMinor: 5900, billingPeriod: 'monthly',
    currentPeriodStart: '2026-10-01T00:00:00.000Z', currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    trialEndsAt: null, hadTrial: true, cancelAtPeriodEnd: true,
    cancellationRequestedAt: '2026-10-24T09:00:00.000Z', pastDueSince: null,
    createdAt: '2026-08-01T10:00:00.000Z', cancelledAt: '2026-11-01T00:00:00.000Z', entitlementOverrides: [],
  });

  store.addInvoice({ invoiceId: 'inv-alpha-1', workspaceId: 'ws-alpha', subscriptionId: 'sub-alpha', amountMinor: 49900, currency: 'INR', status: 'paid', issuedAt: '2026-11-01T00:00:00.000Z', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z', providerInvoiceRef: null });
  store.addInvoice({ invoiceId: 'inv-gamma-1', workspaceId: 'ws-gamma', subscriptionId: 'sub-gamma', amountMinor: 900, currency: 'USD', status: 'failed', issuedAt: '2026-10-28T00:00:00.000Z', periodStart: '2026-10-20T00:00:00.000Z', periodEnd: '2026-11-20T00:00:00.000Z', providerInvoiceRef: null });

  store.addPaymentEvent({ eventId: 'evt-1', provider: 'razorpay', providerEventId: 'rzp_evt_alpha_1', workspaceId: 'ws-alpha', subscriptionId: 'sub-alpha', type: 'subscription_charged', outcome: 'applied', amountMinor: 49900, currency: 'INR', occurredAt: '2026-11-01T00:05:00.000Z' });
  store.addPaymentEvent({ eventId: 'evt-2', provider: 'cashfree', providerEventId: 'cf_evt_gamma_1', workspaceId: 'ws-gamma', subscriptionId: 'sub-gamma', type: 'payment_failed', outcome: 'applied', amountMinor: 900, currency: 'USD', occurredAt: '2026-10-28T00:05:00.000Z' });

  store.addUsage({ workspaceId: 'ws-alpha', periodStart: '2026-11-01', dmsThisMonth: 812, contactsThisMonth: 640, aiDraftingThisMonth: 41, scriptWriterThisMonth: 12, followUpsThisMonth: 105, instagramAccounts: 1, activeAutomations: 6, teamSeatsUsed: 1 });
  store.addUsage({ workspaceId: 'ws-gamma', periodStart: '2026-11-01', dmsThisMonth: 1900, contactsThisMonth: 1750, aiDraftingThisMonth: 88, scriptWriterThisMonth: 44, followUpsThisMonth: 480, instagramAccounts: 1, activeAutomations: 9, teamSeatsUsed: 1 });

  store.addCancellationRequest({ requestId: 'cx-delta-1', workspaceId: 'ws-delta', requestedAt: '2026-10-24T09:00:00.000Z', effectiveAt: '2026-11-01T00:00:00.000Z', reasonCategory: 'price', status: 'completed' });
  return store;
}
