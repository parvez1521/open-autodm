import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AdminService, isPlatformAdmin, isPlatformStaff } from '@/lib/admin/service';
import { InMemoryAdminAuditLog, type AdminAuditLog } from '@/lib/admin/audit';
import { InMemoryAdminStore, createSyntheticAdminStore } from '@/lib/admin/store';
import { computeChurn, computeMrr, computePastDueAging, computeTrialConversion } from '@/lib/admin/reports';
import { evaluatePlatformAdminGate } from '@/lib/admin/guard';
import { AdminError, type ActorContext, type InternalSubscriptionRecord } from '@/lib/admin/types';

const platformAdmin: ActorContext = { userId: 'staff-admin-1', platformRole: 'platform-admin', workspaceRoles: {} };
const platformSupport: ActorContext = { userId: 'staff-support-1', platformRole: 'platform-support', workspaceRoles: {} };
const ownerAlpha: ActorContext = { userId: 'user-owner-alpha', platformRole: 'none', workspaceRoles: { 'ws-alpha': 'owner' } };
const memberGamma: ActorContext = { userId: 'user-member-gamma', platformRole: 'none', workspaceRoles: { 'ws-gamma': 'member' } };
const stranger: ActorContext = { userId: 'user-stranger', platformRole: 'none', workspaceRoles: {} };

function expectAdminError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AdminError);
    expect((e as AdminError).code).toBe(code);
    return;
  }
  throw new Error(`expected AdminError ${code}, but nothing was thrown`);
}

function makeSub(p: Partial<InternalSubscriptionRecord> & { subscriptionId: string; workspaceId: string }): InternalSubscriptionRecord {
  return {
    planId: 'starter', status: 'active', provider: 'razorpay', providerSubscriptionId: `sub_${p.subscriptionId}`,
    providerCustomerId: 'cust_x', currency: 'INR', amountMinor: 0, billingPeriod: 'monthly',
    currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null, hadTrial: false,
    cancelAtPeriodEnd: false, cancellationRequestedAt: null, pastDueSince: null,
    createdAt: '2026-09-01T00:00:00.000Z', cancelledAt: null, entitlementOverrides: [],
    ...p,
  };
}

