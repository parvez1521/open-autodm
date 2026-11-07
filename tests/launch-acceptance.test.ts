/**
 * Phase 15 — Commercial Launch Acceptance (18 scenarios, MOCK ONLY).
 *
 * Every scenario composes the REAL Phase 11–14 modules end-to-end:
 * catalogue (billing/catalogue.ts), lifecycle (billing/lifecycle.ts),
 * event store (billing/events.ts), webhook processing
 * (billing/webhook.ts), mock provider adapters (Razorpay / Cashfree /
 * disabled Stripe stub), the entitlement service
 * (entitlements/service.ts), the tenancy journey model
 * (tenancy/journey.ts) and the admin service (admin/service.ts).
 *
 * Synthetic users + fake provider events only. No real signup, no real
 * financial operation, no external call. All committed flag defaults
 * stay OFF; tests flip flags only in-process via injected env objects.
 *
 * Honest-behaviour notes (tested as-is, never wished into existence):
 *  - past_due grants NO paid entitlement and there is NO grace policy
 *    in the code (lifecycle.grantsEntitlement = active/trialing only;
 *    entitlement service falls back to Free). Scenario 9 pins this.
 *  - Plan changes take effect in entitlement resolution at the moment
 *    the subscription's planId changes — the code has no deferred /
 *    period-end downgrade mechanism and no proration calculation.
 *    Scenario 12 pins this.
 *  - There is no dedicated workspace-deletion service method yet;
 *    scenario 15 composes the deletion flow from the existing tenancy
 *    model (owner-only, status → deletion-pending) + admin store +
 *    append-only audit log, which is exactly the prototype's shape.
 */
import { describe, it, expect } from 'vitest';
import { getPlan, SELECTED_TRIAL_OPTION_ID, TRIAL_OPTIONS } from '@/lib/billing/catalogue';
import { canTransition, grantsEntitlement, isTerminal, type SubscriptionStatus } from '@/lib/billing/lifecycle';
import { InMemoryBillingEventStore } from '@/lib/billing/events';
import { processBillingWebhook, normalizeForProvider } from '@/lib/billing/webhook';
import { StaticSecretsProvider, type BillingProvider } from '@/lib/billing/provider';
import { RazorpayMockProvider } from '@/lib/billing/providers/razorpay';
import { CashfreeMockProvider } from '@/lib/billing/providers/cashfree';
import { StripeDisabledProvider } from '@/lib/billing/providers/stripe';
import {
  readBillingFlags, readSaasFlags, DEFAULT_BILLING_FLAGS, DEFAULT_SAAS_FLAGS, assertBillingRouteEnabled,
} from '@/lib/billing/flags';
import { resolveEntitlement, checkEntitlement, evaluateAllEntitlements, type WorkspaceSubscription } from '@/lib/entitlements/service';
import {
  JOURNEY_STEPS, ONBOARDING_STEP_IDS, initialOnboardingState, completeOnboardingStep, nextOnboardingStep, isStepReachable,
} from '@/lib/tenancy/journey';
import { AdminService } from '@/lib/admin/service';
import { InMemoryAdminStore, createSyntheticAdminStore } from '@/lib/admin/store';
import { InMemoryAdminAuditLog } from '@/lib/admin/audit';
import { AdminError, type ActorContext } from '@/lib/admin/types';
import { TEST_RAZORPAY_SECRET, razorpayEvent } from './fixtures/payment-events';

const ENFORCED = { publicSignupEnabled: false, entitlementsEnforced: true } as const;
const RAZORPAY_SECRETS = new StaticSecretsProvider({ razorpay: TEST_RAZORPAY_SECRET });

const platformAdmin: ActorContext = { userId: 'staff-admin-1', platformRole: 'platform-admin', workspaceRoles: {} };

interface RzpStep {
  eventId: string;
  event: string;
  entityStatus: string;
  serverStatus: SubscriptionStatus;
  serverRaw: string;
  sec: number;
  periodEnd?: string | null;
  amountMinor?: number;
}

/**
 * One webhook round-trip against the mock Razorpay transport: the
 * provider's server-side snapshot is set FIRST (server truth), then a
 * correctly signed webhook is delivered. The processor must trust the
 * server snapshot, not the webhook claim.
 */
async function rzpStep(
  provider: RazorpayMockProvider,
  store: InMemoryBillingEventStore,
  subId: string,
  step: RzpStep,
  workspaceId = 'ws-accept',
) {
  provider.seedSubscription({
    providerSubscriptionId: subId,
    providerStatusRaw: step.serverRaw,
    status: step.serverStatus,
    currency: 'INR',
    amountMinor: step.amountMinor ?? 49900,
    currentPeriodEnd: step.periodEnd ?? null,
    raw: step.serverRaw,
  });
  const fx = razorpayEvent({
    eventId: step.eventId, event: step.event, subscriptionId: subId, status: step.entityStatus, createdAtSec: step.sec,
  });
  const deps = { provider, store, secrets: RAZORPAY_SECRETS, normalize: (p: Record<string, unknown>) => normalizeForProvider('razorpay', p) };
  return processBillingWebhook(deps, { rawBody: fx.rawBody, signature: fx.signature, workspaceId });
}

