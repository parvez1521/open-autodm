/**
 * Phase 14 — DTO builders. Every builder picks fields EXPLICITLY
 * (allowlist). Internal records are never spread into a DTO, so a new
 * secret-bearing field added to an internal record cannot leak by
 * accident (invariant (d) — verified by serialization scan in tests).
 */
import type {
  CancellationRequestDTO,
  CustomerDTO,
  InternalCancellationRequest,
  InternalInvoiceRecord,
  InternalPaymentEventRecord,
  InternalRefundRecord,
  InternalSubscriptionRecord,
  InternalWorkspaceRecord,
  InvoiceDTO,
  PaymentEventDTO,
  RefundDTO,
  SubscriptionDTO,
} from './types';

export function toCustomerDTO(ws: InternalWorkspaceRecord, sub: InternalSubscriptionRecord | null): CustomerDTO {
  return {
    workspaceId: ws.workspaceId,
    workspaceName: ws.name,
    workspaceStatus: ws.status,
    ownerEmail: ws.ownerEmail,
    billingEmail: ws.billingProfile.billingEmail,
    legalName: ws.billingProfile.legalName,
    country: ws.billingProfile.country,
    planId: sub?.planId ?? null,
    subscriptionStatus: sub?.status ?? null,
    currency: sub?.currency ?? null,
    createdAt: ws.createdAt,
  };
}

export function toSubscriptionDTO(s: InternalSubscriptionRecord): SubscriptionDTO {
  return {
    subscriptionId: s.subscriptionId,
    workspaceId: s.workspaceId,
    planId: s.planId,
    status: s.status,
    provider: s.provider,
    providerSubscriptionId: s.providerSubscriptionId,
    currency: s.currency,
    amountMinor: s.amountMinor,
    billingPeriod: s.billingPeriod,
    currentPeriodEnd: s.currentPeriodEnd,
    trialEndsAt: s.trialEndsAt,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    pastDueSince: s.pastDueSince,
    entitlementOverrides: s.entitlementOverrides.map((o) => ({ ...o })),
  };
}

export function toInvoiceDTO(i: InternalInvoiceRecord): InvoiceDTO {
  return {
    invoiceId: i.invoiceId,
    workspaceId: i.workspaceId,
    amountMinor: i.amountMinor,
    currency: i.currency,
    status: i.status,
    issuedAt: i.issuedAt,
  };
}

export function toPaymentEventDTO(e: InternalPaymentEventRecord): PaymentEventDTO {
  return {
    eventId: e.eventId,
    provider: e.provider,
    providerEventId: e.providerEventId,
    workspaceId: e.workspaceId,
    type: e.type,
    outcome: e.outcome,
    amountMinor: e.amountMinor,
    currency: e.currency,
    occurredAt: e.occurredAt,
  };
}

export function toRefundDTO(r: InternalRefundRecord): RefundDTO {
  return {
    refundId: r.refundId,
    workspaceId: r.workspaceId,
    invoiceId: r.invoiceId,
    amountMinor: r.amountMinor,
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    mode: r.mode,
    recordedAt: r.recordedAt,
  };
}

export function toCancellationRequestDTO(r: InternalCancellationRequest): CancellationRequestDTO {
  return {
    requestId: r.requestId,
    workspaceId: r.workspaceId,
    requestedAt: r.requestedAt,
    effectiveAt: r.effectiveAt,
    reasonCategory: r.reasonCategory,
    status: r.status,
  };
}