describe('Phase 14 invariant (a): platform role is separate from workspace role', () => {
  it('a workspace owner does NOT pass platform-admin or platform-staff checks', () => {
    expect(isPlatformAdmin(ownerAlpha)).toBe(false);
    expect(isPlatformStaff(ownerAlpha)).toBe(false);
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    expectAdminError(() => svc.listCustomers(ownerAlpha), 'forbidden-not-platform-staff');
    expectAdminError(() => svc.listSubscriptions(ownerAlpha), 'forbidden-not-platform-staff');
    expectAdminError(() => svc.getReports(ownerAlpha, { asOf: '2026-11-06T00:00:00.000Z', churnPeriod: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' } }), 'forbidden-not-platform-staff');
    expectAdminError(() => svc.changePlan(ownerAlpha, { workspaceId: 'ws-alpha', toPlanId: 'agency', reason: 'owner trying' }), 'forbidden-not-platform-admin');
  });
  it('vice versa: a platform admin does NOT pass workspace-data reads for a workspace they are not a member of', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    expectAdminError(() => svc.getWorkspaceInvoices(platformAdmin, 'ws-alpha'), 'forbidden-not-workspace-member');
    expectAdminError(() => svc.getWorkspacePaymentEvents(platformAdmin, 'ws-alpha'), 'forbidden-not-workspace-member');
    expectAdminError(() => svc.getWorkspaceUsage(platformAdmin, 'ws-alpha'), 'forbidden-not-workspace-member');
  });
  it('platform-support is read-only staff: reads pass, overrides and refunds are denied', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    expect(svc.listCustomers(platformSupport).length).toBe(4);
    expect(svc.listSubscriptions(platformSupport).length).toBe(4);
    expectAdminError(() => svc.changePlan(platformSupport, { workspaceId: 'ws-alpha', toPlanId: 'agency', reason: 'support trying' }), 'forbidden-not-platform-admin');
    expectAdminError(() => svc.recordRefund(platformSupport, { workspaceId: 'ws-alpha', amountMinor: 100, currency: 'INR', reason: 'support trying' }), 'forbidden-not-platform-admin');
  });
  it('the UI gate stub fails closed by default and only admits an env-named platform admin', () => {
    expect(evaluatePlatformAdminGate({}).allowed).toBe(false);
    expect(evaluatePlatformAdminGate({ ADMIN_PROTOTYPE_PLATFORM_ADMIN: 'true' }).allowed).toBe(false);
    const gate = evaluatePlatformAdminGate({ ADMIN_PROTOTYPE_PLATFORM_ADMIN: 'true', ADMIN_PROTOTYPE_ACTOR_ID: 'staff-admin-1' });
    expect(gate.allowed).toBe(true);
    expect(gate.actor?.platformRole).toBe('platform-admin');
    expect(gate.actor?.workspaceRoles).toEqual({});
  });
});

describe('Phase 14 invariant (b): overrides require a reason and an audit write', () => {
  it('an override without a reason fails and changes nothing', () => {
    const store = createSyntheticAdminStore();
    const svc = new AdminService({ store });
    expectAdminError(() => svc.changePlan(platformAdmin, { workspaceId: 'ws-alpha', toPlanId: 'agency' }), 'reason-required');
    expectAdminError(() => svc.changePlan(platformAdmin, { workspaceId: 'ws-alpha', toPlanId: 'agency', reason: '   ' }), 'reason-required');
    expectAdminError(() => svc.extendTrial(platformAdmin, { workspaceId: 'ws-beta', additionalDays: 7, reason: '' }), 'reason-required');
    expectAdminError(() => svc.bumpEntitlement(platformAdmin, { workspaceId: 'ws-alpha', dimension: 'dmsPerMonth', additionalUnits: 100 }), 'reason-required');
    expect(store.subscriptionForWorkspace('ws-alpha')?.planId).toBe('starter');
    expect(svc.getAuditLog(platformAdmin)).toHaveLength(0);
  });
  it('plan change applies and appends a full audit event (actor, action, target, before/after, reason, timestamp)', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore(), now: () => 1730000000000 });
    const dto = svc.changePlan(platformAdmin, { workspaceId: 'ws-alpha', toPlanId: 'creator-pro', reason: 'Support ticket #101 — customer upgraded after call' });
    expect(dto.planId).toBe('creator-pro');
    const log = svc.getAuditLog(platformAdmin);
    expect(log).toHaveLength(1);
    const e = log[0]!;
    expect(e.actorUserId).toBe('staff-admin-1');
    expect(e.action).toBe('subscription.plan_change');
    expect(e.targetId).toBe('sub-alpha');
    expect(e.workspaceId).toBe('ws-alpha');
    expect(e.before).toEqual({ planId: 'starter', status: 'active' });
    expect(e.after).toEqual({ planId: 'creator-pro', status: 'active' });
    expect(e.reason).toContain('Support ticket #101');
    expect(e.at).toBe(1730000000000);
  });
  it('trial extension moves trialEndsAt and is audited; non-trialing workspaces are rejected', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    const dto = svc.extendTrial(platformAdmin, { workspaceId: 'ws-beta', additionalDays: 7, reason: 'Card update pending — goodwill extension' });
    expect(dto.trialEndsAt).toBe('2026-11-24T00:00:00.000Z');
    expectAdminError(() => svc.extendTrial(platformAdmin, { workspaceId: 'ws-alpha', additionalDays: 7, reason: 'not trialing' }), 'validation-failed');
  });
  it('entitlement bump records the override linked to its audit entry', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    const dto = svc.bumpEntitlement(platformAdmin, { workspaceId: 'ws-alpha', dimension: 'dmsPerMonth', additionalUnits: 500, reason: 'Campaign spike — one-off bump' });
    expect(dto.entitlementOverrides).toHaveLength(1);
    expect(dto.entitlementOverrides[0]?.additionalUnits).toBe(500);
    const log = svc.getAuditLog(platformAdmin);
    expect(dto.entitlementOverrides[0]?.auditEntryId).toBe(log[0]?.id);
  });
  it('if the audit write fails, the override MUST fail and state stays unchanged', () => {
    const failingAudit: AdminAuditLog = {
      append: () => { throw new Error('audit store unavailable (simulated)'); },
      list: () => [],
    };
    const store = createSyntheticAdminStore();
    const svc = new AdminService({ store, audit: failingAudit });
    expectAdminError(() => svc.changePlan(platformAdmin, { workspaceId: 'ws-alpha', toPlanId: 'agency', reason: 'must not apply' }), 'audit-write-failed');
    expect(store.subscriptionForWorkspace('ws-alpha')?.planId).toBe('starter');
    expectAdminError(() => svc.bumpEntitlement(platformAdmin, { workspaceId: 'ws-alpha', dimension: 'dmsPerMonth', additionalUnits: 10, reason: 'must not apply' }), 'audit-write-failed');
    expect(store.subscriptionForWorkspace('ws-alpha')?.entitlementOverrides).toHaveLength(0);
    expectAdminError(() => svc.recordRefund(platformAdmin, { workspaceId: 'ws-alpha', amountMinor: 100, currency: 'INR', reason: 'must not record' }), 'audit-write-failed');
    expect(store.refunds).toHaveLength(0);
  });
});