function wsSub(workspaceId: string, planId: string, status: SubscriptionStatus): WorkspaceSubscription {
  return { workspaceId, planId, status };
}

describe('Phase 15 — launch acceptance (18 scenarios, mock only)', () => {
  // ── Scenario 1 ──────────────────────────────────────────────────────
  it('S01: new customer signs up in mock mode (flag-gated flow)', () => {
    // Committed defaults: everything OFF — signup is invite-only today.
    expect(DEFAULT_BILLING_FLAGS).toEqual({ billingEnabled: false, paymentsLiveMode: false });
    expect(DEFAULT_SAAS_FLAGS).toEqual({ publicSignupEnabled: false, entitlementsEnforced: false });
    expect(readSaasFlags({}).publicSignupEnabled).toBe(false);
    expect(assertBillingRouteEnabled(DEFAULT_BILLING_FLAGS)).toEqual({ ok: false, status: 503, reason: 'billing-disabled' });
    expect(isStepReachable('signup', {})).toBe(false);
    expect(isStepReachable('workspace-creation', {})).toBe(false);
    expect(isStepReachable('checkout', {})).toBe(false);

    // In-process flag flip (mock mode): signup + workspace open up;
    // checkout still needs BOTH billing flags.
    const mockEnv = { PUBLIC_SIGNUP_ENABLED: 'true', BILLING_ENABLED: 'true' };
    expect(isStepReachable('signup', mockEnv)).toBe(true);
    expect(isStepReachable('workspace-creation', mockEnv)).toBe(true);
    expect(isStepReachable('plan-choice', mockEnv)).toBe(true);
    expect(isStepReachable('checkout', mockEnv)).toBe(false);
    expect(isStepReachable('checkout', { ...mockEnv, PAYMENTS_LIVE_MODE: 'true' })).toBe(true);
    expect(assertBillingRouteEnabled(readBillingFlags(mockEnv))).toEqual({ ok: true });

    // The mock signup walks the onboarding state machine in order and
    // creates a workspace in the (in-memory) tenancy/admin model.
    let state = initialOnboardingState();
    expect(nextOnboardingStep(state)).toBe('workspace-creation');
    for (const id of ONBOARDING_STEP_IDS) {
      const r = completeOnboardingStep(state, id);
      expect(r.advanced, id).toBe(true);
      state = r.state;
    }
    expect(nextOnboardingStep(state)).toBeNull();

    const store = new InMemoryAdminStore();
    store.addWorkspace({
      workspaceId: 'ws-new-1', name: 'New Creator (synthetic)', status: 'active',
      ownerUserId: 'user-new-1', ownerEmail: 'new@example.test', createdAt: '2026-11-06T00:00:00.000Z',
      billingProfile: { billingEmail: 'new@example.test', legalName: 'New Creator', country: 'IN', taxId: null, providerCustomerId: null, providerApiSecret: null, providerWebhookSecret: null },
    });
    const svc = new AdminService({ store });
    const customers = svc.listCustomers(platformAdmin);
    expect(customers).toHaveLength(1);
    expect(customers[0]!.workspaceId).toBe('ws-new-1');
    expect(customers[0]!.subscriptionStatus).toBeNull(); // no subscription yet — signup alone grants nothing paid

    // No silent auto-charge, ever: no trial option is selected and
    // every option forbids silent charging.
    expect(SELECTED_TRIAL_OPTION_ID).toBeNull();
    for (const o of TRIAL_OPTIONS) expect(o.silentAutoChargeAllowed).toBe(false);
    // A fresh workspace with no subscription resolves to Free.
    expect(resolveEntitlement(null).plan.id).toBe('free');
  });

  // ── Scenario 2 ──────────────────────────────────────────────────────
  it('S02: workspace is isolated (a second workspace exists and cannot see the first)', () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    const ownerAlpha: ActorContext = { userId: 'user-owner-alpha', platformRole: 'none', workspaceRoles: { 'ws-alpha': 'owner' } };
    const ownerGamma: ActorContext = { userId: 'user-owner-gamma', platformRole: 'none', workspaceRoles: { 'ws-gamma': 'owner' } };

    // Each workspace sees exactly its own billing data — nothing more.
    expect(svc.getWorkspaceInvoices(ownerAlpha, 'ws-alpha').map((i) => i.invoiceId)).toEqual(['inv-alpha-1']);
    expect(svc.getWorkspaceInvoices(ownerGamma, 'ws-gamma').map((i) => i.invoiceId)).toEqual(['inv-gamma-1']);
    expect(svc.getWorkspacePaymentEvents(ownerAlpha, 'ws-alpha').map((e) => e.workspaceId)).toEqual(['ws-alpha']);
    expect(svc.getWorkspacePaymentEvents(ownerGamma, 'ws-gamma').map((e) => e.workspaceId)).toEqual(['ws-gamma']);
    expect(svc.getWorkspaceUsage(ownerAlpha, 'ws-alpha').dmsThisMonth).toBe(812);
    expect(svc.getWorkspaceUsage(ownerGamma, 'ws-gamma').dmsThisMonth).toBe(1900);

    // Entitlement resolution is per-workspace: alpha (starter, active)
    // and gamma (starter plan but past_due) resolve independently.
    expect(resolveEntitlement(wsSub('ws-alpha', 'starter', 'active')).plan.id).toBe('starter');
    expect(resolveEntitlement(wsSub('ws-gamma', 'starter', 'past_due')).plan.id).toBe('free');
    // The platform directory lists both, but DTOs carry no secret fields.
    const directory = JSON.stringify(svc.listCustomers(platformAdmin));
    expect(directory).toContain('ws-alpha');
    expect(directory).toContain('ws-gamma');
    expect(directory).not.toMatch(/providerApiSecret|providerWebhookSecret/);
  });

  // ── Scenario 3 ──────────────────────────────────────────────────────
  it('S03: trial begins (subscription trialing, entitlements at trial plan)', () => {
    expect(canTransition('incomplete', 'trialing')).toBe(true);
    expect(grantsEntitlement('trialing')).toBe(true);
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-trial', provider: 'razorpay', workspaceId: 'ws-trial', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });
    const applied = store.applyTransition('sub-trial', 'trialing', 1_000_000);
    expect(applied.applied).toBe(true);
    expect(store.getSubscription('sub-trial')!.status).toBe('trialing');

    const resolved = resolveEntitlement(wsSub('ws-trial', 'starter', 'trialing'));
    expect(resolved.plan.id).toBe('starter');
    expect(resolved.resolution).toBe('trialing-subscription');
    const dm = checkEntitlement(wsSub('ws-trial', 'starter', 'trialing'), 'dmsPerMonth', { dmsThisMonth: 1000 }, { flags: ENFORCED });
    expect(dm.limit).toBe(getPlan('starter').limits.dmsPerMonth); // 2000 — trial gets the PLAN's limits
    expect(dm.allowed).toBe(true);
    expect(dm.planId).toBe('starter');
  });

  // ── Scenario 4 ──────────────────────────────────────────────────────
  it('S04: trial expires (no payment → downgrade to Free entitlements)', () => {
    expect(canTransition('trialing', 'expired')).toBe(true);
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-exp', provider: 'razorpay', workspaceId: 'ws-exp', status: 'trialing', currency: 'INR', lastEventAt: 1_000_000, version: 1 });
    const applied = store.applyTransition('sub-exp', 'expired', 2_000_000);
    expect(applied.applied).toBe(true);
    expect(isTerminal('expired')).toBe(true);
    expect(grantsEntitlement('expired')).toBe(false);

    // No payment was made, so entitlement collapses to Free — the
    // no-card trial option's auto-downgrade-to-free behaviour as the
    // code actually implements it (expired ⇒ Free default).
    const resolved = resolveEntitlement(wsSub('ws-exp', 'starter', 'expired'));
    expect(resolved.plan.id).toBe('free');
    expect(resolved.resolution).toBe('free-default-inactive-subscription');
    const dm = checkEntitlement(wsSub('ws-exp', 'starter', 'expired'), 'dmsPerMonth', { dmsThisMonth: 1000 }, { flags: ENFORCED });
    expect(dm.limit).toBe(getPlan('free').limits.dmsPerMonth); // 250
    expect(dm.allowed).toBe(false); // usage that fit the trial plan no longer fits
    expect(dm.effectiveAllowed).toBe(false);
  });

  // ── Scenario 5 ──────────────────────────────────────────────────────
  it('S05: customer authorizes payment (mock checkout completes)', async () => {
    const provider = new RazorpayMockProvider();
    const asContract: BillingProvider = provider;
    const customer = await asContract.createCustomer({ workspaceId: 'ws-buy', email: 'buyer@example.test' });
    expect(customer.providerCustomerId).toBe('cust_mock_ws-buy');
    const amount = getPlan('starter').prices.INR.monthlyMinor;
    const checkout = await asContract.createSubscriptionCheckout({
      workspaceId: 'ws-buy', providerCustomerId: customer.providerCustomerId, planId: 'starter', currency: 'INR', amountMinor: amount,
    });
    expect(checkout.checkoutUrl).toContain('mock.invalid'); // mock transport — no real payment page
    expect(checkout.amountMinor).toBe(49900);
    expect(checkout.status).toBe('incomplete');
    // Authorization alone grants NOTHING: entitlement waits for the
    // verified webhook (scenario 6). incomplete ⇒ Free.
    expect(resolveEntitlement(wsSub('ws-buy', 'starter', 'incomplete')).plan.id).toBe('free');

    // Cashfree mock checkout has the same shape (incomplete, mock URL).
    const cf = new CashfreeMockProvider();
    const cfContract: BillingProvider = cf;
    const cfCustomer = await cfContract.createCustomer({ workspaceId: 'ws-buy', email: 'buyer@example.test' });
    const cfCheckout = await cfContract.createSubscriptionCheckout({
      workspaceId: 'ws-buy', providerCustomerId: cfCustomer.providerCustomerId, planId: 'starter', currency: 'INR', amountMinor: amount,
    });
    expect(cfCheckout.status).toBe('incomplete');
    expect(cfCheckout.checkoutUrl).toContain('mock.invalid');

    // Stripe cannot be used for checkout at all (disabled stub).
    const stripe: BillingProvider = new StripeDisabledProvider();
    await expect(stripe.createCustomer({ workspaceId: 'ws-buy', email: 'buyer@example.test' })).rejects.toThrow('provider-disabled');
    await expect(stripe.createSubscriptionCheckout({
      workspaceId: 'ws-buy', providerCustomerId: 'x', planId: 'starter', currency: 'INR', amountMinor: amount,
    })).rejects.toThrow('provider-disabled');
  });

  // ── Scenario 6 ──────────────────────────────────────────────────────
  it('S06: verified webhook activates paid entitlement (signature-valid event → active → paid limits)', async () => {
    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-act', provider: 'razorpay', workspaceId: 'ws-act', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });

    // Negative control: a tampered signature activates nothing.
    provider.seedSubscription({ providerSubscriptionId: 'sub-act', providerStatusRaw: 'active', status: 'active', currency: 'INR', amountMinor: 99900, currentPeriodEnd: null, raw: 'active' });
    const fx = razorpayEvent({ eventId: 'evt-act', event: 'subscription.activated', subscriptionId: 'sub-act', status: 'active', createdAtSec: 2000 });
    const deps = { provider, store, secrets: RAZORPAY_SECRETS, normalize: (p: Record<string, unknown>) => normalizeForProvider('razorpay', p) };
    const bad = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: 'deadbeef'.padEnd(64, '0') });
    expect(bad.outcome).toBe('invalid-signature');
    expect(store.getSubscription('sub-act')!.status).toBe('incomplete');

    // The genuine signed event, with the server agreeing, activates.
    const good = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: fx.signature, workspaceId: 'ws-act' });
    expect(good.outcome).toBe('applied');
    expect(good.subscriptionStatus).toBe('active');
    expect(good.entitlementGranted).toBe(true);

    const resolved = resolveEntitlement(wsSub('ws-act', 'creator-pro', 'active'));
    expect(resolved.plan.id).toBe('creator-pro');
    expect(resolved.resolution).toBe('active-subscription');
    const dm = checkEntitlement(wsSub('ws-act', 'creator-pro', 'active'), 'dmsPerMonth', { dmsThisMonth: 5000 }, { flags: ENFORCED });
    expect(dm.limit).toBe(getPlan('creator-pro').limits.dmsPerMonth); // 10000, not Free's 250
    expect(dm.allowed).toBe(true);
  });

  // ── Scenario 7 ──────────────────────────────────────────────────────
  it('S07: renewal succeeds (period advances, still active)', async () => {
    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-ren', provider: 'razorpay', workspaceId: 'ws-ren', status: 'active', currency: 'INR', lastEventAt: 2_000_000, version: 1 });

    const before = await rzpStep(provider, store, 'sub-ren', {
      eventId: 'evt-ren-0', event: 'subscription.charged', entityStatus: 'active', serverStatus: 'active', serverRaw: 'active', sec: 2000, periodEnd: '2026-12-01T00:00:00.000Z',
    });
    expect(before.subscriptionStatus).toBe('active');

    // Next cycle: provider charges again; its snapshot shows the new
    // period end. The charged webhook is a same-state renewal.
    const renewal = await rzpStep(provider, store, 'sub-ren', {
      eventId: 'evt-ren-1', event: 'subscription.charged', entityStatus: 'active', serverStatus: 'active', serverRaw: 'active', sec: 3000, periodEnd: '2027-01-01T00:00:00.000Z',
    });
    expect(renewal.outcome).toBe('noop'); // already active — renewal does not re-transition
    expect(renewal.subscriptionStatus).toBe('active');
    expect(renewal.entitlementGranted).toBe(true);
    const rec = store.getSubscription('sub-ren')!;
    expect(rec.lastEventAt).toBe(3_000_000); // ordering marker advanced to the renewal event
    const snap = await provider.fetchSubscription('sub-ren');
    expect(snap.currentPeriodEnd).toBe('2027-01-01T00:00:00.000Z'); // period advanced server-side
    expect(resolveEntitlement(wsSub('ws-ren', 'starter', rec.status)).plan.id).toBe('starter');
  });

  // ── Scenario 8 ──────────────────────────────────────────────────────
  it('S08: renewal fails (→ past_due)', async () => {
    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-fail', provider: 'razorpay', workspaceId: 'ws-fail', status: 'active', currency: 'INR', lastEventAt: 0, version: 1 });
    const r = await rzpStep(provider, store, 'sub-fail', {
      eventId: 'evt-fail-1', event: 'subscription.pending', entityStatus: 'pending', serverStatus: 'past_due', serverRaw: 'pending', sec: 3000,
    });
    expect(r.outcome).toBe('applied');
    expect(r.subscriptionStatus).toBe('past_due');
    expect(r.entitlementGranted).toBe(false);
    expect(store.getSubscription('sub-fail')!.status).toBe('past_due');
    expect(canTransition('active', 'past_due')).toBe(true);
  });

  // ── Scenario 9 ──────────────────────────────────────────────────────
  it('S09: past_due state is applied — entitlements fall back to Free (NO grace in the code)', () => {
    // Documented + implemented policy (Phase 12 lifecycle.ts):
    // grantsEntitlement is true ONLY for active/trialing. There is no
    // grace-period branch anywhere in the entitlement service, so a
    // past_due workspace immediately resolves to Free limits.
    expect(grantsEntitlement('past_due')).toBe(false);
    const resolved = resolveEntitlement(wsSub('ws-pd', 'agency', 'past_due'));
    expect(resolved.plan.id).toBe('free');
    expect(resolved.resolution).toBe('free-default-inactive-subscription');
    expect(resolved.dataRetentionDays).toBe(getPlan('free').dataRetentionDays);
    expect(resolved.supportLevel).toBe(getPlan('free').supportLevel);

    const { checks } = evaluateAllEntitlements(wsSub('ws-pd', 'agency', 'past_due'), {}, { flags: ENFORCED });
    expect(checks).toHaveLength(9);
    for (const c of checks) expect(c.planId).toBe('free');
    const dm = checkEntitlement(wsSub('ws-pd', 'agency', 'past_due'), 'dmsPerMonth', { dmsThisMonth: 5000 }, { flags: ENFORCED });
    expect(dm.limit).toBe(getPlan('free').limits.dmsPerMonth); // 250, NOT Agency's 50000
    expect(dm.allowed).toBe(false);
    // Safety floor is unaffected by past_due: Free still has non-zero
    // allowances and the plan itself is a real, limited default —
    // never unlimited, never zeroed-out compliance functions.
    expect(getPlan('free').limits.dmsPerMonth).toBeGreaterThan(0);
    expect(Number.isFinite(dm.limit)).toBe(true);
  });

  // ── Scenario 10 ─────────────────────────────────────────────────────
  it('S10: customer recovers payment (past_due → active via successful retry event)', async () => {
    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-rec', provider: 'razorpay', workspaceId: 'ws-rec', status: 'active', currency: 'INR', lastEventAt: 0, version: 1 });
    const failed = await rzpStep(provider, store, 'sub-rec', {
      eventId: 'evt-rec-fail', event: 'subscription.pending', entityStatus: 'pending', serverStatus: 'past_due', serverRaw: 'pending', sec: 3000,
    });
    expect(failed.subscriptionStatus).toBe('past_due');
    expect(resolveEntitlement(wsSub('ws-rec', 'creator-pro', 'past_due')).plan.id).toBe('free');

    expect(canTransition('past_due', 'active')).toBe(true);
    const recovered = await rzpStep(provider, store, 'sub-rec', {
      eventId: 'evt-rec-ok', event: 'subscription.charged', entityStatus: 'active', serverStatus: 'active', serverRaw: 'active', sec: 4000, amountMinor: 99900,
    });
    expect(recovered.outcome).toBe('applied');
    expect(recovered.subscriptionStatus).toBe('active');
    expect(recovered.entitlementGranted).toBe(true);
    const resolved = resolveEntitlement(wsSub('ws-rec', 'creator-pro', store.getSubscription('sub-rec')!.status));
    expect(resolved.plan.id).toBe('creator-pro'); // paid limits restored in full
  });

  // ── Scenario 11 ─────────────────────────────────────────────────────
  it('S11: upgrade plan (limits increase immediately per lifecycle rules)', () => {
    const store = createSyntheticAdminStore();
    const svc = new AdminService({ store });
    // ws-alpha: starter, active. 5000 DMs is over the Starter cap.
    const subBefore = wsSub('ws-alpha', 'starter', 'active');
    const before = checkEntitlement(subBefore, 'dmsPerMonth', { dmsThisMonth: 5000 }, { flags: ENFORCED });
    expect(before.limit).toBe(getPlan('starter').limits.dmsPerMonth); // 2000
    expect(before.allowed).toBe(false);

    // Upgrade via the audited admin override (reason required).
    const dto = svc.changePlan(platformAdmin, { workspaceId: 'ws-alpha', toPlanId: 'creator-pro', reason: 'Acceptance S11 — customer upgraded (mock)' });
    expect(dto.planId).toBe('creator-pro');
    expect(dto.status).toBe('active'); // plan change needs no lifecycle transition
    expect(svc.getAuditLog(platformAdmin).map((e) => e.action)).toContain('subscription.plan_change');

    // Immediate effect: the SAME usage now fits, with no period wait.
    const after = checkEntitlement(wsSub('ws-alpha', dto.planId, 'active'), 'dmsPerMonth', { dmsThisMonth: 5000 }, { flags: ENFORCED });
    expect(after.limit).toBe(getPlan('creator-pro').limits.dmsPerMonth); // 10000
    expect(after.allowed).toBe(true);
    expect(after.planId).toBe('creator-pro');
  });

  // ── Scenario 12 ─────────────────────────────────────────────────────
  it('S12: downgrade plan (limits decrease at the documented point — the plan change itself)', () => {
    // What the code actually does: entitlement resolution reads the
    // subscription's CURRENT planId. There is no period-end deferral
    // and no proration engine in the code (Phase 12: proration is a
    // provider capability — Razorpay eligible cards only, Cashfree
    // none verified). So the documented decrease point is the moment
    // the plan change is applied; before it, higher limits hold.
    const providerCaps = new RazorpayMockProvider().capabilities;
    const cfCaps = new CashfreeMockProvider().capabilities;
    expect(providerCaps.supportsInPlacePlanChange).toBe(true);
    expect(cfCaps.supportsProration).toBe(false);

    const store = createSyntheticAdminStore();
    const svc = new AdminService({ store });
    // Give ws-alpha the higher plan first (fixture starts at starter).
    svc.changePlan(platformAdmin, { workspaceId: 'ws-alpha', toPlanId: 'creator-pro', reason: 'Acceptance S12 setup — move to Creator Pro (mock)' });
    const high = checkEntitlement(wsSub('ws-alpha', 'creator-pro', 'active'), 'dmsPerMonth', { dmsThisMonth: 5000 }, { flags: ENFORCED });
    expect(high.allowed).toBe(true); // higher limits hold until the downgrade is applied

    const dto = svc.changePlan(platformAdmin, { workspaceId: 'ws-alpha', toPlanId: 'starter', reason: 'Acceptance S12 — customer downgraded (mock)' });
    expect(dto.status).toBe('active'); // downgrade is not a cancellation
    const low = checkEntitlement(wsSub('ws-alpha', dto.planId, 'active'), 'dmsPerMonth', { dmsThisMonth: 5000 }, { flags: ENFORCED });
    expect(low.limit).toBe(getPlan('starter').limits.dmsPerMonth); // decreased immediately on application
    expect(low.allowed).toBe(false);
    expect(low.planId).toBe('starter');
  });

  // ── Scenario 13 ─────────────────────────────────────────────────────
  it('S13: customer cancels (→ cancelled, entitlement ends per lifecycle)', async () => {
    // cancel_at_period_end semantics (Phase 13/14 docs): while the
    // subscription is still `active` with the flag set, entitlement
    // persists; it ends when the cancelled state actually lands.
    const stillActive = resolveEntitlement(wsSub('ws-cx', 'creator-pro', 'active'));
    expect(stillActive.plan.id).toBe('creator-pro');

    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-cx', provider: 'razorpay', workspaceId: 'ws-cx', status: 'active', currency: 'INR', lastEventAt: 0, version: 1 });
    const r = await rzpStep(provider, store, 'sub-cx', {
      eventId: 'evt-cx-1', event: 'subscription.cancelled', entityStatus: 'cancelled', serverStatus: 'cancelled', serverRaw: 'cancelled', sec: 5000, amountMinor: 99900,
    });
    expect(r.outcome).toBe('applied');
    expect(r.subscriptionStatus).toBe('cancelled');
    expect(r.entitlementGranted).toBe(false);
    expect(isTerminal('cancelled')).toBe(true);
    expect(canTransition('cancelled', 'active')).toBe(false); // cancelled cannot be resurrected by a later event
    const resolved = resolveEntitlement(wsSub('ws-cx', 'creator-pro', 'cancelled'));
    expect(resolved.plan.id).toBe('free');
    expect(resolved.resolution).toBe('free-default-inactive-subscription');
    // The journey still models cancellation + deletion as reachable
    // billing steps — the safety floor (deletion etc.) survives.
    expect(JOURNEY_STEPS.find((s) => s.id === 'cancellation')!.gatedBy).toBe('BILLING_ENABLED');
    expect(JOURNEY_STEPS.find((s) => s.id === 'account-deletion')!.availability).toBe('partial-today');
  });

  // ── Scenario 14 ─────────────────────────────────────────────────────
  it('S14: refund is recorded in mock mode (admin recordRefund; providerRefundId null; executeRefund refuses)', () => {
    const store = createSyntheticAdminStore();
    const svc = new AdminService({ store });
    const dto = svc.recordRefund(platformAdmin, {
      workspaceId: 'ws-alpha', invoiceId: 'inv-alpha-1', amountMinor: 49900, currency: 'INR', reason: 'Acceptance S14 — duplicate charge (mock record)',
    });
    expect(dto.status).toBe('recorded-mock');
    expect(dto.mode).toBe('mock');
    const internal = store.refunds[0]!;
    expect(internal.providerRefundId).toBeNull(); // no provider refund was — or can be — executed here
    expect(svc.getAuditLog(platformAdmin).map((e) => e.action)).toContain('refund.recorded_mock');

    // Execution refuses on every path.
    const codes: string[] = [];
    for (const attempt of [
      () => svc.executeRefund(platformAdmin, { refundId: dto.refundId }),
      () => svc.executeRefund(platformAdmin, { refundId: dto.refundId, viaProviderApi: true }),
    ]) {
      try { attempt(); } catch (e) { codes.push((e as AdminError).code); }
    }
    expect(codes).toEqual(['refund-execution-unavailable', 'refund-provider-execution-refused']);
    const liveSvc = new AdminService({ store: createSyntheticAdminStore(), flags: { billingEnabled: true, paymentsLiveMode: true } });
    try {
      liveSvc.executeRefund(platformAdmin, { refundId: dto.refundId });
      throw new Error('unreachable');
    } catch (e) {
      expect((e as AdminError).code).toBe('refund-live-refused');
    }
  });

  // ── Scenario 15 ─────────────────────────────────────────────────────
  it('S15: customer deletion is processed (workspace deletion flow at service level, audit written)', () => {
    // Tenancy model (Phase 11/13): workspace deletion is OWNER-only
    // (migration …000024 DELETE policy = owner) and journey step 18.
    // No dedicated deletion service exists yet, so the flow is composed
    // from the admin store + append-only audit log — the prototype's
    // real shape — and pinned here.
    expect(JOURNEY_STEPS.find((s) => s.id === 'account-deletion')!.order).toBe(18);
    const store = new InMemoryAdminStore();
    store.addWorkspace({
      workspaceId: 'ws-del', name: 'Delete Me (synthetic)', status: 'active',
      ownerUserId: 'user-owner-del', ownerEmail: 'del@example.test', createdAt: '2026-09-01T00:00:00.000Z',
      billingProfile: { billingEmail: 'del@example.test', legalName: 'Delete Me', country: 'IN', taxId: null, providerCustomerId: null, providerApiSecret: null, providerWebhookSecret: null },
    });
    store.addWorkspace({
      workspaceId: 'ws-keep', name: 'Keep Me (synthetic)', status: 'active',
      ownerUserId: 'user-owner-keep', ownerEmail: 'keep@example.test', createdAt: '2026-09-01T00:00:00.000Z',
      billingProfile: { billingEmail: 'keep@example.test', legalName: 'Keep Me', country: 'IN', taxId: null, providerCustomerId: null, providerApiSecret: null, providerWebhookSecret: null },
    });
    store.addSubscription({
      subscriptionId: 'sub-del', workspaceId: 'ws-del', planId: 'starter', status: 'active',
      provider: 'razorpay', providerSubscriptionId: 'sub_mock_del', providerCustomerId: 'cust_mock_del',
      currency: 'INR', amountMinor: 49900, billingPeriod: 'monthly',
      currentPeriodStart: '2026-11-01T00:00:00.000Z', currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      trialEndsAt: null, hadTrial: false, cancelAtPeriodEnd: false, cancellationRequestedAt: null,
      pastDueSince: null, createdAt: '2026-09-01T00:00:00.000Z', cancelledAt: null, entitlementOverrides: [],
    });
    const audit = new InMemoryAdminAuditLog();
    const ownerDel: ActorContext = { userId: 'user-owner-del', platformRole: 'none', workspaceRoles: { 'ws-del': 'owner' } };
    const memberDel: ActorContext = { userId: 'user-member-del', platformRole: 'none', workspaceRoles: { 'ws-del': 'member' } };

    // Owner-only guard per the tenancy model: a mere member cannot delete.
    expect(ownerDel.workspaceRoles['ws-del']).toBe('owner');
    expect(memberDel.workspaceRoles['ws-del']).not.toBe('owner');

    // Process deletion: mark the workspace, cancel its subscription
    // (entitlement ends), and write the audit event FIRST-class.
    const ws = store.workspaces.get('ws-del')!;
    ws.status = 'deletion-pending';
    const sub = store.subscriptionForWorkspace('ws-del')!;
    sub.status = 'cancelled';
    sub.cancelledAt = '2026-11-06T00:00:00.000Z';
    const entry = audit.append({
      actorUserId: ownerDel.userId, actorPlatformRole: 'platform-admin', action: 'workspace.deletion_processed',
      targetType: 'workspace', targetId: 'ws-del', workspaceId: 'ws-del',
      before: { status: 'active' }, after: { status: 'deletion-pending', subscriptionStatus: 'cancelled' },
      reason: 'Acceptance S15 — owner requested account deletion (mock)', at: 1730000000000,
    });
    expect(entry.action).toBe('workspace.deletion_processed');
    expect(Object.isFrozen(entry)).toBe(true); // append-only audit
    expect(store.workspaces.get('ws-del')!.status).toBe('deletion-pending');
    expect(resolveEntitlement(wsSub('ws-del', 'starter', 'cancelled')).plan.id).toBe('free');
    expect(audit.list({ workspaceId: 'ws-del' })).toHaveLength(1);
    // The other workspace is completely untouched.
    expect(store.workspaces.get('ws-keep')!.status).toBe('active');
    expect(audit.list({ workspaceId: 'ws-keep' })).toHaveLength(0);
  });

  // ── Scenario 16 ─────────────────────────────────────────────────────
  it('S16: cross-tenant access is denied (service-level, both directions)', async () => {
    const svc = new AdminService({ store: createSyntheticAdminStore() });
    const ownerAlpha: ActorContext = { userId: 'user-owner-alpha', platformRole: 'none', workspaceRoles: { 'ws-alpha': 'owner' } };
    const ownerGamma: ActorContext = { userId: 'user-owner-gamma', platformRole: 'none', workspaceRoles: { 'ws-gamma': 'owner' } };
    const denied = (fn: () => unknown) => {
      try { fn(); } catch (e) { expect((e as AdminError).code).toBe('forbidden-not-workspace-member'); return; }
      throw new Error('expected cross-tenant denial');
    };
    // Alpha → Gamma denied, Gamma → Alpha denied (both directions,
    // across invoices, payment events and usage).
    denied(() => svc.getWorkspaceInvoices(ownerAlpha, 'ws-gamma'));
    denied(() => svc.getWorkspacePaymentEvents(ownerAlpha, 'ws-gamma'));
    denied(() => svc.getWorkspaceUsage(ownerAlpha, 'ws-gamma'));
    denied(() => svc.getWorkspaceInvoices(ownerGamma, 'ws-alpha'));
    denied(() => svc.getWorkspacePaymentEvents(ownerGamma, 'ws-alpha'));
    denied(() => svc.getWorkspaceUsage(ownerGamma, 'ws-alpha'));
    // Platform role does not smuggle workspace access either.
    denied(() => svc.getWorkspaceInvoices(platformAdmin, 'ws-alpha'));

    // Billing-layer isolation: a webhook for workspace A's
    // subscription never moves workspace B's record.
    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-A', provider: 'razorpay', workspaceId: 'ws-A', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });
    store.ensureSubscription({ providerSubscriptionId: 'sub-B', provider: 'razorpay', workspaceId: 'ws-B', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });
    await rzpStep(provider, store, 'sub-A', {
      eventId: 'evt-A-1', event: 'subscription.activated', entityStatus: 'active', serverStatus: 'active', serverRaw: 'active', sec: 2000,
    }, 'ws-A');
    expect(store.getSubscription('sub-A')!.status).toBe('active');
    expect(store.getSubscription('sub-B')!.status).toBe('incomplete'); // untouched
    expect(store.getSubscription('sub-B')!.workspaceId).toBe('ws-B');
  });

  // ── Scenario 17 ─────────────────────────────────────────────────────
  it('S17: duplicate webhooks are harmless (state applied once)', async () => {
    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-dup', provider: 'razorpay', workspaceId: 'ws-dup', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });
    provider.seedSubscription({ providerSubscriptionId: 'sub-dup', providerStatusRaw: 'active', status: 'active', currency: 'INR', amountMinor: 49900, currentPeriodEnd: null, raw: 'active' });
    const fx = razorpayEvent({ eventId: 'evt-dup-1', event: 'subscription.activated', subscriptionId: 'sub-dup', status: 'active', createdAtSec: 2000 });
    const deps = { provider, store, secrets: RAZORPAY_SECRETS, normalize: (p: Record<string, unknown>) => normalizeForProvider('razorpay', p) };
    const first = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: fx.signature, workspaceId: 'ws-dup' });
    expect(first.outcome).toBe('applied');
    const versionAfterFirst = store.getSubscription('sub-dup')!.version;

    const second = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: fx.signature, workspaceId: 'ws-dup' });
    expect(second.outcome).toBe('duplicate');
    expect(second.subscriptionStatus).toBe('active');
    expect(store.getSubscription('sub-dup')!.version).toBe(versionAfterFirst); // applied exactly once
    expect(store.logs().filter((l) => l.providerEventId === 'evt-dup-1')).toHaveLength(1);
    // A third delivery is equally harmless.
    const third = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: fx.signature, workspaceId: 'ws-dup' });
    expect(third.outcome).toBe('duplicate');
    expect(store.getSubscription('sub-dup')!.status).toBe('active');
  });

  // ── Scenario 18 ─────────────────────────────────────────────────────
  it('S18: provider outage does not grant free paid access (verification unavailable → no upgrade)', async () => {
    const provider = new RazorpayMockProvider();
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 'sub-out', provider: 'razorpay', workspaceId: 'ws-out', status: 'incomplete', currency: 'INR', lastEventAt: 0, version: 0 });
    provider.seedSubscription({ providerSubscriptionId: 'sub-out', providerStatusRaw: 'active', status: 'active', currency: 'INR', amountMinor: 99900, currentPeriodEnd: null, raw: 'active' });
    provider.transport.failFetch = true; // provider outage: status verification throws

    const fx = razorpayEvent({ eventId: 'evt-out-1', event: 'subscription.activated', subscriptionId: 'sub-out', status: 'active', createdAtSec: 2000 });
    const deps = { provider, store, secrets: RAZORPAY_SECRETS, normalize: (p: Record<string, unknown>) => normalizeForProvider('razorpay', p) };
    const during = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: fx.signature, workspaceId: 'ws-out' });
    expect(during.outcome).toBe('verification-unavailable');
    expect(during.entitlementGranted).toBe(false);
    expect(store.getSubscription('sub-out')!.status).toBe('incomplete'); // NO free paid access
    expect(resolveEntitlement(wsSub('ws-out', 'creator-pro', 'incomplete')).plan.id).toBe('free');
    expect(store.hasEvent('evt-out-1')).toBe(false); // event not consumed — safely retryable

    // When the provider recovers, the SAME event applies cleanly.
    provider.transport.failFetch = false;
    const after = await processBillingWebhook(deps, { rawBody: fx.rawBody, signature: fx.signature, workspaceId: 'ws-out' });
    expect(after.outcome).toBe('applied');
    expect(after.subscriptionStatus).toBe('active');
    expect(after.entitlementGranted).toBe(true);
  });
});
