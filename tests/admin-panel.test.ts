/**
 * Owner admin panel (/admin) — gate + data pins (2026-11-09).
 *
 * The panel is the owner's subscriber list over the REAL billing
 * tables. Two things are pinned here:
 *
 *  1. THE GATE (lib/admin/panel.ts + the page): access requires the
 *     verified session email to be listed in ADMIN_EMAILS. Unset
 *     env admits NOBODY; non-admins and anonymous visitors get the
 *     notFound() 404 (panel existence not revealed); and the
 *     service-role client is never constructed for a denied
 *     request — asserted behaviourally via the mock call counter.
 *
 *  2. THE DATA SHAPE (loadAdminOverview over FakeSupabase): who
 *     qualifies as a customer (real subscription OR paid order —
 *     a plain free workspace does not), owner-email resolution
 *     (owner membership, created_by fallback), order-status
 *     mapping, and the per-currency monthly plan value (annual
 *     plans contribute floor(amount/12); currencies never summed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import {
  parseAdminEmails,
  isAdminEmail,
  loadAdminOverview,
  type AdminAuthUser,
} from '@/lib/admin/panel';

// ── Gate units ──────────────────────────────────────────────────────

describe('ADMIN_EMAILS gate (unit)', () => {
  it('an unset or empty allowlist admits nobody — not even a plausible owner', () => {
    expect(parseAdminEmails({}).size).toBe(0);
    expect(parseAdminEmails({ ADMIN_EMAILS: '' }).size).toBe(0);
    expect(parseAdminEmails({ ADMIN_EMAILS: '  , , ' }).size).toBe(0);
    expect(isAdminEmail('owner@example.test', {})).toBe(false);
    expect(isAdminEmail('owner@example.test', { ADMIN_EMAILS: '' })).toBe(false);
  });

  it('matching is case-insensitive and trims list entries and the candidate', () => {
    const env = { ADMIN_EMAILS: ' Owner@Example.test , second@example.test ' };
    expect(isAdminEmail('owner@example.test', env)).toBe(true);
    expect(isAdminEmail('OWNER@EXAMPLE.TEST', env)).toBe(true);
    expect(isAdminEmail(' second@example.test ', env)).toBe(true);
    expect(isAdminEmail('third@example.test', env)).toBe(false);
  });

  it('a missing session email is never an admin', () => {
    const env = { ADMIN_EMAILS: 'owner@example.test' };
    expect(isAdminEmail(null, env)).toBe(false);
    expect(isAdminEmail(undefined, env)).toBe(false);
    expect(isAdminEmail('', env)).toBe(false);
  });
});

// ── Fixtures ────────────────────────────────────────────────────────

const USERS: AdminAuthUser[] = [
  { id: 'user-a', email: 'a@example.test', createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'user-b', email: 'b@example.test', createdAt: '2026-09-02T00:00:00.000Z' },
  { id: 'user-c', email: 'c@example.test', createdAt: '2026-09-03T00:00:00.000Z' },
  { id: 'user-d', email: 'd@example.test', createdAt: '2026-09-04T00:00:00.000Z' },
  { id: 'user-e', email: 'e@example.test', createdAt: '2026-09-05T00:00:00.000Z' },
  { id: 'user-z', email: 'z@example.test', createdAt: '2026-09-06T00:00:00.000Z' },
];

function seedFake(): FakeSupabase {
  const fake = new FakeSupabase();
  fake.seed('subscriptions', [
    { workspace_id: 'ws-alpha', plan_id: 'starter', lifecycle_status: 'active', provider: 'cashfree', billing_period: 'monthly', amount_minor: 29900, currency: 'INR', current_period_end: '2026-12-09T00:00:00.000Z' },
    { workspace_id: 'ws-beta', plan_id: 'creator-pro', lifecycle_status: 'trialing', provider: 'cashfree', billing_period: 'monthly', amount_minor: 50000, currency: 'INR', current_period_end: null },
    { workspace_id: 'ws-gamma', plan_id: 'agency', lifecycle_status: 'active', provider: 'razorpay', billing_period: 'annual', amount_minor: 958800, currency: 'INR', current_period_end: '2027-11-01T00:00:00.000Z' },
    { workspace_id: 'ws-delta', plan_id: 'free', lifecycle_status: 'free', provider: null, billing_period: null, amount_minor: 0, currency: 'INR', current_period_end: null },
    { workspace_id: 'ws-zeta', plan_id: 'starter', lifecycle_status: 'active', provider: 'cashfree', billing_period: 'monthly', amount_minor: 900, currency: 'USD', current_period_end: '2026-12-05T00:00:00.000Z' },
  ] as FakeRow[]);
  fake.seed('billing_orders', [
    { id: 'o1', workspace_id: 'ws-alpha', provider: 'cashfree', plan_id: 'starter', billing_period: 'monthly', amount_minor: 29900, currency: 'INR', status: 'paid', created_at: '2026-11-09T10:00:00.000Z' },
    { id: 'o2', workspace_id: 'ws-alpha', provider: 'cashfree', plan_id: 'starter', billing_period: 'monthly', amount_minor: 29900, currency: 'INR', status: 'created', created_at: '2026-11-08T10:00:00.000Z' },
    { id: 'o3', workspace_id: 'ws-beta', provider: 'cashfree', plan_id: 'creator-pro', billing_period: 'monthly', amount_minor: 50000, currency: 'INR', status: 'failed', created_at: '2026-11-07T10:00:00.000Z' },
    { id: 'o4', workspace_id: 'ws-epsilon', provider: 'razorpay', plan_id: 'starter', billing_period: 'monthly', amount_minor: 29900, currency: 'INR', status: 'paid', created_at: '2026-11-06T10:00:00.000Z' },
    { id: 'o5', workspace_id: 'ws-gamma', provider: 'razorpay', plan_id: 'agency', billing_period: 'annual', amount_minor: 958800, currency: 'INR', status: 'paid', created_at: '2026-11-01T10:00:00.000Z' },
    { id: 'o6', workspace_id: 'ws-zeta', provider: 'cashfree', plan_id: 'starter', billing_period: 'monthly', amount_minor: 900, currency: 'USD', status: 'paid', created_at: '2026-11-05T10:00:00.000Z' },
    { id: 'o7', workspace_id: 'ws-delta', provider: 'cashfree', plan_id: 'starter', billing_period: 'monthly', amount_minor: 29900, currency: 'INR', status: 'expired', created_at: '2026-11-04T10:00:00.000Z' },
  ] as FakeRow[]);
  fake.seed('workspaces', [
    { id: 'ws-alpha', name: 'Alpha Studio', created_by: 'user-a', created_at: '2026-10-01T00:00:00.000Z' },
    { id: 'ws-beta', name: 'Beta Media', created_by: 'user-b', created_at: '2026-10-05T00:00:00.000Z' },
    { id: 'ws-gamma', name: 'Gamma Labs', created_by: 'user-c', created_at: '2026-09-15T00:00:00.000Z' },
    { id: 'ws-delta', name: 'Delta Free', created_by: 'user-d', created_at: '2026-10-10T00:00:00.000Z' },
    { id: 'ws-epsilon', name: 'Epsilon Co', created_by: 'user-e', created_at: '2026-10-20T00:00:00.000Z' },
    { id: 'ws-zeta', name: 'Zeta Inc', created_by: 'user-z', created_at: '2026-10-25T00:00:00.000Z' },
  ] as FakeRow[]);
  fake.seed('workspace_memberships', [
    { workspace_id: 'ws-alpha', user_id: 'user-a', role: 'owner' },
    { workspace_id: 'ws-beta', user_id: 'user-b', role: 'owner' },
    { workspace_id: 'ws-delta', user_id: 'user-d', role: 'owner' },
    { workspace_id: 'ws-epsilon', user_id: 'user-e', role: 'owner' },
    { workspace_id: 'ws-zeta', user_id: 'user-z', role: 'owner' },
    // ws-gamma deliberately has NO owner membership: created_by fallback.
  ] as FakeRow[]);
  return fake;
}

// ── Data shape ──────────────────────────────────────────────────────

describe('loadAdminOverview (data shape)', () => {
  it('lists exactly the workspaces with a real subscription or a paid order', async () => {
    const overview = await loadAdminOverview(seedFake() as unknown as SupabaseClient, USERS);
    expect(overview.subscribers.map((s) => s.workspaceId)).toEqual([
      'ws-zeta', 'ws-epsilon', 'ws-beta', 'ws-alpha', 'ws-gamma', // newest workspace first
    ]);
    // ws-delta (plain free row + only an expired order) is NOT a customer.
    expect(overview.summary.totalCustomers).toBe(5);
  });

  it('resolves owner emails via owner membership, falling back to created_by', async () => {
    const overview = await loadAdminOverview(seedFake() as unknown as SupabaseClient, USERS);
    const byId = new Map(overview.subscribers.map((s) => [s.workspaceId, s]));
    expect(byId.get('ws-alpha')?.ownerEmail).toBe('a@example.test');
    expect(byId.get('ws-gamma')?.ownerEmail).toBe('c@example.test'); // fallback path
    expect(byId.get('ws-alpha')?.planName).toBe('Starter');
    expect(byId.get('ws-gamma')?.planName).toBe('Pro');
    expect(byId.get('ws-alpha')?.currentPeriodEnd).toBe('2026-12-09T00:00:00.000Z');
  });

  it('an order-only workspace shows its latest paid order, status no-subscription', async () => {
    const overview = await loadAdminOverview(seedFake() as unknown as SupabaseClient, USERS);
    const eps = overview.subscribers.find((s) => s.workspaceId === 'ws-epsilon');
    expect(eps?.status).toBe('no-subscription');
    expect(eps?.planId).toBe('starter');
    expect(eps?.provider).toBe('razorpay');
    expect(eps?.amountMinor).toBe(29900);
    expect(eps?.ownerEmail).toBe('e@example.test');
  });

  it('summary: active count, paid count, per-currency monthly plan value (never cross-summed)', async () => {
    const overview = await loadAdminOverview(seedFake() as unknown as SupabaseClient, USERS);
    expect(overview.summary.activeSubscriptions).toBe(3); // alpha, gamma, zeta (beta is trialing)
    expect(overview.summary.paidOrders).toBe(4); // o1, o4, o5, o6
    // INR: 29900 monthly + floor(958800 / 12) = 79900 → 109800. USD: 900.
    expect(overview.summary.monthlyPlanValueByCurrency).toEqual({ INR: 109800, USD: 900 });
  });

  it('recent orders are newest-first with provider statuses mapped (created → pending)', async () => {
    const overview = await loadAdminOverview(seedFake() as unknown as SupabaseClient, USERS);
    expect(overview.recentOrders.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4', 'o6', 'o7', 'o5']);
    const byId = new Map(overview.recentOrders.map((o) => [o.id, o]));
    expect(byId.get('o1')?.status).toBe('paid');
    expect(byId.get('o2')?.status).toBe('pending');
    expect(byId.get('o3')?.status).toBe('failed');
    expect(byId.get('o7')?.status).toBe('expired');
    expect(byId.get('o1')?.ownerEmail).toBe('a@example.test');
    expect(byId.get('o4')?.workspaceName).toBe('Epsilon Co');
  });

  it('an empty store yields an empty, zeroed overview — no fabricated rows', async () => {
    const overview = await loadAdminOverview(new FakeSupabase() as unknown as SupabaseClient, []);
    expect(overview.subscribers).toEqual([]);
    expect(overview.recentOrders).toEqual([]);
    expect(overview.summary).toEqual({
      totalCustomers: 0,
      activeSubscriptions: 0,
      paidOrders: 0,
      monthlyPlanValueByCurrency: {},
    });
  });
});

// ── Page gate (behavioural, mocked session + service client) ────────

const hoisted = vi.hoisted(() => {
  class NotFoundSentinel extends Error {
    constructor() {
      super('NOT_FOUND_SENTINEL');
      this.name = 'NotFoundSentinel';
    }
  }
  return {
    NotFoundSentinel,
    sessionUser: null as { email?: string } | null,
    serviceClient: null as unknown,
    serviceClientCalls: 0,
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [] }),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new hoisted.NotFoundSentinel();
  },
}));

vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: hoisted.sessionUser } }) },
  }),
  createBrowserClient: () => {
    throw new Error('the admin page must never build a browser client');
  },
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => {
    hoisted.serviceClientCalls += 1;
    return hoisted.serviceClient;
  },
}));

/**
 * Load the real page component the way the customer-journey harness
 * loads .tsx pages: esbuild-transform the source into a temp module
 * inside the project (so @/ imports resolve as the app build would)
 * and import it. The vi.mock registrations above intercept its
 * next/headers, next/navigation and Supabase imports.
 */