describe('Phase 14 invariant (c): workspace-scoped reads cannot cross workspaces', () => {
  it('a workspace owner reads ONLY their own invoices, events and usage', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    expect(svc.getWorkspaceInvoices(ownerAlpha, 'ws-alpha').map((i) => i.invoiceId)).toEqual(['inv-alpha-1']);
    expect(svc.getWorkspacePaymentEvents(ownerAlpha, 'ws-alpha').map((e) => e.eventId)).toEqual(['evt-1']);
    expectAdminError(() => svc.getWorkspaceInvoices(ownerAlpha, 'ws-gamma'), 'forbidden-not-workspace-member');
    expectAdminError(() => svc.getWorkspacePaymentEvents(ownerAlpha, 'ws-gamma'), 'forbidden-not-workspace-member');
    expectAdminError(() => svc.getWorkspaceUsage(ownerAlpha, 'ws-gamma'), 'forbidden-not-workspace-member');
    expectAdminError(() => svc.getWorkspaceInvoices(stranger, 'ws-alpha'), 'forbidden-not-workspace-member');
  });
  it('a member of gamma reads gamma usage but nothing from alpha', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    const usage = svc.getWorkspaceUsage(memberGamma, 'ws-gamma');
    expect(usage.workspaceId).toBe('ws-gamma');
    expect(usage.dmsThisMonth).toBe(1900);
    expectAdminError(() => svc.getWorkspaceUsage(memberGamma, 'ws-alpha'), 'forbidden-not-workspace-member');
  });
});

