/**
 * Phase 14 — platform-admin service over the Phase 12/13 billing +
 * tenancy model. PROTOTYPE / MOCK ONLY: all state is the injected
 * in-memory store, no provider is ever called, no money ever moves.
 *
 * Invariants (all enforced here, server-side, and tested in
 * tests/billing-admin.test.ts):
 *  (a) Role separation — platform-admin checks read ONLY
 *      `actor.platformRole`; workspace roles read ONLY
 *      `actor.workspaceRoles[workspaceId]`. A workspace owner does not
 *      pass platform checks; a platform admin does not pass
 *      workspace-data reads for a workspace they are not a member of.
 *  (b) Every manual override requires a non-empty reason and an audit
 *      write. The audit append happens BEFORE the mutation is applied;
 *      if the append throws, the override fails with
 *      'audit-write-failed' and state is unchanged — an override
 *      without an audit event cannot exist through this API.
 *  (c) Workspace-scoped data reads (invoices, payment events, usage)
 *      require membership in THAT workspace. There is no code path
 *      where a caller reads another workspace's billing data through
 *      the workspace-scoped or reporting methods.
 *  (d) Only DTOs (./dto.ts allowlist picks) leave this service.
 *  (e) Refunds are RECORDING-only, mock mode. `executeRefund` always
 *      refuses; `recordRefund` refuses any non-mock mode. Live refunds
 *      flow only through the verified-provider-API design in
 *      saas/phase14-billing-admin-architecture.md — never from here.
 */
import { readBillingFlags, type BillingFlags } from '../billing/flags';
import type { PlanId } from '../billing/catalogue';
import type { SubscriptionStatus } from '../billing/lifecycle';
import type { EntitlementDimension, UsageSnapshot } from '../entitlements/service';
import type { AdminAuditEntry, AdminAuditLog } from './audit';
import { InMemoryAdminAuditLog } from './audit';
import type { InMemoryAdminStore } from './store';
import { computeBillingReports, type BillingReports } from './reports';
import {
  toCancellationRequestDTO,
  toCustomerDTO,
  toInvoiceDTO,
  toPaymentEventDTO,
  toRefundDTO,
  toSubscriptionDTO,
} from './dto';
import {
  AdminError,
  type ActorContext,
  type CancellationRequestDTO,
  type CustomerDTO,
  type InternalSubscriptionRecord,
  type InvoiceDTO,
  type PaymentEventDTO,
  type RefundDTO,
  type SubscriptionDTO,
} from './types';

// ── Guards (exported for direct unit testing) ──────────────────────────────

export function isPlatformStaff(actor: ActorContext): boolean {
  return actor.platformRole === 'platform-admin' || actor.platformRole === 'platform-support';
}
export function isPlatformAdmin(actor: ActorContext): boolean {
  return actor.platformRole === 'platform-admin';
}
export function requirePlatformStaff(actor: ActorContext): void {
  if (!isPlatformStaff(actor)) {
    throw new AdminError('forbidden-not-platform-staff', `user ${actor.userId} is not platform staff (workspace roles confer no platform access)`);
  }
}
export function requirePlatformAdmin(actor: ActorContext): void {
  if (!isPlatformAdmin(actor)) {
    throw new AdminError('forbidden-not-platform-admin', `user ${actor.userId} is not a platform admin`);
  }
}
/** Workspace-data read guard: platform role plays NO part here (invariant (a) vice-versa). */
export function requireWorkspaceMember(actor: ActorContext, workspaceId: string): void {
  if (!actor.workspaceRoles[workspaceId]) {
    throw new AdminError('forbidden-not-workspace-member', `user ${actor.userId} is not a member of workspace ${workspaceId}`);
  }
}

function requireReason(reason: string | undefined): string {
  const r = (reason ?? '').trim();
  if (r.length === 0) throw new AdminError('reason-required', 'a reason is required for every manual override / admin financial record');
  return r;
}

