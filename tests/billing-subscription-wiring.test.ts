/**
 * SaaS subscription wiring (2026-11-08) — the "last mile":
 *   checkout bound to the caller's workspace + orders persisted,
 *   the public Razorpay webhook activating entitlements through the
 *   Phase 12 core, the no-card trial flow with lapse, and the billing
 *   status read model (catalogue limits flowing into entitlements).
 *
 * Everything uses SYNTHETIC keys, an in-memory fake Supabase and a
 * stubbed fetch — no real Razorpay account, no network, no database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createFakeSupabase, type FakeSupabase } from './helpers/fake-supabase';

// ── Module mocks: auth + service-role client ────────────────────────────
const holder = vi.hoisted(() => ({
  db: null as unknown,
  user: null as { id: string; email?: string } | null,
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => holder.db,
}));
vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: async () => holder.user,
  unauthorized: () =>
    Response.json({ error: 'Unauthorized', message: 'Valid session required' }, { status: 401 }),
}));

import { POST as checkoutPOST } from '@/app/api/billing/checkout/route';
import { POST as webhookPOST } from '@/app/api/billing/webhook/route';
import { POST as trialPOST } from '@/app/api/billing/trial/route';
import { GET as statusGET } from '@/app/api/billing/status/route';
import {
  evaluateTrialStart,
  trialWindow,
  trialDaysRemaining,
  applyTrialLapse,
  isTrialLapsed,
} from '@/lib/billing/trial';
import { RazorpayLiveProvider } from '@/lib/billing/liveProvider';
import { readRazorpayConfig } from '@/lib/billing/razorpay';

// ── Fixtures ────────────────────────────────────────────────────────────
const KEY_ID = 'rzp_test_synthetic123';
const KEY_SECRET = 'synthetic-key-secret';
const WH_SECRET = 'synthetic-webhook-secret';

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const MEMBER = { id: 'user-member', email: 'member@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'outsider@example.com' };
const OWNER2 = { id: 'user-owner2', email: 'owner2@example.com' };
const SINGLE = { id: 'user-single', email: 'single@example.com' };

const WS1 = 'ws-1';
const WS2 = 'ws-2';
const WS3 = 'ws-3';
const WS4 = 'ws-4';
const WS5 = 'ws-5';

let fake: FakeSupabase;

function baseSeed() {
  return {
    workspace_memberships: [
      { workspace_id: WS1, user_id: OWNER.id, role: 'owner' },
      { workspace_id: WS1, user_id: MEMBER.id, role: 'member' },
      { workspace_id: WS2, user_id: OWNER2.id, role: 'owner' },
      { workspace_id: WS3, user_id: OWNER2.id, role: 'owner' },
      { workspace_id: WS4, user_id: OWNER2.id, role: 'owner' },
      { workspace_id: WS5, user_id: SINGLE.id, role: 'owner' },
    ],
    subscriptions: [] as Record<string, unknown>[],
    billing_orders: [] as Record<string, unknown>[],
    billing_events: [] as Record<string, unknown>[],
  };
}

// ── Razorpay fetch stub ─────────────────────────────────────────────────
interface StubOrder { status: string; amount: number; amount_paid: number; currency: string }
const razorpayOrders = new Map<string, StubOrder>();
let orderCounter = 0;
let razorpayDown = false;

function stubRazorpayFetch() {
  vi.stubGlobal('fetch', async (url: string, init: Record<string, unknown>) => {
    const u = String(url);
    if (u.endsWith('/v1/orders') && init.method === 'POST') {
      const sent = JSON.parse(init.body as string) as { amount: number; currency: string };
      orderCounter += 1;
      const id = `order_test_${orderCounter}`;
      razorpayOrders.set(id, { status: 'created', amount: sent.amount, amount_paid: 0, currency: sent.currency });
      return {
        ok: true, status: 200,
        json: async () => ({
          id, entity: 'order', amount: sent.amount, amount_paid: 0, amount_due: sent.amount,
          currency: sent.currency, receipt: 'opdm_x', status: 'created', attempts: 0, created_at: 1762000000,
        }),
      };
    }
    const m = u.match(/\/v1\/orders\/([^/]+)$/);
    if (m && (init.method === 'GET' || init.method === undefined)) {
      if (razorpayDown) throw new Error('provider unreachable (stub)');
      const order = razorpayOrders.get(m[1]!);
      if (!order) {
        return { ok: false, status: 404, json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'order not found' } }) };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          id: m[1], entity: 'order', amount: order.amount, amount_paid: order.amount_paid,
          amount_due: order.amount - order.amount_paid, currency: order.currency,
          status: order.status, attempts: 1, created_at: 1762000000,
        }),
      };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  });
}

// ── Env management ──────────────────────────────────────────────────────
const ENV_KEYS = ['BILLING_ENABLED', 'PAYMENTS_LIVE_MODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const;
let savedEnv: Record<string, string | undefined> = {};
const FULL_ENV: Record<string, string> = {
  BILLING_ENABLED: 'true',
  PAYMENTS_LIVE_MODE: 'true',
  RAZORPAY_KEY_ID: KEY_ID,
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WH_SECRET,
};
function setEnv(values: Record<string, string>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  fake = createFakeSupabase(baseSeed());
  holder.db = fake.client;
  holder.user = OWNER;
  razorpayOrders.clear();
  orderCounter = 0;
  razorpayDown = false;
  stubRazorpayFetch();
  setEnv(FULL_ENV);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

// ── Request helpers ─────────────────────────────────────────────────────
function jsonPost(url: string, payload: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
const checkoutReq = (payload: unknown) => jsonPost('https://app.opendm.in/api/billing/checkout', payload);
const trialReq = (payload: unknown) => jsonPost('https://app.opendm.in/api/billing/trial', payload);
function statusReq(ws?: string): Request {
  return new Request('https://app.opendm.in/api/billing/status', {
    headers: ws ? { 'x-workspace-id': ws } : {},
  });
}
function sign(body: string, secret = WH_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
function webhookReq(payload: unknown, opts: { signature?: string; rawBody?: string } = {}): Request {
  const rawBody = opts.rawBody ?? JSON.stringify(payload);
  return new Request('https://app.opendm.in/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': opts.signature ?? sign(rawBody) },
    body: rawBody,
  });
}
function capturedPayload(orderId: string, paymentId: string, amount = 50000) {
  return {
    event: 'payment.captured',
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured' },
      },
    },
  };
}
async function doCheckout(planId: string, workspaceId: string): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await checkoutPOST(checkoutReq({ planId, workspaceId }));
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

// ══ 1. Trial domain logic (pure) ════════════════════════════════════════
describe('trial domain logic', () => {
  const now = new Date('2026-11-08T06:00:00.000Z');

  it('window is exactly TRIAL_DAYS (15) long', () => {
    const w = trialWindow(now);
    expect(w.startsAt.toISOString()).toBe(now.toISOString());
    expect((w.endsAt.getTime() - w.startsAt.getTime()) / 86_400_000).toBe(15);
  });

  it('days remaining ceils partial days and floors at 0', () => {
    expect(trialDaysRemaining(new Date(now.getTime() + 15 * 86_400_000).toISOString(), now)).toBe(15);
    expect(trialDaysRemaining(new Date(now.getTime() + 36 * 3_600_000).toISOString(), now)).toBe(2);
    expect(trialDaysRemaining(new Date(now.getTime() - 1000).toISOString(), now)).toBe(0);
    expect(trialDaysRemaining(null, now)).toBe(0);
  });

  it('trial start decisions follow the one-trial policy', () => {
    expect(evaluateTrialStart(null, 'starter').ok).toBe(true);
    expect(evaluateTrialStart({ planId: 'free', status: 'free', trialEndsAt: null }, 'starter').ok).toBe(true);
    expect(evaluateTrialStart(null, 'free')).toMatchObject({ ok: false, code: 'TRIAL_NOT_AVAILABLE' });
    expect(evaluateTrialStart(null, 'enterprise')).toMatchObject({ ok: false, code: 'TRIAL_NOT_AVAILABLE' });
    expect(evaluateTrialStart({ planId: 'starter', status: 'active', trialEndsAt: null }, 'agency'))
      .toMatchObject({ ok: false, code: 'ALREADY_SUBSCRIBED' });
    expect(evaluateTrialStart({ planId: 'starter', status: 'trialing', trialEndsAt: '2026-11-20T00:00:00Z' }, 'agency'))
      .toMatchObject({ ok: false, code: 'ALREADY_TRIALING' });
    expect(evaluateTrialStart({ planId: 'starter', status: 'expired', trialEndsAt: '2026-11-01T00:00:00Z' }, 'starter'))
      .toMatchObject({ ok: false, code: 'TRIAL_ALREADY_USED' });
    expect(evaluateTrialStart({ planId: 'starter', status: 'cancelled', trialEndsAt: null }, 'starter').ok).toBe(true);
  });

  it('lapse: only a trialing row past its end lapses, and it resolves as expired', () => {
    const lapsed = { planId: 'starter', status: 'trialing' as const, trialEndsAt: '2026-11-07T00:00:00Z' };
    expect(isTrialLapsed(lapsed, now)).toBe(true);
    expect(applyTrialLapse(lapsed, now)?.status).toBe('expired');
    const running = { planId: 'starter', status: 'trialing' as const, trialEndsAt: '2026-11-20T00:00:00Z' };
    expect(applyTrialLapse(running, now)?.status).toBe('trialing');
    const paid = { planId: 'starter', status: 'active' as const, trialEndsAt: '2026-11-01T00:00:00Z' };
    expect(applyTrialLapse(paid, now)?.status).toBe('active');
  });
});

// ══ 2. Live provider adapter ════════════════════════════════════════════
describe('RazorpayLiveProvider', () => {
  const cfg = readRazorpayConfig({ RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET });

  it('normalizes payment.captured with a stable, redelivery-proof event id', () => {
    const p = capturedPayload('order_9', 'pay_9');
    const a = RazorpayLiveProvider.normalizeEvent(p);
    const b = RazorpayLiveProvider.normalizeEvent(p);
    expect(a).toMatchObject({
      providerEventId: 'payment.captured:pay_9',
      providerSubscriptionId: 'order_9',
      type: 'subscription_activated',
      claimedStatus: 'active',
      amountMinor: 50000,
    });
    expect(b?.providerEventId).toBe(a?.providerEventId);
  });

  it('normalizes payment.failed and order.paid; ignores unrelated events', () => {
    const failed = RazorpayLiveProvider.normalizeEvent({
      event: 'payment.failed', created_at: 1762000000,
      payload: { payment: { entity: { id: 'pay_f', order_id: 'order_9', amount: 100, currency: 'INR' } } },
    });
    expect(failed).toMatchObject({ type: 'payment_failed', providerEventId: 'payment.failed:pay_f', claimedStatus: null });
    const paid = RazorpayLiveProvider.normalizeEvent({
      event: 'order.paid', created_at: 1762000000,
      payload: { order: { entity: { id: 'order_9', amount_paid: 50000, currency: 'INR' } }, payment: { entity: { id: 'pay_9' } } },
    });
    expect(paid).toMatchObject({ type: 'subscription_activated', providerSubscriptionId: 'order_9', providerEventId: 'order.paid:pay_9' });
    expect(RazorpayLiveProvider.normalizeEvent({ event: 'refund.created', payload: {} })).toBeNull();
  });

  it('fetchSubscription believes Razorpay, not the caller: paid → active, created → incomplete', async () => {
    razorpayOrders.set('order_paid', { status: 'paid', amount: 50000, amount_paid: 50000, currency: 'INR' });
    razorpayOrders.set('order_open', { status: 'created', amount: 50000, amount_paid: 0, currency: 'INR' });
    const provider = new RazorpayLiveProvider(cfg);
    expect(await provider.fetchSubscription('order_paid')).toMatchObject({ status: 'active', amountMinor: 50000 });
    expect(await provider.fetchSubscription('order_open')).toMatchObject({ status: 'incomplete' });
  });

  it('webhook signature verification accepts the genuine HMAC and rejects forgeries', () => {
    const provider = new RazorpayLiveProvider(cfg);
    const body = JSON.stringify({ event: 'payment.captured' });
    expect(provider.verifyWebhookSignature(body, sign(body), WH_SECRET)).toBe(true);
    expect(provider.verifyWebhookSignature(body, sign(body, 'wrong-secret'), WH_SECRET)).toBe(false);
    expect(provider.verifyWebhookSignature(body + ' ', sign(body), WH_SECRET)).toBe(false);
  });
});

// ══ 3. Checkout workspace binding ═══════════════════════════════════════
describe('POST /api/billing/checkout — workspace binding', () => {
  it('stays inert (503) with flags off, before any auth work', async () => {
    setEnv({});
    holder.user = null;
    const res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(503);
  });

  it('requires authentication once billing is on', async () => {
    holder.user = null;
    const res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(401);
  });

  it('refuses a non-member (403 not-a-member) and a non-owner member (403 insufficient-role)', async () => {
    holder.user = OUTSIDER;
    let res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('not-a-member');

    holder.user = MEMBER;
    res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('insufficient-role');
    expect(fake.rows('billing_orders')).toHaveLength(0);
  });

  it('owner checkout persists the order against the workspace (₹500 Growth = 50000)', async () => {
    const { res, body } = await doCheckout('creator-pro', WS1);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, workspaceId: WS1, planId: 'creator-pro' });
    const orders = fake.rows('billing_orders');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      workspace_id: WS1, provider: 'razorpay', provider_order_id: 'order_test_1',
      plan_id: 'creator-pro', amount_minor: 50000, currency: 'INR', status: 'created',
    });
    expect(JSON.stringify(body)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(body)).not.toContain(WH_SECRET);
  });

  it('resolves the single-membership default when no selector is given', async () => {
    holder.user = SINGLE;
    const res = await checkoutPOST(checkoutReq({ planId: 'starter' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(WS5);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ workspace_id: WS5 });
  });

  it('refuses a currency change on an existing subscription (409 CURRENCY_LOCKED), creating no order', async () => {
    fake.rows('subscriptions').push({
      id: 'sub-usd', workspace_id: WS1, plan_id: 'free', lifecycle_status: 'free',
      provider: null, provider_subscription_id: null, billing_period: null,
      amount_minor: 0, currency: 'USD', current_period_start: null, current_period_end: null,
      trial_ends_at: null, last_provider_event_at: null,
    });
    const res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1, currency: 'INR' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('CURRENCY_LOCKED');
    expect(fake.rows('billing_orders')).toHaveLength(0);
    expect(razorpayOrders.size).toBe(0);
  });
});

// ══ 4. Trial route ══════════════════════════════════════════════════════
describe('POST /api/billing/trial + status read model', () => {
  it('is inert with BILLING_ENABLED off (but needs no payment config when on)', async () => {
    setEnv({});
    let res = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(503);
    setEnv({ BILLING_ENABLED: 'true' }); // no Razorpay keys at all — trials must still work
    res = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(200);
  });

  it('starts a trial: row goes trialing with a 15-day window; status shows the plan + its IG limit', async () => {
    const res = await trialPOST(trialReq({ planId: 'creator-pro', workspaceId: WS1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscription: { status: string; trialDaysRemaining: number } };
    expect(body.subscription.status).toBe('trialing');
    expect(body.subscription.trialDaysRemaining).toBe(15);
    const row = fake.rows('subscriptions')[0]!;
    expect(row).toMatchObject({ workspace_id: WS1, plan_id: 'creator-pro', lifecycle_status: 'trialing', amount_minor: 0 });

    const sres = await statusGET(statusReq(WS1));
    const sbody = (await sres.json()) as {
      entitlement: { planId: string; limits: { instagramAccounts: number } };
      trial: { active: boolean; daysRemaining: number };
    };
    expect(sbody.entitlement.planId).toBe('creator-pro');
    expect(sbody.entitlement.limits.instagramAccounts).toBe(3);
    expect(sbody.trial).toMatchObject({ active: true, daysRemaining: 15 });
  });

  it('re-posting the same trial is idempotent; a different plan conflicts (409)', async () => {
    await trialPOST(trialReq({ planId: 'starter', workspaceId: WS1 }));
    const endsAt = fake.rows('subscriptions')[0]!['trial_ends_at'];
    const again = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS1 }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { alreadyTrialing?: boolean }).alreadyTrialing).toBe(true);
    expect(fake.rows('subscriptions')[0]!['trial_ends_at']).toBe(endsAt);
    const other = await trialPOST(trialReq({ planId: 'agency', workspaceId: WS1 }));
    expect(other.status).toBe(409);
    expect(((await other.json()) as { code: string }).code).toBe('ALREADY_TRIALING');
  });

  it('a member who is not the owner cannot start a trial', async () => {
    holder.user = MEMBER;
    const res = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(403);
    expect(fake.rows('subscriptions')).toHaveLength(0);
  });

  it('an expired trial lapses to Free on read (persisted), and cannot be re-trialed', async () => {
    holder.user = OWNER2;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    fake.rows('subscriptions').push({
      id: 'sub-lapsed', workspace_id: WS2, plan_id: 'agency', lifecycle_status: 'trialing',
      provider: null, provider_subscription_id: null, billing_period: 'monthly',
      amount_minor: 0, currency: 'INR', current_period_start: yesterday,
      current_period_end: yesterday, trial_ends_at: yesterday, last_provider_event_at: null,
    });
    const sres = await statusGET(statusReq(WS2));
    const sbody = (await sres.json()) as {
      subscription: { status: string } | null;
      entitlement: { planId: string; limits: { instagramAccounts: number } };
      trial: { lapsed: boolean; active: boolean };
    };
    expect(sbody.trial).toMatchObject({ lapsed: true, active: false });
    expect(sbody.subscription?.status).toBe('expired');
    expect(sbody.entitlement.planId).toBe('free');
    expect(sbody.entitlement.limits.instagramAccounts).toBe(1); // Free plan's own limit
    expect(fake.rows('subscriptions')[0]).toMatchObject({ lifecycle_status: 'expired' });

    const res = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS2 }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('TRIAL_ALREADY_USED');
  });

  it('an active subscription blocks a trial (409 ALREADY_SUBSCRIBED)', async () => {
    holder.user = OWNER2;
    fake.rows('subscriptions').push({
      id: 'sub-active', workspace_id: WS3, plan_id: 'starter', lifecycle_status: 'active',
      provider: 'razorpay', provider_subscription_id: 'order_x', billing_period: 'monthly',
      amount_minor: 29900, currency: 'INR', current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      trial_ends_at: null, last_provider_event_at: null,
    });
    const res = await trialPOST(trialReq({ planId: 'agency', workspaceId: WS3 }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ALREADY_SUBSCRIBED');
  });
});

// ══ 5. Status: catalogue account limits flow into entitlements ═════════
describe('GET /api/billing/status — plan account limits (1/3/5)', () => {
  it('active Starter → 1, Growth → 3, Pro → 5 Instagram accounts', async () => {
    holder.user = OWNER2;
    const mk = (id: string, ws: string, plan: string) => ({
      id, workspace_id: ws, plan_id: plan, lifecycle_status: 'active',
      provider: 'razorpay', provider_subscription_id: `order_${id}`, billing_period: 'monthly',
      amount_minor: 1, currency: 'INR', current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      trial_ends_at: null, last_provider_event_at: null,
    });
    fake.rows('subscriptions').push(mk('s1', WS2, 'starter'), mk('s2', WS3, 'creator-pro'), mk('s3', WS4, 'agency'));
    const limits: Record<string, number> = {};
    for (const ws of [WS2, WS3, WS4]) {
      const res = await statusGET(statusReq(ws));
      const body = (await res.json()) as { entitlement: { planId: string; limits: { instagramAccounts: number } } };
      limits[ws] = body.entitlement.limits.instagramAccounts;
    }
    expect(limits).toEqual({ [WS2]: 1, [WS3]: 3, [WS4]: 5 });
  });
});

// ══ 6. Webhook: signature, activation, idempotency ══════════════════════
describe('POST /api/billing/webhook', () => {
  it('is inert with flags off, and fails closed without a webhook secret', async () => {
    setEnv({});
    let res = await webhookPOST(webhookReq(capturedPayload('order_test_1', 'pay_1')));
    expect(res.status).toBe(503);
    setEnv({ BILLING_ENABLED: 'true' });
    res = await webhookPOST(webhookReq(capturedPayload('order_test_1', 'pay_1')));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('PAYMENTS_NOT_CONFIGURED');
  });

  it('rejects a bad signature and a tampered body (401), recording nothing', async () => {
    const payload = capturedPayload('order_test_1', 'pay_1');
    let res = await webhookPOST(webhookReq(payload, { signature: sign(JSON.stringify(payload), 'attacker-secret') }));
    expect(res.status).toBe(401);
    const raw = JSON.stringify(payload);
    res = await webhookPOST(webhookReq(payload, { rawBody: raw + ' ', signature: sign(raw) }));
    expect(res.status).toBe(401);
    expect(fake.rows('billing_events')).toHaveLength(0);
  });

  async function paidCheckout(): Promise<string> {
    const { res, body } = await doCheckout('creator-pro', WS1);
    expect(res.status).toBe(200);
    const orderId = (body as { order: { id: string } }).order.id;
    const stub = razorpayOrders.get(orderId)!;
    stub.status = 'paid';
    stub.amount_paid = stub.amount;
    return orderId;
  }

  it('a captured payment ACTIVATES the workspace entitlement for the purchased plan', async () => {
    const orderId = await paidCheckout();
    const res = await webhookPOST(webhookReq(capturedPayload(orderId, 'pay_1')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; entitlementGranted: boolean };
    expect(body).toMatchObject({ outcome: 'applied', entitlementGranted: true });
    expect(JSON.stringify(body)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(body)).not.toContain(WH_SECRET);

    const sub = fake.rows('subscriptions')[0]!;
    expect(sub).toMatchObject({
      workspace_id: WS1, plan_id: 'creator-pro', lifecycle_status: 'active',
      provider_subscription_id: orderId, billing_period: 'monthly', amount_minor: 50000,
    });
    const start = Date.parse(sub['current_period_start'] as string);
    const end = Date.parse(sub['current_period_end'] as string);
    expect((end - start) / 86_400_000).toBeGreaterThan(27);
    expect((end - start) / 86_400_000).toBeLessThan(32);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ status: 'paid', provider_payment_id: 'pay_1' });
    expect(fake.rows('billing_events')).toHaveLength(1);

    const sres = await statusGET(statusReq(WS1));
    const sbody = (await sres.json()) as { entitlement: { planId: string; limits: { instagramAccounts: number } } };
    expect(sbody.entitlement.planId).toBe('creator-pro');
    expect(sbody.entitlement.limits.instagramAccounts).toBe(3);
  });

  it('duplicate delivery does not double-activate (same event id → duplicate, one event row)', async () => {
    const orderId = await paidCheckout();
    const payload = capturedPayload(orderId, 'pay_1');
    await webhookPOST(webhookReq(payload));
    const periodEndBefore = fake.rows('subscriptions')[0]!['current_period_end'];
    const res = await webhookPOST(webhookReq(payload));
    const body = (await res.json()) as { outcome: string; entitlementGranted: boolean };
    expect(body).toMatchObject({ outcome: 'duplicate', entitlementGranted: true });
    expect(fake.rows('billing_events')).toHaveLength(1);
    expect(fake.rows('subscriptions')).toHaveLength(1);
    expect(fake.rows('subscriptions')[0]!['current_period_end']).toBe(periodEndBefore);
  });

  it('order.paid after payment.captured is a harmless no-op (still active, no double grant)', async () => {
    const orderId = await paidCheckout();
    await webhookPOST(webhookReq(capturedPayload(orderId, 'pay_1')));
    const res = await webhookPOST(webhookReq({
      event: 'order.paid',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        order: { entity: { id: orderId, amount_paid: 50000, currency: 'INR', status: 'paid' } },
        payment: { entity: { id: 'pay_1' } },
      },
    }));
    const body = (await res.json()) as { outcome: string; entitlementGranted: boolean };
    expect(body.entitlementGranted).toBe(true);
    expect(body.outcome).toBe('noop');
    expect(fake.rows('subscriptions')).toHaveLength(1);
    expect(fake.rows('subscriptions')[0]).toMatchObject({ lifecycle_status: 'active' });
  });

  it('a captured CLAIM for an order Razorpay still shows unpaid grants NOTHING (server wins)', async () => {
    const { res: cres, body: cbody } = await doCheckout('starter', WS1);
    expect(cres.status).toBe(200);
    const orderId = (cbody as { order: { id: string } }).order.id;
    // Razorpay stub still reports 'created' — the webhook lies.
    const res = await webhookPOST(webhookReq(capturedPayload(orderId, 'pay_lie', 29900)));
    const body = (await res.json()) as { outcome: string; entitlementGranted: boolean };
    expect(body.entitlementGranted).toBe(false);
    const sres = await statusGET(statusReq(WS1));
    const sbody = (await sres.json()) as { entitlement: { planId: string } };
    expect(sbody.entitlement.planId).toBe('free');
  });

  it('an unknown order is acknowledged and ignored (no subscription, no event row)', async () => {
    razorpayOrders.set('order_foreign', { status: 'paid', amount: 100, amount_paid: 100, currency: 'INR' });
    const res = await webhookPOST(webhookReq(capturedPayload('order_foreign', 'pay_foreign', 100)));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('unknown-order');
    expect(fake.rows('subscriptions')).toHaveLength(0);
    expect(fake.rows('billing_events')).toHaveLength(0);
  });

  it('payment.failed marks the order failed and grants nothing', async () => {
    const { body: cbody } = await doCheckout('starter', WS1);
    const orderId = (cbody as { order: { id: string } }).order.id;
    const res = await webhookPOST(webhookReq({
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: 'pay_fail1', order_id: orderId, amount: 29900, currency: 'INR', status: 'failed' } } },
    }));
    const body = (await res.json()) as { entitlementGranted: boolean };
    expect(body.entitlementGranted).toBe(false);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ status: 'failed' });
  });

  it('provider outage during verification → 503, nothing recorded; redelivery then succeeds', async () => {
    const orderId = await paidCheckout();
    razorpayDown = true;
    const payload = capturedPayload(orderId, 'pay_1');
    const res = await webhookPOST(webhookReq(payload));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('VERIFICATION_UNAVAILABLE');
    expect(fake.rows('billing_events')).toHaveLength(0);
    razorpayDown = false;
    const retry = await webhookPOST(webhookReq(payload));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { entitlementGranted: boolean }).entitlementGranted).toBe(true);
  });
});