describe('Phase 14 invariant (d): no provider secret reaches any DTO', () => {
  it('serialization scan: DTOs from every surface contain neither secret values nor secret-shaped keys', () => {
    const store = createSyntheticAdminStore();
    const ws = store.workspaces.get('ws-alpha')!;
    ws.billingProfile.providerApiSecret = 'SENTINEL_API_SECRET_9f3c';
    ws.billingProfile.providerWebhookSecret = 'SENTINEL_WEBHOOK_SECRET_71ab';
    const svc = new AdminService({ store });
    svc.recordRefund(platformAdmin, { workspaceId: 'ws-alpha', amountMinor: 100, currency: 'INR', reason: 'scan fixture' });
    const surfaces: unknown[] = [
      svc.listCustomers(platformAdmin),
      svc.getCustomer(platformAdmin, 'ws-alpha'),
      svc.listSubscriptions(platformAdmin),
      svc.listTrials(platformAdmin),
      svc.listPastDue(platformAdmin),
      svc.listFailedPayments(platformAdmin),
      svc.listPaymentEvents(platformAdmin),
      svc.listInvoices(platformAdmin),
      svc.listCancellationRequests(platformAdmin),
      svc.listRefunds(platformAdmin),
      svc.getWorkspaceInvoices(ownerAlpha, 'ws-alpha'),
      svc.getWorkspacePaymentEvents(ownerAlpha, 'ws-alpha'),
      svc.getWorkspaceUsage(ownerAlpha, 'ws-alpha'),
      svc.getAuditLog(platformAdmin),
      svc.getReports(platformAdmin, { asOf: '2026-11-06T00:00:00.000Z', churnPeriod: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' } }),
    ];
    // Sanity: the internal record really holds the sentinels, so a clean scan is meaningful.
    expect(JSON.stringify(ws)).toContain('SENTINEL_API_SECRET_9f3c');
    for (const surface of surfaces) {
      const json = JSON.stringify(surface);
      expect(json).not.toContain('SENTINEL_API_SECRET_9f3c');
      expect(json).not.toContain('SENTINEL_WEBHOOK_SECRET_71ab');
      expect(json).not.toMatch(/providerApiSecret|providerWebhookSecret/);
    }
    const keyScan = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.flatMap(keyScan);
      if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, val]) => [/secret/i.test(k) ? k : [], ...keyScan(val)].flat());
      return [];
    };
    for (const surface of surfaces) expect(keyScan(surface)).toEqual([]);
  });
});

describe('Phase 14 invariant (e): refunds are mock recording only; execution always refuses', () => {
  it('recordRefund in mock mode records (never executes) and audits', () => {
    const store = createSyntheticAdminStore();
    const svc = new AdminService({ store });
    const dto = svc.recordRefund(platformAdmin, { workspaceId: 'ws-alpha', invoiceId: 'inv-alpha-1', amountMinor: 49900, currency: 'INR', reason: 'Duplicate charge reported — goodwill (mock record)' });
    expect(dto.status).toBe('recorded-mock');
    expect(dto.mode).toBe('mock');
    expect(store.refunds[0]?.providerRefundId).toBeNull();
    expect(svc.getAuditLog(platformAdmin).map((e) => e.action)).toContain('refund.recorded_mock');
  });
  it('recordRefund refuses live mode and missing reasons', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    expectAdminError(() => svc.recordRefund(platformAdmin, { workspaceId: 'ws-alpha', amountMinor: 100, currency: 'INR', reason: 'x', mode: 'live' }), 'refund-live-refused');
    expectAdminError(() => svc.recordRefund(platformAdmin, { workspaceId: 'ws-alpha', amountMinor: 100, currency: 'INR' }), 'reason-required');
  });
  it('executeRefund refuses on every path, with an explicit error', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    const rec = svc.recordRefund(platformAdmin, { workspaceId: 'ws-alpha', amountMinor: 100, currency: 'INR', reason: 'fixture' });
    expectAdminError(() => svc.executeRefund(platformAdmin, { refundId: rec.refundId }), 'refund-execution-unavailable');
    expectAdminError(() => svc.executeRefund(platformAdmin, { refundId: rec.refundId, viaProviderApi: true }), 'refund-provider-execution-refused');
    const liveSvc = new AdminService({ store: createSyntheticAdminStore(), flags: { billingEnabled: true, paymentsLiveMode: true } });
    expectAdminError(() => liveSvc.executeRefund(platformAdmin, { refundId: rec.refundId }), 'refund-live-refused');
    try {
      svc.executeRefund(platformAdmin, { refundId: rec.refundId });
      throw new Error('unreachable');
    } catch (e) {
      expect((e as Error).message).toMatch(/refund execution refused/i);
    }
  });
});

