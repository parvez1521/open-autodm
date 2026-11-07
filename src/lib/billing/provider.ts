/**
 * Phase 12 — provider-agnostic billing core interface.
 * Differing provider semantics are explicit via ProviderCapabilities;
 * they are never pretended identical. Money is integer minor units;
 * currency is explicit and immutable per issued subscription.
 */
import type { CurrencyCode, PlanId } from './catalogue';
import type { SubscriptionStatus } from './lifecycle';

export type ProviderId = 'razorpay' | 'cashfree' | 'stripe';

export interface ProviderCapabilities {
  supportsUpiAutopay: boolean;
  supportsENach: boolean;
  supportsEmandate: boolean;
  supportsTrials: boolean;
  supportsPause: boolean;
  supportsCustomerPause: boolean;
  supportsProration: boolean;
  /** In-place plan change without cancelling + recreating. */
  supportsInPlacePlanChange: boolean;
  supportsInternationalCards: boolean;
  supportsRefundsViaApi: boolean;
  currencies: readonly CurrencyCode[];
  /** Currency funds settle in, regardless of presentment currency. */
  settlementCurrency: CurrencyCode;
  webhookSignatureScheme: string;
}

export interface ProviderCustomer { providerCustomerId: string; email: string; }
export interface CreateCustomerInput { workspaceId: string; email: string; name?: string; }
export interface CreateSubscriptionCheckoutInput {
  workspaceId: string; providerCustomerId: string; planId: PlanId;
  currency: CurrencyCode; amountMinor: number; trialDays?: number;
}
export interface SubscriptionCheckout { providerSubscriptionId: string; checkoutUrl: string; status: SubscriptionStatus; currency: CurrencyCode; amountMinor: number; }
export interface ProviderSubscriptionSnapshot {
  providerSubscriptionId: string; providerStatusRaw: string; status: SubscriptionStatus;
  currency: CurrencyCode; amountMinor: number; currentPeriodEnd: string | null;
}
export interface PaymentStatus { providerPaymentId: string; status: 'succeeded' | 'failed' | 'pending' | 'unknown'; amountMinor: number; currency: CurrencyCode; }

export interface SecretsProvider { getWebhookSecret(provider: ProviderId): string | null; getApiSecret?(provider: ProviderId): string | null; }
/** Test/static secrets provider — fixture secrets only, never real keys. */
export class StaticSecretsProvider implements SecretsProvider {
  constructor(private readonly secrets: Partial<Record<ProviderId, string>>) {}
  getWebhookSecret(p: ProviderId): string | null { return this.secrets[p] ?? null; }
  getApiSecret(p: ProviderId): string | null { return this.secrets[p] ?? null; }
}

export interface BillingProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Per-provider raw-status → lifecycle mapping table (explicit, auditable). */
  readonly statusMap: Readonly<Record<string, SubscriptionStatus>>;
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createSubscriptionCheckout(input: CreateSubscriptionCheckoutInput): Promise<SubscriptionCheckout>;
  fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>;
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean;
  cancelSubscription(providerSubscriptionId: string, opts?: { atPeriodEnd?: boolean }): Promise<ProviderSubscriptionSnapshot>;
  pauseSubscription?(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>;
  resumeSubscription?(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>;
  fetchPaymentStatus(providerPaymentId: string): Promise<PaymentStatus>;
  reconcileEvents(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>;
  mapProviderStatus(raw: string): SubscriptionStatus;
}
export function mapStatus(table: Readonly<Record<string, SubscriptionStatus>>, raw: string): SubscriptionStatus {
  const mapped = table[raw] ?? table[raw.toLowerCase()] ?? table[raw.toUpperCase()];
  if (!mapped) throw new Error(`Unmapped provider status: ${raw}`);
  return mapped;
}