async function loadAdminPage(): Promise<{ default: () => Promise<unknown> }> {
  const src = readFileSync(
    path.resolve(process.cwd(), 'src/app/(admin)/admin/page.tsx'),
    'utf8',
  );
  const { code } = transformSync(src, { loader: 'tsx', jsx: 'automatic', format: 'esm', target: 'es2022' });
  const tmpDir = path.resolve(process.cwd(), 'tests/.admin-tmp');
  mkdirSync(tmpDir, { recursive: true });
  const name = `page-${Math.random().toString(36).slice(2)}.mjs`;
  writeFileSync(path.join(tmpDir, name), code);
  try {
    return (await import(`./.admin-tmp/${name}`)) as { default: () => Promise<unknown> };
  } finally {
    unlinkSync(path.join(tmpDir, name));
  }
}

function makeServiceClient(fake: FakeSupabase): unknown {
  return Object.assign(fake, {
    auth: {
      admin: {
        listUsers: async ({ page }: { page: number; perPage: number }) => ({
          data: {
            users:
              page === 1
                ? USERS.map((u) => ({ id: u.id, email: u.email ?? undefined, created_at: u.createdAt ?? undefined }))
                : [],
          },
          error: null,
        }),
      },
    },
  });
}

describe('/admin page gate', () => {
  const savedEnv = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    hoisted.sessionUser = null;
    hoisted.serviceClientCalls = 0;
    hoisted.serviceClient = makeServiceClient(seedFake());
    delete process.env.ADMIN_EMAILS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedEnv;
  });

  it('anonymous visitor → 404 (notFound), and the service client is never constructed', async () => {
    process.env.ADMIN_EMAILS = 'owner@example.test';
    hoisted.sessionUser = null;
    const page = await loadAdminPage();
    await expect(page.default()).rejects.toBeInstanceOf(hoisted.NotFoundSentinel);
    expect(hoisted.serviceClientCalls).toBe(0);
  });

  it('signed-in non-admin → 404, service client never constructed', async () => {
    process.env.ADMIN_EMAILS = 'owner@example.test';
    hoisted.sessionUser = { email: 'a@example.test' }; // a real customer + workspace owner
    const page = await loadAdminPage();
    await expect(page.default()).rejects.toBeInstanceOf(hoisted.NotFoundSentinel);
    expect(hoisted.serviceClientCalls).toBe(0);
  });

  it('ADMIN_EMAILS unset → 404 even for the would-be owner', async () => {
    delete process.env.ADMIN_EMAILS;
    hoisted.sessionUser = { email: 'owner@example.test' };
    const page = await loadAdminPage();
    await expect(page.default()).rejects.toBeInstanceOf(hoisted.NotFoundSentinel);
    expect(hoisted.serviceClientCalls).toBe(0);
  });

  it('listed admin (any case) → renders the real subscriber data', async () => {
    process.env.ADMIN_EMAILS = ' Owner@Example.test ';
    hoisted.sessionUser = { email: 'owner@example.test' };
    const page = await loadAdminPage();
    const element = (await page.default()) as React.ReactElement;
    expect(hoisted.serviceClientCalls).toBe(1);
    const html = renderToStaticMarkup(element);
    expect(html).toContain('data-testid="admin-panel"');
    expect(html).toContain('a@example.test');
    expect(html).toContain('e@example.test');
    expect(html).toContain('Alpha Studio');
    expect(html).toContain('Starter');
    expect(html).toContain('no-subscription');
    expect(html).toContain('pending');
    // Summary: monthly plan value per currency — INR 109800 minor → ₹1,098; USD 900 → $9.
    expect(html).toContain('₹1,098');
    expect(html).toContain('$9');
    // No synthetic/prototype residue in the real panel.
    expect(html).not.toContain('synthetic');
  });
});

