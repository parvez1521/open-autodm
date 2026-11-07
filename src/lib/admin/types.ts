/**
 * Phase 14 — platform-admin domain types.
 *
 * Two disjoint role systems live here and are NEVER merged:
 *  - Platform roles (`platform_admins`, Phase 13 migration …000025):
 *    'platform-admin' (full operations) and 'platform-support'
 *    (read-only operations). Held by OUR staff.
 *  - Workspace roles (`workspace_memberships`, …000024):
 *    'owner' | 'admin' | 'member'. Held by customers in THEIR workspace.
 *
 * A workspace 'owner' is not platform staff, and platform staff are not
 * workspace members. Each guard in ./service.ts checks exactly one
 * system; see invariant tests in tests/billing-admin.test.ts.
 *
 * INTERNAL records (below) may carry provider secret material because
 * they model the server-side rows. They must NEVER be returned to a
 * caller: every public method returns a DTO built by explicit field
 * picks in ./dto.ts (allowlist, never spread), so secret fields are
 * structurally absent from anything frontend-facing (invariant (d)).
 */
import type { CurrencyCode, PlanId } from '../billing/catalogue';
import type { SubscriptionStatus } from '../billing/lifecycle';
import type { ProviderId } from '../billing/provider';
import type { EntitlementDimension, UsageSnapshot } from '../entitlements/service';

export type PlatformRole = 'platform-admin' | 'platform-support' | 'none';
export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface ActorContext {
  userId: string;
  platformRole: PlatformRole;
  /** workspaceId → the actor's role in THAT workspace (customers only). */
  workspaceRoles: Readonly<Record<string, WorkspaceRole>>;
}

export type AdminErrorCode =
  | 'forbidden-not-platform-staff'
  | 'forbidden-not-platform-admin'
  | 'forbidden-not-workspace-member'
  | 'reason-required'
  | 'audit-write-failed'
  | 'refund-live-refused'
  | 'refund-provider-execution-refused'
  | 'refund-execution-unavailable'
  | 'not-found'
  | 'validation-failed';

export class AdminError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

// ── Internal records (server-side only; never returned directly) ──────────

export interface InternalBillingProfile {
  billingEmail: string;
  legalName: string;
  country: string;
  taxId: string | null;
  providerCustomerId: string | null;
  /** INTERNAL ONLY — provider credential material handle. DTO-excluded. */
  providerApiSecret: string | null;
  /** INTERNAL ONLY — webhook signing material handle. DTO-excluded. */
  providerWebhookSecret: string | null;
}

export interface InternalWorkspaceRecord {
  workspaceId: string;
  name: string;
  status: 'active' | 'suspended' | 'deletion-pending';
  ownerUserId: string;
  ownerEmail: string;
  createdAt: string; // ISO
  billingProfile: InternalBillingProfile;
}

export interface EntitlementOverride {
  dimension: EntitlementDimension;
  additionalUnits: number;
  reason: string;
  grantedByUserId: string;
  grantedAt: number; // ms epoch
  expiresAt: number | null;
  auditEntryId: string;
}

export interface InternalSubscriptionRecord {
  subscriptionId: string;
  workspaceId: string;
  planId: PlanId;
  status: SubscriptionStatus | 'free';
  provider: ProviderId | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  currency: CurrencyCode;
  /** Charge per billing period, integer minor units. */
  amountMinor: number;
  billingPeriod: 'monthly' | 'annual';
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  hadTrial: boolean;
  cancelAtPeriodEnd: boolean;
  cancellationRequestedAt: string | null;
  pastDueSince: string | null;
  createdAt: string;
  cancelledAt: string | null;
  entitlementOverrides: EntitlementOverride[];
}

export interface InternalInvoiceRecord {
  invoiceId: string;
  workspaceId: string;
  subscriptionId: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  status: 'paid' | 'open' | 'failed' | 'void' | 'refunded';
  issuedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  providerInvoiceRef: string | null;
}

export interface InternalPaymentEventRecord {
  eventId: string;
  provider: ProviderId;
  providerEventId: string;
  workspaceId: string;
  subscriptionId: string | null;
  type: string;
  outcome: string;
  amountMinor: number | null;
  currency: CurrencyCode | null;
  occurredAt: string;
}

export interface InternalUsageRecord extends UsageSnapshot {
  workspaceId: string;
  periodStart: string;
}

export type RefundStatus = 'recorded-mock';

export interface InternalRefundRecord {
  refundId: string;
  workspaceId: string;
  invoiceId: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  reason: string;
  status: RefundStatus;
  mode: 'mock';
  /** Always null in Phase 14: no provider refund is ever executed here. */
  providerRefundId: null;
  recordedByUserId: string;
  recordedAt: number;
  auditEntryId: string;
}

export interface InternalCancellationRequest {
  requestId: string;
  workspaceId: string;
  requestedAt: string;
  effectiveAt: string | null;
  reasonCategory: 'price' | 'not-using' | 'switching' | 'other' | 'unspecified';
  status: 'pending' | 'scheduled' | 'completed' | 'withdrawn';
}

// ── Frontend-facing DTOs (allowlist-built in ./dto.ts; no secret fields) ──

export interface CustomerDTO {
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: InternalWorkspaceRecord['status'];
  ownerEmail: string;
  billingEmail: string;
  legalName: string;
  country: string;
  planId: PlanId | null;
  subscriptionStatus: InternalSubscriptionRecord['status'] | null;
  currency: CurrencyCode | null;
  createdAt: string;
}

export interface SubscriptionDTO {
  subscriptionId: string;
  workspaceId: string;
  planId: PlanId;
  status: InternalSubscriptionRecord['status'];
  provider: ProviderId | null;
  providerSubscriptionId: string | null;
  currency: CurrencyCode;
  amountMinor: number;
  billingPeriod: 'monthly' | 'annual';
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  entitlementOverrides: readonly EntitlementOverride[];
}

export interface InvoiceDTO {
  invoiceId: string;
  workspaceId: string;
  amountMinor: number;
  currency: CurrencyCode;
  status: InternalInvoiceRecord['status'];
  issuedAt: string;
}

export interface PaymentEventDTO {
  eventId: string;
  provider: ProviderId;
  providerEventId: string;
  workspaceId: string;
  type: string;
  outcome: string;
  amountMinor: number | null;
  currency: CurrencyCode | null;
  occurredAt: string;
}

export interface RefundDTO {
  refundId: string;
  workspaceId: string;
  invoiceId: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  reason: string;
  status: RefundStatus;
  mode: 'mock';
  recordedAt: number;
}

export interface CancellationRequestDTO {
  requestId: string;
  workspaceId: string;
  requestedAt: string;
  effectiveAt: string | null;
  reasonCategory: InternalCancellationRequest['reasonCategory'];
  status: InternalCancellationRequest['status'];
}
