/**
 * Razorpay LIVE scaffolding (src/lib/billing/razorpay.ts +
 * src/app/api/billing/checkout/route.ts).
 *
 * Everything here uses SYNTHETIC keys and a mocked fetch — no real
 * Razorpay account, no network. The behaviours pinned:
 *  - config reports "not configured" cleanly when keys are absent,
 *  - webhook signature verification accepts the genuine HMAC and
 *    rejects tampered bodies / wrong signatures / missing inputs,
 *  - order creation sends the right amount/currency/auth to the
 *    Razorpay Orders API and surfaces provider errors as a typed error,
 *  - the checkout route is INERT (503) unless billing is enabled,
 *    live mode is on AND keys are configured — and only then creates
 *    an order priced from the draft catalogue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  readRazorpayConfig,
  isRazorpayConfigured,
  verifyRazorpayWebhookSignature,
  createRazorpayOrder,
  RazorpayApiError,
  RAZORPAY_ORDERS_URL,
} from '@/lib/billing/razorpay';
import { POST } from '@/app/api/billing/checkout/route';

// ── Workspace binding (subscription wiring, 2026-11-08) ────────────────
// The checkout route now binds orders to the caller's authenticated
// workspace and records them. This file keeps its original focus
// (config, signatures, order client, route gating, catalogue pricing,
// secret hygiene) with the caller authenticated as the owner of a
// single workspace — which the route resolves by default — backed by
// an in-memory fake Supabase.
const wiringHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => wiringHolder.db,
}));
vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: async () => ({ id: 'user-owner', email: 'owner@example.com' }),
  unauthorized: () =>
    Response.json({ error: 'Unauthorized', message: 'Valid session required' }, { status: 401 }),
}));
import { createFakeSupabase } from './helpers/fake-supabase';

const SYNTH_KEY_ID = 'rzp_test_synthetic123';
const SYNTH_KEY_SECRET = 'synthetic-secret-value';
const SYNTH_WEBHOOK_SECRET = 'synthetic-webhook-secret';

describe('readRazorpayConfig', () => {
  it('reports not configured when env is empty', () => {
    const cfg = readRazorpayConfig({});
    expect(cfg.configured).toBe(false);
    expect(cfg.keyId).toBeNull();
    expect(cfg.keySecret).toBeNull();
    expect(cfg.webhookSecret).toBeNull();
    expect(isRazorpayConfigured({})).toBe(false);
  });

  it('reports not configured when only one key is present', () => {
    expect(readRazorpayConfig({ RAZORPAY_KEY_ID: SYNTH_KEY_ID }).configured).toBe(false);
    expect(readRazorpayConfig({ RAZORPAY_KEY_SECRET: SYNTH_KEY_SECRET }).configured).toBe(false);
  });

  it('treats blank/whitespace values as missing', () => {
    const cfg = readRazorpayConfig({ RAZORPAY_KEY_ID: '  ', RAZORPAY_KEY_SECRET: '' });
    expect(cfg.configured).toBe(false);
  });

  it('reports configured when both keys are present', () => {
    const env = {
      RAZORPAY_KEY_ID: SYNTH_KEY_ID,
      RAZORPAY_KEY_SECRET: SYNTH_KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: SYNTH_WEBHOOK_SECRET,
    };
    const cfg = readRazorpayConfig(env);
    expect(cfg.configured).toBe(true);
    expect(cfg.keyId).toBe(SYNTH_KEY_ID);
    expect(cfg.webhookSecret).toBe(SYNTH_WEBHOOK_SECRET);
    expect(isRazorpayConfigured(env)).toBe(true);
  });
});

describe('verifyRazorpayWebhookSignature', () => {
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_synth' } } } });
  const goodSig = createHmac('sha256', SYNTH_WEBHOOK_SECRET).update(body).digest('hex');

  it('accepts the genuine signature', () => {
    expect(verifyRazorpayWebhookSignature(body, goodSig, SYNTH_WEBHOOK_SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const other = createHmac('sha256', 'some-other-secret').update(body).digest('hex');
    expect(verifyRazorpayWebhookSignature(body, other, SYNTH_WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyRazorpayWebhookSignature(body + ' ', goodSig, SYNTH_WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects missing signature or secret without throwing', () => {
    expect(verifyRazorpayWebhookSignature(body, '', SYNTH_WEBHOOK_SECRET)).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, goodSig, '')).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, 'not-hex-at-all', SYNTH_WEBHOOK_SECRET)).toBe(false);
  });
});

describe('createRazorpayOrder', () => {
  const cfg = readRazorpayConfig({
    RAZORPAY_KEY_ID: SYNTH_KEY_ID,
    RAZORPAY_KEY_SECRET: SYNTH_KEY_SECRET,
  });

  it('posts amount/currency/receipt with Basic auth and maps the order', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const fakeFetch = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'order_synthetic1', entity: 'order', amount: 49900, amount_paid: 0,
          amount_due: 49900, currency: 'INR', receipt: 'opdm_starter', status: 'created',
          attempts: 0, created_at: 1762000000,
        }),
      };
    };
    const order = await createRazorpayOrder(
      cfg,
      { amountMinor: 49900, currency: 'INR', receipt: 'opdm_starter', notes: { planId: 'starter' } },
      fakeFetch,
    );
    expect(order.id).toBe('order_synthetic1');
    expect(order.amount).toBe(49900);
    expect(order.status).toBe('created');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RAZORPAY_ORDERS_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    const expectedAuth = 'Basic ' + Buffer.from(`${SYNTH_KEY_ID}:${SYNTH_KEY_SECRET}`).toString('base64');
    expect(headers.Authorization).toBe(expectedAuth);
    const sent = JSON.parse(calls[0]!.init.body as string) as { amount: number; currency: string };
    expect(sent.amount).toBe(49900);
    expect(sent.currency).toBe('INR');
  });

  it('throws RazorpayApiError on a provider error response', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be at least INR 1.00' } }),
    });
    await expect(
      createRazorpayOrder(cfg, { amountMinor: 50, currency: 'INR', receipt: 'x' }, fakeFetch),
    ).rejects.toBeInstanceOf(RazorpayApiError);
  });

  it('throws before any network call when not configured or amount invalid', async () => {
    const fakeFetch = async () => { throw new Error('must not be called'); };
    await expect(
      createRazorpayOrder(readRazorpayConfig({}), { amountMinor: 100, currency: 'INR', receipt: 'x' }, fakeFetch),
    ).rejects.toThrow(/not configured/);
    await expect(
      createRazorpayOrder(cfg, { amountMinor: 0, currency: 'INR', receipt: 'x' }, fakeFetch),
    ).rejects.toThrow(/positive integer/);
    await expect(
      createRazorpayOrder(cfg, { amountMinor: 10.5, currency: 'INR', receipt: 'x' }, fakeFetch),
    ).rejects.toThrow(/positive integer/);
  });
});

// ── Route: POST /api/billing/checkout ─────────────────────────────────────

const ENV_KEYS = [
  'BILLING_ENABLED', 'PAYMENTS_LIVE_MODE',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
] as const;
let savedEnv: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

function checkoutRequest(payload: unknown): Request {
  return new Request('https://app.opendm.in/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  vi.unstubAllGlobals();
  wiringHolder.db = createFakeSupabase({
    workspace_memberships: [
      { workspace_id: 'ws-1', user_id: 'user-owner', role: 'owner' },
    ],
  }).client;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe('POST /api/billing/checkout — gating', () => {
  it('is inert by default: 503 when no flags are set', async () => {
    setEnv({});
    const res = await POST(checkoutRequest({ planId: 'starter' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
  });

  it('returns 503 PAYMENTS_NOT_CONFIGURED when live mode is off', async () => {
    setEnv({
      BILLING_ENABLED: 'true',
      RAZORPAY_KEY_ID: SYNTH_KEY_ID,
      RAZORPAY_KEY_SECRET: SYNTH_KEY_SECRET,
    });
    const res = await POST(checkoutRequest({ planId: 'starter' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: 'PAYMENTS_NOT_CONFIGURED' });
  });

  it('returns 503 PAYMENTS_NOT_CONFIGURED when live mode is on but keys are missing', async () => {
    setEnv({ BILLING_ENABLED: 'true', PAYMENTS_LIVE_MODE: 'true' });
    const res = await POST(checkoutRequest({ planId: 'starter' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: 'PAYMENTS_NOT_CONFIGURED' });
  });
});

describe('POST /api/billing/checkout — configured', () => {
  const fullEnv = {
    BILLING_ENABLED: 'true',
    PAYMENTS_LIVE_MODE: 'true',
    RAZORPAY_KEY_ID: SYNTH_KEY_ID,
    RAZORPAY_KEY_SECRET: SYNTH_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: SYNTH_WEBHOOK_SECRET,
  };

  function stubOrderFetch(amount: number, currency: string): void {
    vi.stubGlobal('fetch', async (_url: string, init: Record<string, unknown>) => {
      const sent = JSON.parse(init.body as string) as { amount: number; currency: string };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'order_stubbed1', entity: 'order', amount: sent.amount, amount_paid: 0,
          amount_due: sent.amount, currency: sent.currency, receipt: 'opdm_x', status: 'created',
          attempts: 0, created_at: 1762000000,
        }),
      };
    });
  }

  it('creates an order at the catalogue monthly price for starter/INR (₹299 = 29900, owner-approved 2026-11-08)', async () => {
    setEnv(fullEnv);
    stubOrderFetch(29900, 'INR');
    const res = await POST(checkoutRequest({ planId: 'starter', currency: 'INR', period: 'monthly' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; keyId: string; planId: string;
      order: { id: string; amount: number; currency: string; status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.order.id).toBe('order_stubbed1');
    expect(body.order.amount).toBe(29900);
    expect(body.order.currency).toBe('INR');
    expect(body.keyId).toBe(SYNTH_KEY_ID);
    expect(JSON.stringify(body)).not.toContain(SYNTH_KEY_SECRET);
  });

  // Updated 2026-11-09 (customer fix D): annual billing is NOT
  // offered — the owner's pricing rules are monthly-only, and the
  // checkout route now rejects period 'annual' outright instead of
  // pricing it. The catalogue still carries annual totals as data;
  // they are simply not purchasable. (Was: 'uses the annual total
  // for annual billing (starter INR ₹2,868 = 286800)'.)
  it('rejects annual billing with 400 PERIOD_NOT_OFFERED (monthly-only pricing)', async () => {
    setEnv(fullEnv);
    stubOrderFetch(286800, 'INR');
    const res = await POST(checkoutRequest({ planId: 'starter', currency: 'INR', period: 'annual' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PERIOD_NOT_OFFERED');
  });

  it('defaults to INR monthly when currency/period are omitted', async () => {
    setEnv(fullEnv);
    stubOrderFetch(50000, 'INR');
    const res = await POST(checkoutRequest({ planId: 'creator-pro' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { amount: number; currency: string } };
    expect(body.order.amount).toBe(50000);
    expect(body.order.currency).toBe('INR');
  });

  it('rejects the free plan as not purchasable', async () => {
    setEnv(fullEnv);
    const res = await POST(checkoutRequest({ planId: 'free' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: 'PLAN_NOT_PURCHASABLE' });
  });

  it('rejects Enterprise as not purchasable — custom pricing is sold by conversation (owner instruction, 2026-11-08)', async () => {
    setEnv(fullEnv);
    const res = await POST(checkoutRequest({ planId: 'enterprise' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: 'PLAN_NOT_PURCHASABLE' });
  });

  it('rejects an unknown plan', async () => {
    setEnv(fullEnv);
    const res = await POST(checkoutRequest({ planId: 'platinum' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: 'UNKNOWN_PLAN' });
  });

  it('maps a provider failure to 502 PROVIDER_ERROR and never leaks the secret', async () => {
    setEnv(fullEnv);
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'UNAUTHORIZED', description: 'key authentication failed' } }),
    }));
    const res = await POST(checkoutRequest({ planId: 'starter' }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('PROVIDER_ERROR');
    expect(text).not.toContain(SYNTH_KEY_SECRET);
  });
});