describe('Phase 14 audit log: append-only behaviour', () => {
  it('entries are frozen, list returns copies, and stored history cannot be mutated through returned objects', () => {
    const log = new InMemoryAdminAuditLog();
    const entry = log.append({
      actorUserId: 'staff-admin-1', actorPlatformRole: 'platform-admin', action: 'subscription.plan_change',
      targetType: 'subscription', targetId: 'sub-alpha', workspaceId: 'ws-alpha',
      before: { planId: 'starter' }, after: { planId: 'agency' }, reason: 'original reason', at: 1000,
    });
    expect(Object.isFrozen(entry)).toBe(true);
    try {
      (entry as { reason: string }).reason = 'tampered';
    } catch { /* frozen objects throw on write in strict mode — either outcome is fine */ }
    try {
      (entry.after as { planId: string }).planId = 'free';
    } catch { /* as above */ }
    const listed = log.list();
    expect(listed[0]?.reason).toBe('original reason');
    expect((listed[0]?.after as { planId: string }).planId).toBe('agency');
    try {
      (listed as unknown as { length: number }).length = 0;
    } catch { /* frozen copy — either outcome is fine, the store is what matters */ }
    expect(log.list()).toHaveLength(1);
  });
  it('the audit log and the service expose no update/delete/clear API', () => {
    const log = new InMemoryAdminAuditLog() as unknown as Record<string, unknown>;
    expect(log.update).toBeUndefined();
    expect(log.delete).toBeUndefined();
    expect(log.clear).toBeUndefined();
    expect(log.remove).toBeUndefined();
    const svc = new AdminService({ store: createSyntheticAdminStore() }) as unknown as Record<string, unknown>;
    expect(svc.updateAuditEntry).toBeUndefined();
    expect(svc.deleteAuditEntry).toBeUndefined();
    expect(svc.clearAuditLog).toBeUndefined();
  });
  it('append requires a reason', () => {
    const log = new InMemoryAdminAuditLog();
    expect(() => log.append({
      actorUserId: 'a', actorPlatformRole: 'platform-admin', action: 'x', targetType: 'workspace',
      targetId: 't', workspaceId: null, before: null, after: null, reason: ' ',
    })).toThrow(/reason/);
  });
});