export interface AdminServiceDeps {
  store: InMemoryAdminStore;
  audit?: AdminAuditLog;
  flags?: BillingFlags;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export class AdminService {
  private readonly store: InMemoryAdminStore;
  private readonly audit: AdminAuditLog;
  private readonly flags: BillingFlags;
  private readonly now: () => number;
  private refundSeq = 0;

  constructor(deps: AdminServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit ?? new InMemoryAdminAuditLog();
    this.flags = deps.flags ?? readBillingFlags(deps.env ?? {});
    this.now = deps.now ?? (() => Date.now());
  }

  // ── Platform-staff reads (directory, lists, history, reports) ──────────

  listCustomers(actor: ActorContext): CustomerDTO[] {
    requirePlatformStaff(actor);
    return [...this.store.workspaces.values()].map((ws) => toCustomerDTO(ws, this.store.subscriptionForWorkspace(ws.workspaceId)));
  }

  getCustomer(actor: ActorContext, workspaceId: string): CustomerDTO {
    requirePlatformStaff(actor);
    const ws = this.store.workspaces.get(workspaceId);
    if (!ws) throw new AdminError('not-found', `workspace ${workspaceId} not found`);
    return toCustomerDTO(ws, this.store.subscriptionForWorkspace(workspaceId));
  }

  listSubscriptions(
    actor: ActorContext,
    filter: { status?: SubscriptionStatus | 'free'; workspaceId?: string } = {},
  ): SubscriptionDTO[] {
    requirePlatformStaff(actor);
    return [...this.store.subscriptions.values()]
      .filter((s) => (filter.status ? s.status === filter.status : true))
      .filter((s) => (filter.workspaceId ? s.workspaceId === filter.workspaceId : true))
      .map(toSubscriptionDTO);
  }

  listTrials(actor: ActorContext): SubscriptionDTO[] {
    return this.listSubscriptions(actor, { status: 'trialing' });
  }
  listPastDue(actor: ActorContext): SubscriptionDTO[] {
    return this.listSubscriptions(actor, { status: 'past_due' });
  }

  /** Failed payments = payment_failed events + failed invoices, platform view. */
  listFailedPayments(actor: ActorContext): { events: PaymentEventDTO[]; invoices: InvoiceDTO[] } {
    requirePlatformStaff(actor);
    return {
      events: this.store.paymentEvents.filter((e) => e.type === 'payment_failed').map(toPaymentEventDTO),
      invoices: this.store.invoices.filter((i) => i.status === 'failed').map(toInvoiceDTO),
    };
  }

  listPaymentEvents(actor: ActorContext, filter: { workspaceId?: string } = {}): PaymentEventDTO[] {
    requirePlatformStaff(actor);
    return this.store.paymentEvents
      .filter((e) => (filter.workspaceId ? e.workspaceId === filter.workspaceId : true))
      .map(toPaymentEventDTO);
  }

  listInvoices(actor: ActorContext): InvoiceDTO[] {
    requirePlatformStaff(actor);
    return this.store.invoices.map(toInvoiceDTO);
  }

  listCancellationRequests(actor: ActorContext): CancellationRequestDTO[] {
    requirePlatformStaff(actor);
    return this.store.cancellationRequests.map(toCancellationRequestDTO);
  }

  listRefunds(actor: ActorContext): RefundDTO[] {
    requirePlatformStaff(actor);
    return this.store.refunds.map(toRefundDTO);
  }

  getReports(actor: ActorContext, opts: { asOf: string; churnPeriod: { start: string; end: string } }): BillingReports {
    requirePlatformStaff(actor);
    return computeBillingReports([...this.store.subscriptions.values()], opts);
  }

  getAuditLog(actor: ActorContext, filter: { workspaceId?: string; action?: string } = {}): readonly AdminAuditEntry[] {
    requirePlatformStaff(actor);
    return this.audit.list(filter);
  }

  // ── Workspace-scoped reads (invariant (c)) ─────────────────────────────
  // These are the customer-data reads. Platform staff use the platform
  // methods above; THESE methods answer only to workspace membership.

  getWorkspaceInvoices(actor: ActorContext, workspaceId: string): InvoiceDTO[] {
    requireWorkspaceMember(actor, workspaceId);
    return this.store.invoices.filter((i) => i.workspaceId === workspaceId).map(toInvoiceDTO);
  }

  getWorkspacePaymentEvents(actor: ActorContext, workspaceId: string): PaymentEventDTO[] {
    requireWorkspaceMember(actor, workspaceId);
    return this.store.paymentEvents.filter((e) => e.workspaceId === workspaceId).map(toPaymentEventDTO);
  }

  getWorkspaceUsage(actor: ActorContext, workspaceId: string): UsageSnapshot & { workspaceId: string; periodStart: string } {
    requireWorkspaceMember(actor, workspaceId);
    const rec = this.store.usage.find((u) => u.workspaceId === workspaceId);
    if (!rec) throw new AdminError('not-found', `no usage recorded for workspace ${workspaceId}`);
    const { workspaceId: wsId, periodStart, ...usage } = rec;
    return { workspaceId: wsId, periodStart, ...usage };
  }

  // ── Manual overrides (invariant (b): reason + audit-before-mutate) ────

  private subscriptionOrThrow(workspaceId: string): InternalSubscriptionRecord {
    const sub = this.store.subscriptionForWorkspace(workspaceId);
    if (!sub) throw new AdminError('not-found', `no subscription for workspace ${workspaceId}`);
    return sub;
  }

  /** Append first; if this throws, the caller must not mutate (invariant (b)). */
  private appendAuditOrFail(input: Parameters<AdminAuditLog['append']>[0]): AdminAuditEntry {
    try {
      return this.audit.append(input);
    } catch (err) {
      throw new AdminError('audit-write-failed', `override aborted: audit write failed (${err instanceof Error ? err.message : 'unknown'})`);
    }
  }

  changePlan(actor: ActorContext, input: { workspaceId: string; toPlanId: PlanId; reason?: string }): SubscriptionDTO {
    requirePlatformAdmin(actor);
    const reason = requireReason(input.reason);
    const sub = this.subscriptionOrThrow(input.workspaceId);
    const before = { planId: sub.planId, status: sub.status };
    const after = { planId: input.toPlanId, status: sub.status };
    this.appendAuditOrFail({
      actorUserId: actor.userId, actorPlatformRole: actor.platformRole,
      action: 'subscription.plan_change', targetType: 'subscription', targetId: sub.subscriptionId,
      workspaceId: input.workspaceId, before, after, reason, at: this.now(),
    });
    sub.planId = input.toPlanId;
    return toSubscriptionDTO(sub);
  }

  extendTrial(actor: ActorContext, input: { workspaceId: string; additionalDays: number; reason?: string }): SubscriptionDTO {
    requirePlatformAdmin(actor);
    const reason = requireReason(input.reason);
    if (!Number.isInteger(input.additionalDays) || input.additionalDays <= 0) {
      throw new AdminError('validation-failed', 'additionalDays must be a positive integer');
    }
    const sub = this.subscriptionOrThrow(input.workspaceId);
    if (sub.status !== 'trialing' || sub.trialEndsAt === null) {
      throw new AdminError('validation-failed', `workspace ${input.workspaceId} is not trialing`);
    }
    const before = { trialEndsAt: sub.trialEndsAt, status: sub.status };
    const newEnd = new Date(Date.parse(sub.trialEndsAt) + input.additionalDays * 24 * 60 * 60 * 1000).toISOString();
    const after = { trialEndsAt: newEnd, status: sub.status };
    this.appendAuditOrFail({
      actorUserId: actor.userId, actorPlatformRole: actor.platformRole,
      action: 'subscription.trial_extend', targetType: 'subscription', targetId: sub.subscriptionId,
      workspaceId: input.workspaceId, before, after, reason, at: this.now(),
    });
    sub.trialEndsAt = newEnd;
    return toSubscriptionDTO(sub);
  }

  bumpEntitlement(
    actor: ActorContext,
    input: { workspaceId: string; dimension: EntitlementDimension; additionalUnits: number; expiresAt?: number | null; reason?: string },
  ): SubscriptionDTO {
    requirePlatformAdmin(actor);
    const reason = requireReason(input.reason);
    if (!Number.isInteger(input.additionalUnits) || input.additionalUnits <= 0) {
      throw new AdminError('validation-failed', 'additionalUnits must be a positive integer');
    }
    const sub = this.subscriptionOrThrow(input.workspaceId);
    const before = { dimension: input.dimension, overrideCount: sub.entitlementOverrides.length };
    const after = { dimension: input.dimension, additionalUnits: input.additionalUnits, expiresAt: input.expiresAt ?? null };
    const entry = this.appendAuditOrFail({
      actorUserId: actor.userId, actorPlatformRole: actor.platformRole,
      action: 'entitlement.bump', targetType: 'entitlement', targetId: sub.subscriptionId,
      workspaceId: input.workspaceId, before, after, reason, at: this.now(),
    });
    sub.entitlementOverrides.push({
      dimension: input.dimension,
      additionalUnits: input.additionalUnits,
      reason,
      grantedByUserId: actor.userId,
      grantedAt: this.now(),
      expiresAt: input.expiresAt ?? null,
      auditEntryId: entry.id,
    });
    return toSubscriptionDTO(sub);
  }

  // ── Refunds (invariant (e): record-only, mock; execution always refused)

  recordRefund(
    actor: ActorContext,
    input: {
      workspaceId: string; invoiceId?: string | null; amountMinor: number;
      currency: InternalSubscriptionRecord['currency']; reason?: string; mode?: 'mock' | 'live';
    },
  ): RefundDTO {
    requirePlatformAdmin(actor);
    if (input.mode !== undefined && input.mode !== 'mock') {
      throw new AdminError('refund-live-refused', 'refunds are recording-only in mock mode in Phase 14; live refund execution is refused');
    }
    const reason = requireReason(input.reason);
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new AdminError('validation-failed', 'amountMinor must be a positive integer (minor units)');
    }
    if (!this.store.workspaces.has(input.workspaceId)) {
      throw new AdminError('not-found', `workspace ${input.workspaceId} not found`);
    }
    this.refundSeq += 1;
    const refundId = `refund_mock_${this.refundSeq}`;
    const entry = this.appendAuditOrFail({
      actorUserId: actor.userId, actorPlatformRole: actor.platformRole,
      action: 'refund.recorded_mock', targetType: 'refund', targetId: refundId,
      workspaceId: input.workspaceId, before: null,
      after: { amountMinor: input.amountMinor, currency: input.currency, status: 'recorded-mock' },
      reason, at: this.now(),
    });
    const record = {
      refundId,
      workspaceId: input.workspaceId,
      invoiceId: input.invoiceId ?? null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      reason,
      status: 'recorded-mock' as const,
      mode: 'mock' as const,
      providerRefundId: null,
      recordedByUserId: actor.userId,
      recordedAt: this.now(),
      auditEntryId: entry.id,
    };
    this.store.addRefund(record);
    return toRefundDTO(record);
  }

  /**
   * Execution is NEVER available in Phase 14. Any attempt refuses with
   * an explicit error: live mode on, or a provider call attempted, each
   * get their own refusal; the plain path refuses as unavailable in the
   * prototype. The production design (verified provider API + dual
   * control) is documented, not implemented.
   */
  executeRefund(
    actor: ActorContext,
    input: { refundId: string; viaProviderApi?: boolean },
  ): never {
    requirePlatformAdmin(actor);
    if (this.flags.paymentsLiveMode) {
      throw new AdminError('refund-live-refused', 'refund execution refused: PAYMENTS_LIVE_MODE is on and live refunds are not executed from the admin prototype');
    }
    if (input.viaProviderApi) {
      throw new AdminError('refund-provider-execution-refused', 'refund execution refused: provider refund API calls are never made from the admin prototype');
    }
    throw new AdminError('refund-execution-unavailable', `refund execution refused: refund ${input.refundId} is a mock record; execution exists only in the documented verified-provider-API design`);
  }
}