// ── Source pins ─────────────────────────────────────────────────────

describe('/admin panel source pins', () => {
  const pageSrc = readFileSync(
    path.resolve(process.cwd(), 'src/app/(admin)/admin/page.tsx'),
    'utf8',
  );
  const panelSrc = readFileSync(path.resolve(process.cwd(), 'src/lib/admin/panel.ts'), 'utf8');

  it('the page gates with notFound() behind the ADMIN_EMAILS check and renders per-request', () => {
    expect(pageSrc).toContain('isAdminEmail');
    expect(pageSrc).toContain('notFound()');
    expect(pageSrc).toContain('export const dynamic = "force-dynamic"');
  });

  it('the real panel carries no prototype machinery', () => {
    expect(pageSrc).not.toContain('createSyntheticAdminStore');
    expect(pageSrc).not.toContain('evaluatePlatformAdminGate');
    expect(pageSrc).not.toContain('AdminAccessDenied');
  });

  it('no email address is hardcoded in the panel code — ADMIN_EMAILS is the only source', () => {
    const emailShape = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
    expect(pageSrc).not.toMatch(emailShape);
    expect(panelSrc).not.toMatch(emailShape);
    expect(panelSrc).toContain('ADMIN_EMAILS');
  });

  it('the only Auth admin API the page uses is the read-only listUsers', () => {
    const methods = [...pageSrc.matchAll(/auth\.admin\.(\w+)\s*\(/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['listUsers']));
  });
});
