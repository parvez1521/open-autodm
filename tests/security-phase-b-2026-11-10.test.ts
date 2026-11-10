/**
 * Security audit Phase B (2026-11-10) — the three surgical fixes:
 *
 *   1. Baseline security headers via next.config.ts headers()
 *      (finding #9): nosniff, referrer-policy, permissions-policy,
 *      X-Frame-Options DENY + a minimal CSP of frame-ancestors 'none'
 *      ONLY (no full enforcing CSP — that is the risky bucket).
 *   2. Per-user rate limiting on the billing mutations (finding #8):
 *      POST /api/billing/checkout, /api/billing/trial and
 *      /api/billing/plan-choice now run behind the shared
 *      createPerUserRateLimiter (10/min, 50/day — the Studio AI /
 *      script-writer convention): the 11th rapid authenticated POST
 *      from one user is refused 429 RATE_LIMITED, another user is
 *      unaffected, and unauthenticated calls still 401 first.
 *   3. GET /api/setup metaAppId redaction is covered in
 *      tests/setup-route.test.ts + tests/e2e/e2e-auth-owner-gating
 *      (updated expectations: non-owner → null, owner unchanged).
 *
 * Billing routes are exercised with SYNTHETIC keys, an in-memory fake
 * Supabase and a stubbed fetch — no network, no database — mirroring
 * tests/billing-subscription-wiring.test.ts discipline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createFakeSupabase, type FakeSupabase } from './helpers/fake-supabase';
import nextConfig from '../next.config';

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
import { POST as trialPOST } from '@/app/api/billing/trial/route';
import { POST as planChoicePOST } from '@/app/api/billing/plan-choice/route';

// ── Fixtures ────────────────────────────────────────────────────────────
const KEY_ID = 'rzp_test_synthetic123';
const KEY_SECRET = 'rzp_test_secret_synthetic';
const WH_SECRET = 'whsec_synthetic';

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const OTHER = { id: 'user-other', email: 'other@example.com' };
const WS1 = 'ws-1';

let fake: FakeSupabase;

function baseSeed() {
  return {
    workspace_memberships: [
      { workspace_id: WS1, user_id: OWNER.id, role: 'owner' },
      { workspace_id: WS1, user_id: OTHER.id, role: 'owner' },
    ],
    subscriptions: [] as Record<string, unknown>[],
    billing_orders: [] as Record<string, unknown>[],
    billing_events: [] as Record<string, unknown>[],
  };
}

// ── Razorpay fetch stub (order creation only) ───────────────────────────
let orderCounter = 0;
function stubRazorpayFetch() {
  vi.stubGlobal('fetch', async (url: string, init: Record<string, unknown>) => {
    const u = String(url);
    if (u.endsWith('/v1/orders') && init.method === 'POST') {
      const sent = JSON.parse(init.body as string) as { amount: number; currency: string };
      orderCounter += 1;
      const id = `order_test_${orderCounter}`;
      return {
        ok: true, status: 200,
        json: async () => ({
          id, entity: 'order', amount: sent.amount, amount_paid: 0, amount_due: sent.amount,
          currency: sent.currency, receipt: 'opdm_x', status: 'created', attempts: 0, created_at: 1762000000,
        }),
      };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  });
}

// ── Env management ──────────────────────────────────────────────────────
const ENV_KEYS = [
  'BILLING_ENABLED', 'PAYMENTS_LIVE_MODE',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
  'CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_ENV',
] as const;
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
  orderCounter = 0;
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

function jsonPost(url: string, payload: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ══ 1. Baseline security headers ════════════════════════════════════════
describe('next.config.ts — baseline security headers (Phase B #1)', () => {
  it('applies the five baseline headers site-wide, with ONLY frame-ancestors in the CSP', async () => {
    expect(typeof nextConfig.headers).toBe('function');
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*');
    const byKey = new Map(rules[0]!.headers.map((h) => [h.key, h.value]));
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(byKey.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    // Minimal CSP: frame-ancestors only — no default-src/script-src/etc.
    expect(byKey.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });
});

// ══ 2. Billing mutation rate limiting ═══════════════════════════════════
describe('billing rate limiting (Phase B #2)', () => {
  it('checkout: the 11th rapid POST from one user is 429 RATE_LIMITED; another user is unaffected', async () => {
    const req = () => jsonPost('https://app.opendm.in/api/billing/checkout', { planId: 'starter', workspaceId: WS1 });
    for (let i = 0; i < 10; i++) {
      const res = await checkoutPOST(req());
      expect(res.status).toBe(200);
    }
    const refused = await checkoutPOST(req());
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('RATE_LIMITED');
    expect(fake.rows('billing_orders')).toHaveLength(10); // the refused call created nothing

    holder.user = OTHER;
    const otherRes = await checkoutPOST(req());
    expect(otherRes.status).toBe(200);
  });

  it('trial: the 11th rapid POST from one user is 429 RATE_LIMITED', async () => {
    const req = () => jsonPost('https://app.opendm.in/api/billing/trial', { planId: 'starter', workspaceId: WS1 });
    for (let i = 0; i < 10; i++) {
      const res = await trialPOST(req());
      expect(res.status).toBe(200); // first starts the trial, the rest are idempotent reads of it
    }
    const refused = await trialPOST(req());
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe('RATE_LIMITED');
  });

  it('plan-choice: the 11th rapid POST from one user is 429 RATE_LIMITED; unauthenticated still 401s', async () => {
    // plan-choice writes through the service-role admin API — swap the
    // fake DB for an admin stub for this route.
    holder.db = {
      auth: {
        admin: {
          getUserById: async () => ({ data: { user: { id: OWNER.id, app_metadata: {} } }, error: null }),
          updateUserById: async () => ({ data: {}, error: null }),
        },
      },
    };
    const req = () => new Request('https://opendm.in/api/billing/plan-choice', { method: 'POST' });
    for (let i = 0; i < 10; i++) {
      const res = await planChoicePOST(req());
      expect(res.status).toBe(200);
    }
    const refused = await planChoicePOST(req());
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe('RATE_LIMITED');

    holder.user = null;
    const anon = await planChoicePOST(req());
    expect(anon.status).toBe(401);
  });
});

// ══ 3. Wiring pins — every billing mutation route carries the limiter ═══
describe('billing limiter wiring pins (Phase B #2)', () => {
  it('checkout, trial and plan-choice all use the shared createPerUserRateLimiter with a 429 shape', () => {
    for (const rel of [
      'src/app/api/billing/checkout/route.ts',
      'src/app/api/billing/trial/route.ts',
      'src/app/api/billing/plan-choice/route.ts',
    ]) {
      const src = readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(src).toContain("createPerUserRateLimiter");
      expect(src).toContain('status: 429');
      expect(src).toContain('"RATE_LIMITED"');
    }
  });
});
