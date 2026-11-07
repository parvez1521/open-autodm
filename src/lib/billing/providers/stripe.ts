/** Phase 12 — Stripe DISABLED stub. India accounts are invite-only (official support pages, fetched 2026-11-06). Every method throws 'provider-disabled'. No adapter logic beyond this stub. */
import type { BillingProvider, ProviderCapabilities } from '../provider';
const fail = (): never => { throw new Error('provider-disabled'); };
const failAsync = async (): Promise<never> => { throw new Error('provider-disabled'); };
export const STRIPE_CAPABILITIES: ProviderCapabilities = {
  supportsUpiAutopay: false, supportsENach: false, supportsEmandate: false,
  supportsTrials: false, supportsPause: false, supportsCustomerPause: false,
  supportsProration: false, supportsInPlacePlanChange: false,
  supportsInternationalCards: false, supportsRefundsViaApi: false,
  currencies: [], settlementCurrency: 'INR', webhookSignatureScheme: 'disabled',
};
export class StripeDisabledProvider implements BillingProvider {
  readonly id = 'stripe' as const; readonly capabilities = STRIPE_CAPABILITIES; readonly statusMap = {} as const;
  mapProviderStatus = fail; verifyWebhookSignature = fail;
  createCustomer = failAsync; createSubscriptionCheckout = failAsync;
  fetchSubscription = failAsync; cancelSubscription = failAsync;
  fetchPaymentStatus = failAsync; reconcileEvents = failAsync;
}