describe('Phase 14 reports over synthetic data (integer minor units, per-currency)', () => {
  const subs: InternalSubscriptionRecord[] = [
    makeSub({ subscriptionId: 'r1', workspaceId: 'w1', status: 'active', currency: 'INR', amountMinor: 49900, billingPeriod: 'monthly', hadTrial: true }),
    makeSub({ subscriptionId: 'r2', workspaceId: 'w2', status: 'past_due', currency: 'INR', amountMinor: 958800, billingPeriod: 'annual', pastDueSince: '2026-10-28T00:00:00.000Z' }),
    makeSub({ subscriptionId: 'r3', workspaceId: 'w3', status: 'active', currency: 'USD', amountMinor: 900, billingPeriod: 'monthly' }),
    makeSub({ subscriptionId: 'r4', workspaceId: 'w4', status: 'trialing', currency: 'USD', amountMinor: 1900, billingPeriod: 'monthly', hadTrial: true }),
    makeSub({ subscriptionId: 'r5', workspaceId: 'w5', status: 'cancelled', currency: 'USD', amountMinor: 5900, billingPeriod: 'monthly', hadTrial: true, cancelledAt: '2026-11-15T00:00:00.000Z' }),
    makeSub({ subscriptionId: 'r6', workspaceId: 'w6', status: 'active', currency: 'INR', amountMinor: 99900, billingPeriod: 'monthly', hadTrial: true }),
  ];
  it('MRR sums monthly equivalents per currency and NEVER across currencies', () => {
    const mrr = computeMrr(subs);
    // INR: 49900 (monthly active) + floor(958800/12)=79900 (annual past_due) + 99900 (monthly active) = 229700
    expect(mrr.INR).toBe(229700);
    // USD: only the active 900; trialing 1900 and cancelled 5900 excluded
    expect(mrr.USD).toBe(900);
    expect(Object.keys(mrr).sort()).toEqual(['INR', 'USD']);
    expect((mrr as Record<string, unknown>).total).toBeUndefined();
  });
  it('churn counts cancellations in the period against the active base', () => {
    const churn = computeChurn(subs, { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' });
    expect(churn.base).toBe(6); // all created before Nov; the cancelled one was still active at Nov 1
    expect(churn.cancelledInPeriod).toBe(1);
    expect(churn.churnBps).toBe(1667); // round(1/6 * 10000)
  });
  it('past-due aging buckets by days past due, per currency, in minor units', () => {
    const aging = computePastDueAging(subs, '2026-11-06T00:00:00.000Z');
    // r2: past due since 2026-10-28 → 9 days → bucket 8-30, INR 958800
    expect(aging.INR?.['8-30']).toEqual({ count: 1, amountMinor: 958800 });
    expect(aging.INR?.['0-7'].count).toBe(0);
    expect(aging.USD).toBeUndefined();
  });
  it('trial conversion counts had-trial subscriptions now active', () => {
    const tc = computeTrialConversion(subs);
    expect(tc.trialsStarted).toBe(4); // r1, r4, r5, r6
    expect(tc.converted).toBe(2); // r1, r6 (r4 still trialing, r5 cancelled)
    expect(tc.conversionBps).toBe(5000);
  });
  it('reports are platform-staff only through the service', () => {
    const store = new InMemoryAdminStore();
    for (const s of subs) store.addSubscription(s);
    const svc = new AdminService({ store });
    const reports = svc.getReports(platformSupport, { asOf: '2026-11-06T00:00:00.000Z', churnPeriod: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' } });
    expect(reports.mrrByCurrency.INR).toBe(229700);
    expectAdminError(() => svc.getReports(ownerAlpha, { asOf: '2026-11-06T00:00:00.000Z', churnPeriod: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' } }), 'forbidden-not-platform-staff');
  });
});

describe('Phase 14 admin prototype contract (migration + UI gating)', () => {
  it('migration …000029 exists, is copy-only / not on the frozen apply-list, and makes the audit log append-only', () => {
    const file = path.resolve(process.cwd(), 'supabase/migrations/20260730000029_admin_audit_billing_ops.sql');
    const sql = fs.readFileSync(file, 'utf8');
    expect(sql).toContain('NOT part of the frozen');
    expect(sql).toContain('admin_audit_log');
    expect(sql).toContain('append-only');
    expect(sql).toContain('admin_audit_no_update');
    expect(sql).toContain('admin_audit_no_delete');
    expect(sql).toContain('refund_records');
    expect(sql).toContain('v_billing_mrr_by_currency');
    // No authenticated grant on the audit log table.
    expect(sql).not.toMatch(/GRANT[^;]*ON TABLE public\.admin_audit_log TO authenticated/);
  });
  it('every remaining (admin) prototype page is gated by the server-side platform-admin stub', () => {
    // Supersession (2026-11-09): src/app/(admin)/admin/page.tsx is no
    // longer a prototype page — it is the REAL owner subscriber panel
    // (live billing tables), gated by the ADMIN_EMAILS allowlist with
    // a 404 posture instead of the stub + access-denied surface. Its
    // gate is pinned by tests/admin-panel.test.ts. The three pages
    // below remain Phase 14 prototypes and keep the stub gate.
    const pages = [
      'src/app/(admin)/admin/subscriptions/page.tsx',
      'src/app/(admin)/admin/payment-events/page.tsx',
      'src/app/(admin)/admin/overrides/page.tsx',
    ];
    for (const p of pages) {
      const src = fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
      expect(src, p).toContain('evaluatePlatformAdminGate');
      // Posture change (2026-11-09, live-QA fix): a failed gate is
      // now notFound() — a plain 404 like /admin — instead of the
      // HTTP-200 "Access denied" surface this pin used to require.
      expect(src, p).toContain('notFound()');
      expect(src, p).not.toContain('AdminAccessDenied');
    }
  });
});
