/**
 * Customer-journey fixes (2026-11-09) — billing items A4 / B / C / D.
 *
 *  A4  One trial per USER: a trial start on a fresh workspace is
 *      refused 409 TRIAL_ALREADY_USED when ANOTHER workspace owned by
 *      the same user already carries trial_ends_at — while a
 *      first-ever trial on a Free workspace still starts (the
 *      disputed-QA guard: the normal path must keep working).
 *  B   Early renewal no longer truncates the paid period: renewing
 *      an active, unlapsed subscription for the SAME plan starts the
 *      new period at the old period end; a lapsed renewal starts at
 *      payment time.
 *  C   Checkout + trial derive currency from geo server-side: a body
 *      currency that contradicts the geo signal → 400
 *      CURRENCY_MISMATCH; matching geo/body passes; no geo signal →
 *      the body currency stands (local/dev behaviour unchanged).
 *  D   Annual is not offered (monthly-only pricing): period 'annual'
 *      → 400 PERIOD_NOT_OFFERED on both routes.
 *
 * Same harness style as billing-subscription-wiring.test.ts:
 * synthetic Razorpay keys, in-memory fake Supabase, stubbed fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createFakeSupabase, type FakeSupabase } from './helpers/fake-supabase';

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

// ── Fixtures ────────────────────────────────────────────────────────────
const KEY_ID = 'rzp' + '_test_' + 'synthetic123';
const KEY_SECRET = ['synthetic', 'key', 'secret'].join('-');
const WH_SECRET = ['synthetic', 'webhook', 'secret'].join('-');

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const OWNER2 = { id: 'user-owner2', email: 'owner2@example.com' };
const SINGLE = { id: 'user-single', email: 'single@example.com' };

const WS1 = 'ws-1';
const WS2 = 'ws-2';
const WS3 = 'ws-3';
const WS5 = 'ws-5';

let fake: FakeSupabase;

function baseSeed() {
  return {
    workspace_memberships: [
      { workspace_id: WS1, user_id: OWNER.id, role: 'owner' },
      { workspace_id: WS2, user_id: OWNER2.id, role: 'owner' },
      { workspace_id: WS3, user_id: OWNER2.id, role: 'owner' },
      { workspace_id: WS5, user_id: SINGLE.id, role: 'owner' },
    ],
    subscriptions: [] as Record<string, unknown>[],
    billing_orders: [] as Record<string, unknown>[],
    billing_events: [] as Record<string, unknown>[],
  };
}

// ── Razorpay fetch stub (same shape as the wiring suite) ───────────────
interface StubOrder { status: string; amount: number; amount_paid: number; currency: string }
const razorpayOrders = new Map<string, StubOrder>();
let orderCounter = 0;

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

// ── Env ─────────────────────────────────────────────────────────────────
const ENV_KEYS = ['BILLING_ENABLED', 'PAYMENTS_LIVE_MODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'ENTITLEMENTS_ENFORCED'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  fake = createFakeSupabase(baseSeed());
  holder.db = fake.client;
  holder.user = OWNER;
  razorpayOrders.clear();
  orderCounter = 0;
  stubRazorpayFetch();
  process.env['BILLING_ENABLED'] = 'true';
  process.env['PAYMENTS_LIVE_MODE'] = 'true';
  process.env['RAZORPAY_KEY_ID'] = KEY_ID;
  process.env['RAZORPAY_KEY_SECRET'] = KEY_SECRET;
  process.env['RAZORPAY_WEBHOOK_SECRET'] = WH_SECRET;
  delete process.env['ENTITLEMENTS_ENFORCED'];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

// ── Request helpers ─────────────────────────────────────────────────────
function jsonPost(url: string, payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}
const checkoutReq = (payload: unknown, headers?: Record<string, string>) =>
  jsonPost('https://app.opendm.in/api/billing/checkout', payload, headers);
const trialReq = (payload: unknown, headers?: Record<string, string>) =>
  jsonPost('https://app.opendm.in/api/billing/trial', payload, headers);

function sign(body: string): string {
  return createHmac('sha256', WH_SECRET).update(body).digest('hex');
}
function capturedPayload(orderId: string, paymentId: string) {
  return {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: paymentId, order_id: orderId, status: 'captured',
          amount: 50000, currency: 'INR', captured_at: Math.floor(Date.now() / 1000),
        },
      },
    },
  };
}
function webhookReq(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  return new Request('https://app.opendm.in/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sign(rawBody) },
    body: rawBody,
  });
}

async function paidCheckout(planId: string, workspaceId: string): Promise<string> {
  const res = await checkoutPOST(checkoutReq({ planId, workspaceId, customerPhone: '9876543210' }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { order: { id: string } };
  const stub = razorpayOrders.get(body.order.id)!;
  stub.status = 'paid';
  stub.amount_paid = stub.amount;
  return body.order.id;
}

function subRow(ws: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `sub-${ws}`, workspace_id: ws, plan_id: 'creator-pro', lifecycle_status: 'active',
    provider: 'razorpay', provider_subscription_id: 'order_prev', billing_period: 'monthly',
    amount_minor: 50000, currency: 'INR', trial_ends_at: null, last_provider_event_at: null,
    ...over,
  };
}

// ══ A4 — one trial per USER ═════════════════════════════════════════════
describe('A4 — trial is one per user, not per workspace', () => {
  it('refuses a trial on a fresh workspace when another owned workspace already trialed (409)', async () => {
    holder.user = OWNER2;
    // WS2 (owned by OWNER2) already carries the trial-used marker.
    fake.rows('subscriptions').push(subRow(WS2, {
      plan_id: 'starter', amount_minor: 29900,
      current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2026-10-16T00:00:00Z',
      trial_ends_at: '2026-10-16T00:00:00Z',
    }));
    const res = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS3 }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('TRIAL_ALREADY_USED');
    // No trial row was written for WS3.
    expect(fake.rows('subscriptions').filter((r) => r['workspace_id'] === WS3)).toHaveLength(0);
  });

  it('a FIRST trial on a Free workspace still starts (normal path intact)', async () => {
    holder.user = SINGLE;
    const res = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS5 }));
    expect(res.status).toBe(200);
    const rows = fake.rows('subscriptions').filter((r) => r['workspace_id'] === WS5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lifecycle_status: 'trialing', plan_id: 'starter' });
    expect(rows[0]!['trial_ends_at']).toBeTruthy();
  });
});

// ══ B — early renewal stacks, never truncates ═══════════════════════════
describe('B — renewal period math', () => {
  it('renewing mid-period starts the new period at the OLD period end', async () => {
    const now = Date.now();
    const oldStart = new Date(now - 25 * 86_400_000).toISOString();
    const oldEnd = new Date(now + 5 * 86_400_000).toISOString();
    fake.rows('subscriptions').push(subRow(WS1, {
      current_period_start: oldStart, current_period_end: oldEnd,
    }));
    const orderId = await paidCheckout('creator-pro', WS1);
    const res = await webhookPOST(webhookReq(capturedPayload(orderId, 'pay_renew_1')));
    expect(res.status).toBe(200);
    const sub = fake.rows('subscriptions').find((r) => r['workspace_id'] === WS1)!;
    // New period starts exactly where the old one ended — the 5
    // remaining paid days are NOT truncated.
    expect(sub['current_period_start']).toBe(oldEnd);
    const spanDays = (Date.parse(sub['current_period_end'] as string) - Date.parse(oldEnd)) / 86_400_000;
    expect(spanDays).toBeGreaterThan(27);
    expect(spanDays).toBeLessThan(32);
  });

  it('a LAPSED renewal starts at payment time instead', async () => {
    const now = Date.now();
    fake.rows('subscriptions').push(subRow(WS1, {
      current_period_start: new Date(now - 40 * 86_400_000).toISOString(),
      current_period_end: new Date(now - 10 * 86_400_000).toISOString(),
    }));
    const before = Date.now();
    const orderId = await paidCheckout('creator-pro', WS1);
    const res = await webhookPOST(webhookReq(capturedPayload(orderId, 'pay_renew_2')));
    expect(res.status).toBe(200);
    const sub = fake.rows('subscriptions').find((r) => r['workspace_id'] === WS1)!;
    const start = Date.parse(sub['current_period_start'] as string);
    expect(start).toBeGreaterThanOrEqual(before - 5_000);
    expect(start).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

// ══ C — server-side geo currency ════════════════════════════════════════
describe('C — currency must match the geo signal', () => {
  it('checkout: India geo + USD body → 400 CURRENCY_MISMATCH, no order created', async () => {
    const res = await checkoutPOST(checkoutReq(
      { planId: 'starter', workspaceId: WS1, currency: 'USD', customerPhone: '9876543210' },
      { 'x-vercel-ip-country': 'IN' },
    ));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('CURRENCY_MISMATCH');
    expect(fake.rows('billing_orders')).toHaveLength(0);
  });

  it('checkout: US geo + USD body passes and orders in USD', async () => {
    const res = await checkoutPOST(checkoutReq(
      { planId: 'starter', workspaceId: WS1, currency: 'USD', customerPhone: '9876543210' },
      { 'x-vercel-ip-country': 'US' },
    ));
    expect(res.status).toBe(200);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ currency: 'USD', amount_minor: 500 });
  });

  it('checkout: no geo signal → the body currency stands (unchanged local behaviour)', async () => {
    const res = await checkoutPOST(checkoutReq(
      { planId: 'starter', workspaceId: WS1, currency: 'INR', customerPhone: '9876543210' },
    ));
    expect(res.status).toBe(200);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ currency: 'INR' });
  });

  it('trial: India geo + USD body → 400 CURRENCY_MISMATCH; US geo + USD starts in USD', async () => {
    holder.user = SINGLE;
    let res = await trialPOST(trialReq(
      { planId: 'starter', workspaceId: WS5, currency: 'USD' },
      { 'x-vercel-ip-country': 'IN' },
    ));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('CURRENCY_MISMATCH');
    expect(fake.rows('subscriptions')).toHaveLength(0);

    res = await trialPOST(trialReq(
      { planId: 'starter', workspaceId: WS5, currency: 'USD' },
      { 'x-vercel-ip-country': 'US' },
    ));
    expect(res.status).toBe(200);
    expect(fake.rows('subscriptions')[0]).toMatchObject({ currency: 'USD', lifecycle_status: 'trialing' });
  });
});

// ══ D — annual is not offered ═══════════════════════════════════════════
describe('D — annual period rejected (monthly-only pricing)', () => {
  it('checkout with period annual → 400 PERIOD_NOT_OFFERED, no order', async () => {
    const res = await checkoutPOST(checkoutReq(
      { planId: 'starter', workspaceId: WS1, period: 'annual', customerPhone: '9876543210' },
    ));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PERIOD_NOT_OFFERED');
    expect(fake.rows('billing_orders')).toHaveLength(0);
  });

  it('trial with period annual → 400 PERIOD_NOT_OFFERED, no subscription written', async () => {
    holder.user = SINGLE;
    const res = await trialPOST(trialReq({ planId: 'starter', workspaceId: WS5, period: 'annual' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PERIOD_NOT_OFFERED');
    expect(fake.rows('subscriptions')).toHaveLength(0);
  });
});
