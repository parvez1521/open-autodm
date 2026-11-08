/**
 * Cashfree LIVE billing (owner decision 2026-11-08 ~20:34 IST:
 * Cashfree FINAL as the primary gateway; Razorpay stays as fallback).
 *
 * Mirrors tests/billing-subscription-wiring.test.ts discipline exactly:
 * synthetic credentials only, an in-memory fake Supabase, and a stubbed
 * fetch — no real Cashfree account, no network, no database.
 *
 * Covered:
 *   - config resolution (CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET /
 *     CASHFREE_ENV; sandbox default, production by env),
 *   - webhook signature: base64 HMAC-SHA-256 of
 *     `${timestamp}${rawBody}` (PLAIN concatenation — the dot-joined
 *     variant some examples show is REJECTED here), fail closed,
 *   - provider selection: Cashfree wins when configured; Razorpay is
 *     the intact fallback; neither → PAYMENTS_NOT_CONFIGURED,
 *   - checkout: flags-off inert, phone required (Cashfree mandates a
 *     customer phone), order persisted in billing_orders with
 *     provider='cashfree' BEFORE the response, no secret in the
 *     response, 401/403 paths, USD for non-India currency,
 *   - webhook: bad signature / tampered body rejected, SUCCESS claim
 *     believed only after the server-side order re-read says PAID
 *     (a claim for an unpaid order grants NOTHING), duplicates
 *     idempotent, provider outage → 503 for redelivery.
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
import { GET as statusGET } from '@/app/api/billing/status/route';
import {
  readCashfreeConfig,
  isCashfreeConfigured,
  verifyCashfreeWebhookSignature,
  createCashfreeOrder,
  CashfreeApiError,
} from '@/lib/billing/cashfree';
import { CashfreeLiveProvider } from '@/lib/billing/cashfreeLiveProvider';
import { resolveActiveBillingProvider } from '@/lib/billing/activeProvider';

// ── Fixtures ────────────────────────────────────────────────────────────
const CF_ID = 'cf_test_synthetic123';
const CF_SECRET = 'synthetic-cashfree-secret';
const KEY_ID = 'rzp_test_synthetic123';
const KEY_SECRET = 'synthetic-key-secret';
const WH_SECRET = 'synthetic-webhook-secret';
const PHONE = '9876543210';

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const MEMBER = { id: 'user-member', email: 'member@example.com' };

const WS1 = 'ws-1';

let fake: FakeSupabase;

function baseSeed() {
  return {
    workspace_memberships: [
      { workspace_id: WS1, user_id: OWNER.id, role: 'owner' },
      { workspace_id: WS1, user_id: MEMBER.id, role: 'member' },
    ],
    subscriptions: [] as Record<string, unknown>[],
    billing_orders: [] as Record<string, unknown>[],
    billing_events: [] as Record<string, unknown>[],
  };
}

// ── Cashfree fetch stub ────────────────────────────────────────────────
interface StubCfOrder { status: string; amount: number; currency: string }
const cfOrders = new Map<string, StubCfOrder>();
let cfDown = false;
let cfLastCreate: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;

function stubCashfreeFetch() {
  vi.stubGlobal('fetch', async (url: string, init: Record<string, unknown>) => {
    const u = String(url);
    if (cfDown) throw new Error('provider unreachable (stub)');
    const create = u.match(/^https:\/\/(sandbox|api)\.cashfree\.com\/pg\/orders$/);
    if (create && init.method === 'POST') {
      const sent = JSON.parse(init.body as string) as {
        order_id: string; order_amount: number; order_currency: string;
        customer_details: Record<string, unknown>; order_meta?: Record<string, unknown>;
      };
      cfLastCreate = { url: u, headers: init.headers as Record<string, string>, body: sent as unknown as Record<string, unknown> };
      cfOrders.set(sent.order_id, { status: 'ACTIVE', amount: sent.order_amount, currency: sent.order_currency });
      return {
        ok: true, status: 200,
        json: async () => ({
          cf_order_id: 777001, order_id: sent.order_id, order_amount: sent.order_amount,
          order_currency: sent.order_currency, order_status: 'ACTIVE',
          payment_session_id: `session_${sent.order_id}`,
        }),
      };
    }
    const get = u.match(/^https:\/\/(sandbox|api)\.cashfree\.com\/pg\/orders\/(.+)$/);
    if (get) {
      const order = cfOrders.get(get[2]!);
      if (!order) {
        return { ok: false, status: 404, json: async () => ({ message: 'order not found', code: '404', type: 'invalid_request_error' }) };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          cf_order_id: 777001, order_id: get[2], order_amount: order.amount,
          order_currency: order.currency, order_status: order.status,
        }),
      };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  });
}

// ── Env management ──────────────────────────────────────────────────────
const ENV_KEYS = [
  'BILLING_ENABLED', 'PAYMENTS_LIVE_MODE',
  'CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_ENV',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
] as const;
let savedEnv: Record<string, string | undefined> = {};
const CF_ENV: Record<string, string> = {
  BILLING_ENABLED: 'true',
  PAYMENTS_LIVE_MODE: 'true',
  CASHFREE_CLIENT_ID: CF_ID,
  CASHFREE_CLIENT_SECRET: CF_SECRET,
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
  cfOrders.clear();
  cfDown = false;
  cfLastCreate = null;
  stubCashfreeFetch();
  setEnv(CF_ENV);
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

function signCf(rawBody: string, timestamp: string, secret = CF_SECRET): string {
  return createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
}
function cfWebhookReq(
  payload: unknown,
  opts: { signature?: string; timestamp?: string; rawBody?: string } = {},
): Request {
  const rawBody = opts.rawBody ?? JSON.stringify(payload);
  const timestamp = opts.timestamp ?? '1762654445000';
  return new Request('https://app.opendm.in/api/billing/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': opts.signature ?? signCf(rawBody, timestamp),
      'x-webhook-timestamp': timestamp,
    },
    body: rawBody,
  });
}
function cfPayload(orderId: string, cfPaymentId: number, status: 'SUCCESS' | 'FAILED', amount = 500) {
  return {
    type: status === 'SUCCESS' ? 'PAYMENT_SUCCESS_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK',
    event_time: '2026-11-08T15:04:05+05:30',
    data: {
      order: { order_id: orderId, order_amount: amount, order_currency: 'INR' },
      payment: {
        cf_payment_id: cfPaymentId, payment_status: status,
        payment_amount: amount, payment_currency: 'INR',
        payment_time: '2026-11-08T15:04:04+05:30', payment_method: { upi: { channel: 'collect' } },
      },
      customer_details: { customer_id: `ws_${WS1}`, customer_phone: PHONE },
    },
  };
}
async function doCfCheckout(planId = 'creator-pro'): Promise<{ res: Response; body: Record<string, unknown>; orderId: string }> {
  const res = await checkoutPOST(checkoutReq({ planId, workspaceId: WS1, customerPhone: PHONE }));
  const body = (await res.json()) as Record<string, unknown>;
  const order = body.order as { id: string } | undefined;
  return { res, body, orderId: order?.id ?? '' };
}

// ══ 1. Config ════════════════════════════════════════════════════════════
describe('readCashfreeConfig', () => {
  it('is unconfigured without BOTH credentials', () => {
    expect(isCashfreeConfigured({})).toBe(false);
    expect(isCashfreeConfigured({ CASHFREE_CLIENT_ID: CF_ID })).toBe(false);
    expect(isCashfreeConfigured({ CASHFREE_CLIENT_SECRET: CF_SECRET })).toBe(false);
    expect(isCashfreeConfigured({ CASHFREE_CLIENT_ID: '  ', CASHFREE_CLIENT_SECRET: CF_SECRET })).toBe(false);
    expect(isCashfreeConfigured({ CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET })).toBe(true);
  });

  it('defaults to the sandbox base URL; production only on CASHFREE_ENV=production', () => {
    const base = { CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET };
    expect(readCashfreeConfig(base).baseUrl).toBe('https://sandbox.cashfree.com/pg');
    expect(readCashfreeConfig({ ...base, CASHFREE_ENV: 'sandbox' }).baseUrl).toBe('https://sandbox.cashfree.com/pg');
    expect(readCashfreeConfig({ ...base, CASHFREE_ENV: 'production' }).baseUrl).toBe('https://api.cashfree.com/pg');
    expect(readCashfreeConfig({ ...base, CASHFREE_ENV: 'live' }).baseUrl).toBe('https://sandbox.cashfree.com/pg');
  });
});

// ══ 2. Webhook signature ═════════════════════════════════════════════════
describe('verifyCashfreeWebhookSignature', () => {
  const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'opdm_x' } } });
  const ts = '1762654445000';

  it('accepts a genuine signature over `timestamp + rawBody` (plain concatenation)', () => {
    expect(verifyCashfreeWebhookSignature(body, signCf(body, ts), CF_SECRET, ts)).toBe(true);
  });

  it('REJECTS the dot-joined variant some examples show — the PG scheme has no separator', () => {
    const dotted = createHmac('sha256', CF_SECRET).update(`${ts}.${body}`).digest('base64');
    expect(verifyCashfreeWebhookSignature(body, dotted, CF_SECRET, ts)).toBe(false);
  });

  it('rejects a tampered body, a wrong secret and a wrong timestamp — fail closed', () => {
    const good = signCf(body, ts);
    expect(verifyCashfreeWebhookSignature(`${body} `, good, CF_SECRET, ts)).toBe(false);
    expect(verifyCashfreeWebhookSignature(body, good, 'another-secret', ts)).toBe(false);
    expect(verifyCashfreeWebhookSignature(body, good, CF_SECRET, '1762654445999')).toBe(false);
  });

  it('rejects missing inputs instead of throwing', () => {
    expect(verifyCashfreeWebhookSignature(body, '', CF_SECRET, ts)).toBe(false);
    expect(verifyCashfreeWebhookSignature(body, signCf(body, ts), '', ts)).toBe(false);
    expect(verifyCashfreeWebhookSignature(body, signCf(body, ts), CF_SECRET, undefined)).toBe(false);
  });
});

// ══ 3. Provider selection ════════════════════════════════════════════════
describe('resolveActiveBillingProvider (Cashfree primary, Razorpay fallback)', () => {
  it('picks Cashfree when only Cashfree is configured', () => {
    expect(resolveActiveBillingProvider({ CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET })?.providerId).toBe('cashfree');
  });

  it('Cashfree WINS when both gateways are configured (owner decision 2026-11-08)', () => {
    expect(resolveActiveBillingProvider({
      CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET,
      RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET,
    })?.providerId).toBe('cashfree');
  });

  it('falls back to Razorpay when Cashfree is not configured', () => {
    expect(resolveActiveBillingProvider({ RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET })?.providerId).toBe('razorpay');
  });

  it('returns null when nothing is configured', () => {
    expect(resolveActiveBillingProvider({})).toBeNull();
  });
});

// ══ 4. Order creation (adapter) ══════════════════════════════════════════
describe('createCashfreeOrder', () => {
  const cfg = readCashfreeConfig({ CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET });

  it('posts to the sandbox orders endpoint with the client headers; amount in MAJOR units', async () => {
    const order = await createCashfreeOrder(cfg, {
      orderId: 'opdm_starter_monthly_x1',
      amountMinor: 29900, currency: 'INR',
      customer: { customerId: `ws_${WS1}`, phone: PHONE, email: 'owner@example.com' },
      returnUrl: 'https://opendm.in/billing', notifyUrl: 'https://opendm.in/api/billing/webhook',
    });
    expect(order.paymentSessionId).toBe('session_opdm_starter_monthly_x1');
    expect(order.orderStatus).toBe('ACTIVE');
    expect(cfLastCreate?.url).toBe('https://sandbox.cashfree.com/pg/orders');
    expect(cfLastCreate?.headers['x-client-id']).toBe(CF_ID);
    expect(cfLastCreate?.headers['x-client-secret']).toBe(CF_SECRET);
    expect(cfLastCreate?.headers['x-api-version']).toBe('2023-08-01');
    // Catalogue money is integer MINOR units; Cashfree takes majors.
    expect(cfLastCreate?.body.order_amount).toBe(299);
    expect(cfLastCreate?.body.customer_details).toMatchObject({
      customer_id: `ws_${WS1}`, customer_phone: PHONE, customer_email: 'owner@example.com',
    });
    expect(cfLastCreate?.body.order_meta).toMatchObject({
      return_url: 'https://opendm.in/billing', notify_url: 'https://opendm.in/api/billing/webhook',
    });
  });

  it('uses the production base URL when CASHFREE_ENV=production', async () => {
    const prod = readCashfreeConfig({
      CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET, CASHFREE_ENV: 'production',
    });
    await createCashfreeOrder(prod, {
      orderId: 'opdm_agency_monthly_y2', amountMinor: 79900, currency: 'INR',
      customer: { customerId: `ws_${WS1}`, phone: PHONE },
    });
    expect(cfLastCreate?.url).toBe('https://api.cashfree.com/pg/orders');
  });

  it('maps a Cashfree error body onto CashfreeApiError', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 400,
      json: async () => ({ message: 'order_amount is invalid', code: 'invalid_amount', type: 'invalid_request_error' }),
    }));
    await expect(createCashfreeOrder(cfg, {
      orderId: 'opdm_z', amountMinor: 100, currency: 'INR',
      customer: { customerId: 'ws_x', phone: PHONE },
    })).rejects.toBeInstanceOf(CashfreeApiError);
  });
});

// ══ 5. Event normalization + server-wins verification ════════════════════
describe('CashfreeLiveProvider', () => {
  it('normalizes SUCCESS/FAILED with a redelivery-proof event id; ignores other events', () => {
    const p = cfPayload('opdm_9', 900001, 'SUCCESS');
    const a = CashfreeLiveProvider.normalizeEvent(p);
    const b = CashfreeLiveProvider.normalizeEvent(p);
    expect(a).toMatchObject({
      provider: 'cashfree',
      providerEventId: 'PAYMENT_SUCCESS_WEBHOOK:900001',
      providerSubscriptionId: 'opdm_9',
      type: 'subscription_activated',
      claimedStatus: 'active',
      amountMinor: 50000,
    });
    expect(b?.providerEventId).toBe(a?.providerEventId);
    expect(CashfreeLiveProvider.normalizeEvent(cfPayload('opdm_9', 900002, 'FAILED'))).toMatchObject({
      type: 'payment_failed', claimedStatus: null,
    });
    expect(CashfreeLiveProvider.normalizeEvent({ type: 'PAYMENT_USER_DROPPED_WEBHOOK', data: {} })).toBeNull();
    expect(CashfreeLiveProvider.normalizeEvent({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: {}, payment: {} } })).toBeNull();
  });

  it('fetchSubscription believes Cashfree, not the caller: PAID → active, ACTIVE → incomplete', async () => {
    const cfg = readCashfreeConfig({ CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET });
    const provider = new CashfreeLiveProvider(cfg);
    cfOrders.set('opdm_paid', { status: 'PAID', amount: 500, currency: 'INR' });
    cfOrders.set('opdm_open', { status: 'ACTIVE', amount: 500, currency: 'INR' });
    expect(await provider.fetchSubscription('opdm_paid')).toMatchObject({ status: 'active', amountMinor: 50000 });
    expect(await provider.fetchSubscription('opdm_open')).toMatchObject({ status: 'incomplete' });
  });
});

// ══ 6. Checkout route ════════════════════════════════════════════════════
describe('POST /api/billing/checkout — Cashfree', () => {
  it('stays inert (503 BILLING_DISABLED) with flags off, before any auth work', async () => {
    setEnv({ CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET });
    holder.user = null;
    const res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1, customerPhone: PHONE }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('BILLING_DISABLED');
  });

  it('503 PAYMENTS_NOT_CONFIGURED when billing is on but NO provider keys exist', async () => {
    setEnv({ BILLING_ENABLED: 'true', PAYMENTS_LIVE_MODE: 'true' });
    const res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1, customerPhone: PHONE }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('PAYMENTS_NOT_CONFIGURED');
  });

  it('requires the customer phone when Cashfree is active (missing → 400, malformed → 400)', async () => {
    let res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CUSTOMER_PHONE');
    res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1, customerPhone: '12345' }));
    expect(res.status).toBe(400);
    expect(fake.rows('billing_orders')).toHaveLength(0);
    expect(cfLastCreate).toBeNull();
  });

  it('requires authentication (401) and the owner role (403 for a member)', async () => {
    holder.user = null;
    let res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1, customerPhone: PHONE }));
    expect(res.status).toBe(401);
    holder.user = MEMBER;
    res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1, customerPhone: PHONE }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('insufficient-role');
    expect(fake.rows('billing_orders')).toHaveLength(0);
  });

  it('persists the order with provider=cashfree BEFORE responding; returns the session id, never the secret', async () => {
    const { res, body } = await doCfCheckout('creator-pro');
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, provider: 'cashfree', workspaceId: WS1, planId: 'creator-pro', mode: 'sandbox' });
    expect(body.paymentSessionId).toBe(`session_${(body.order as { id: string }).id}`);
    const orders = fake.rows('billing_orders');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      workspace_id: WS1, provider: 'cashfree', plan_id: 'creator-pro',
      amount_minor: 50000, currency: 'INR', status: 'created',
    });
    expect(JSON.stringify(body)).not.toContain(CF_SECRET);
  });

  it('Cashfree wins the checkout when BOTH providers are configured', async () => {
    setEnv({
      BILLING_ENABLED: 'true', PAYMENTS_LIVE_MODE: 'true',
      CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET,
      RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH_SECRET,
    });
    const { res, body } = await doCfCheckout('starter');
    expect(res.status).toBe(200);
    expect(body.provider).toBe('cashfree');
    expect(fake.rows('billing_orders')[0]).toMatchObject({ provider: 'cashfree' });
  });

  it('checkout currency follows the resolved display currency (USD order → $ amount in majors)', async () => {
    const res = await checkoutPOST(checkoutReq({ planId: 'starter', workspaceId: WS1, customerPhone: PHONE, currency: 'USD', period: 'monthly' }));
    expect(res.status).toBe(200);
    expect(cfLastCreate?.body.order_currency).toBe('USD');
    expect(cfLastCreate?.body.order_amount).toBe(5);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ currency: 'USD', amount_minor: 500 });
  });
});

// ══ 7. Webhook route ═════════════════════════════════════════════════════
describe('POST /api/billing/webhook — Cashfree', () => {
  it('is inert (503) with BILLING_ENABLED off even with a valid Cashfree signature', async () => {
    setEnv({ CASHFREE_CLIENT_ID: CF_ID, CASHFREE_CLIENT_SECRET: CF_SECRET });
    const res = await webhookPOST(cfWebhookReq(cfPayload('opdm_any', 1, 'SUCCESS')));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('BILLING_DISABLED');
  });

  it('503 when Cashfree is not configured (no client secret to verify with)', async () => {
    setEnv({ BILLING_ENABLED: 'true' });
    const res = await webhookPOST(cfWebhookReq(cfPayload('opdm_any', 1, 'SUCCESS')));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('PAYMENTS_NOT_CONFIGURED');
  });

  it('rejects a bad signature (401) and records nothing', async () => {
    const res = await webhookPOST(cfWebhookReq(cfPayload('opdm_any', 1, 'SUCCESS'), { signature: 'bogus' }));
    expect(res.status).toBe(401);
    expect(fake.rows('billing_events')).toHaveLength(0);
  });

  it('rejects a TAMPERED body (signature over the original, body replaced)', async () => {
    const { orderId } = await doCfCheckout();
    const original = JSON.stringify(cfPayload(orderId, 900001, 'SUCCESS'));
    const tampered = JSON.stringify(cfPayload(orderId, 900001, 'SUCCESS', 1)); // amount changed
    const res = await webhookPOST(cfWebhookReq(null, { rawBody: tampered, signature: signCf(original, '1762654445000'), timestamp: '1762654445000' }));
    expect(res.status).toBe(401);
    expect(fake.rows('billing_events')).toHaveLength(0);
  });

  it('SUCCESS + server reads PAID → entitlement activates from the ORDER ROW (plan/period), order marked paid', async () => {
    const { orderId } = await doCfCheckout('creator-pro');
    cfOrders.get(orderId)!.status = 'PAID';
    const res = await webhookPOST(cfWebhookReq(cfPayload(orderId, 900001, 'SUCCESS')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; entitlementGranted: boolean };
    expect(body.outcome).toBe('applied');
    expect(body.entitlementGranted).toBe(true);
    const sub = fake.rows('subscriptions')[0];
    expect(sub).toMatchObject({
      workspace_id: WS1, plan_id: 'creator-pro', lifecycle_status: 'active',
      provider: 'cashfree', provider_subscription_id: orderId, billing_period: 'monthly',
    });
    expect(fake.rows('billing_orders')[0]).toMatchObject({ status: 'paid', provider_payment_id: '900001' });
    const events = fake.rows('billing_events');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'cashfree', provider_event_id: 'PAYMENT_SUCCESS_WEBHOOK:900001' });
  });

  it('duplicate delivery is idempotent: outcome duplicate, one event row, one period', async () => {
    const { orderId } = await doCfCheckout('creator-pro');
    cfOrders.get(orderId)!.status = 'PAID';
    const first = await webhookPOST(cfWebhookReq(cfPayload(orderId, 900001, 'SUCCESS')));
    expect(((await first.json()) as { outcome: string }).outcome).toBe('applied');
    const endAfterFirst = fake.rows('subscriptions')[0]!.current_period_end;
    const second = await webhookPOST(cfWebhookReq(cfPayload(orderId, 900001, 'SUCCESS')));
    expect(((await second.json()) as { outcome: string }).outcome).toBe('duplicate');
    expect(fake.rows('billing_events')).toHaveLength(1);
    expect(fake.rows('subscriptions')).toHaveLength(1);
    expect(fake.rows('subscriptions')[0]!.current_period_end).toBe(endAfterFirst);
  });

  it('a SUCCESS claim for an order Cashfree still shows UNPAID grants NOTHING (server wins)', async () => {
    const { orderId } = await doCfCheckout('creator-pro');
    // Stub order stays 'ACTIVE' — the webhook claims success anyway.
    const res = await webhookPOST(cfWebhookReq(cfPayload(orderId, 900001, 'SUCCESS')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entitlementGranted: boolean };
    expect(body.entitlementGranted).toBe(false);
    const sres = await statusGET(new Request('https://app.opendm.in/api/billing/status', { headers: { 'x-workspace-id': WS1 } }));
    const sbody = (await sres.json()) as { entitlement: { planId: string } };
    expect(sbody.entitlement.planId).toBe('free');
    expect(fake.rows('subscriptions')).toHaveLength(0);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ status: 'created' });
  });

  it('PAYMENT_FAILED_WEBHOOK marks the order failed and grants nothing', async () => {
    const { orderId } = await doCfCheckout('creator-pro');
    const res = await webhookPOST(cfWebhookReq(cfPayload(orderId, 900002, 'FAILED')));
    expect(res.status).toBe(200);
    expect(fake.rows('billing_orders')[0]).toMatchObject({ status: 'failed' });
    const sres = await statusGET(new Request('https://app.opendm.in/api/billing/status', { headers: { 'x-workspace-id': WS1 } }));
    expect(((await sres.json()) as { entitlement: { planId: string } }).entitlement.planId).toBe('free');
  });

  it('unknown orders are acknowledged and ignored (no retry storm)', async () => {
    const res = await webhookPOST(cfWebhookReq(cfPayload('opdm_foreign', 900003, 'SUCCESS')));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('unknown-order');
  });

  it('provider outage during verification → 503 VERIFICATION_UNAVAILABLE, then redelivery succeeds', async () => {
    const { orderId } = await doCfCheckout('creator-pro');
    cfOrders.get(orderId)!.status = 'PAID';
    cfDown = true;
    const res = await webhookPOST(cfWebhookReq(cfPayload(orderId, 900001, 'SUCCESS')));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('VERIFICATION_UNAVAILABLE');
    expect(fake.rows('billing_events')).toHaveLength(0);
    cfDown = false;
    const retry = await webhookPOST(cfWebhookReq(cfPayload(orderId, 900001, 'SUCCESS')));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { outcome: string }).outcome).toBe('applied');
  });

  it('PAYMENT_USER_DROPPED_WEBHOOK is acknowledged and ignored', async () => {
    const { orderId } = await doCfCheckout('creator-pro');
    const payload = { type: 'PAYMENT_USER_DROPPED_WEBHOOK', event_time: '2026-11-08T15:04:05+05:30', data: { order: { order_id: orderId } } };
    const res = await webhookPOST(cfWebhookReq(payload));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('ignored');
  });
});

// ══ 8. Status read model names the active provider ═══════════════════════
describe('GET /api/billing/status — paymentProvider', () => {
  it('reports cashfree when Cashfree is configured (the panel uses it for the phone field)', async () => {
    const res = await statusGET(new Request('https://app.opendm.in/api/billing/status', { headers: { 'x-workspace-id': WS1 } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paymentProvider?: string };
    expect(body.paymentProvider).toBe('cashfree');
  });
});
