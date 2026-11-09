/**
 * Entitlement enforcement guard — Bug 2 fix (owner-approved
 * 2026-11-09; public-readiness-audit.md Bug 2: plan limits were
 * display-only because no mutation path consulted the service).
 *
 * Pins the guard contract the routes rely on:
 *  - ENTITLEMENTS_ENFORCED off ⇒ pure pass-through: the context thunk
 *    is never invoked and no decision is computed (today's behaviour,
 *    byte-for-byte).
 *  - Flag on ⇒ the workspace's subscription (trial + period lapse
 *    applied, exactly as the billing status route reads it) decides:
 *    over-limit blocks with a customer-readable message, within-limit
 *    passes, paid tiers' higher limits are respected.
 *  - Bug 1 × Bug 2: a period-lapsed paid subscription enforces at
 *    FREE limits.
 *  - The usage counters count only is_active rows, scoped by
 *    workspace or user as the routes use them.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFakeSupabase } from './helpers/fake-supabase';
import {
  evaluateEntitlementGate,
  planLimitResponse,
  countUserActiveAutomations,
  countUserInstagramAccounts,
  countWorkspaceActiveAutomations,
  countWorkspaceInstagramAccounts,
} from '@/lib/entitlements/guard';

const WS = '50000000-0000-4000-8000-000000000001';
const USER = 'user-guard-1';
const ON = { ENTITLEMENTS_ENFORCED: 'true' };
const OFF = {};
const FUTURE = '2027-01-01T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

function subRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub-guard-1',
    workspace_id: WS,
    plan_id: 'creator-pro',
    lifecycle_status: 'active',
    provider: 'razorpay',
    provider_subscription_id: null,
    provider_customer_id: null,
    billing_period: 'monthly',
    amount_minor: 50_000,
    currency: 'INR',
    current_period_start: '2026-10-01T00:00:00.000Z',
    current_period_end: FUTURE,
    trial_ends_at: null,
    cancel_at_period_end: false,
    raw: {},
    ...overrides,
  };
}

describe('entitlement guard — flag off is a pure pass-through (pre-fix behaviour)', () => {
  it('never resolves context, computes no check, never blocks', async () => {
    const fake = createFakeSupabase({ subscriptions: [subRow()] });
    let resolved = false;
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: OFF,
      resolveContext: async () => {
        resolved = true;
        return { workspaceId: WS, usage: { instagramAccounts: 999 } };
      },
    });
    expect(gate.blocked).toBe(false);
    expect(gate.check).toBeNull();
    expect(gate.message).toBeNull();
    expect(resolved).toBe(false);
  });
});

describe('entitlement guard — flag on enforces the resolved plan', () => {
  it('no subscription row (Free) + usage at the Free IG limit ⇒ blocked with a plan-limit refusal', async () => {
    const fake = createFakeSupabase();
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: ON,
      resolveContext: async () => ({ workspaceId: WS, usage: { instagramAccounts: 1 } }),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.check?.planId).toBe('free');
    expect(gate.check?.limit).toBe(1);
    expect(gate.message).toContain('Free plan includes up to 1 Instagram account.');

    const res = planLimitResponse(gate);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('PLAN_LIMIT_REACHED');
    expect(body.error).toBe(gate.message);
  });

  // Owner decision, 2026-11-10: active automations are UNLIMITED on
  // every plan (was: Free capped at 3) — the gate must never block
  // automation create/activate on count, even at extreme usage.
  it('Free + a huge automation count ⇒ allowed (automations unlimited, owner 2026-11-10)', async () => {
    const fake = createFakeSupabase();
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'activeAutomations',
      env: ON,
      resolveContext: async () => ({ workspaceId: WS, usage: { activeAutomations: 9999 } }),
    });
    expect(gate.blocked).toBe(false);
    expect(gate.check?.limit).toBeNull();
  });

  it('paid tier higher limits are respected (creator-pro: 3 accounts, 2 used ⇒ allowed)', async () => {
    const fake = createFakeSupabase({ subscriptions: [subRow()] });
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: ON,
      resolveContext: async () => ({ workspaceId: WS, usage: { instagramAccounts: 2 } }),
    });
    expect(gate.blocked).toBe(false);
    expect(gate.check?.planId).toBe('creator-pro');
    expect(gate.check?.limit).toBe(3);
  });

  it('paid tier at ITS limit still blocks', async () => {
    const fake = createFakeSupabase({ subscriptions: [subRow()] });
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: ON,
      resolveContext: async () => ({ workspaceId: WS, usage: { instagramAccounts: 3 } }),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.check?.planId).toBe('creator-pro');
  });

  it('Bug 1 × Bug 2: a period-lapsed paid subscription enforces at FREE limits', async () => {
    const fake = createFakeSupabase({ subscriptions: [subRow({ current_period_end: PAST })] });
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: ON,
      resolveContext: async () => ({ workspaceId: WS, usage: { instagramAccounts: 1 } }),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.check?.planId).toBe('free');
  });

  it('null workspace (unresolvable billing workspace) ⇒ Free plan decides', async () => {
    const fake = createFakeSupabase();
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: ON,
      resolveContext: async () => ({ workspaceId: null, usage: { instagramAccounts: 1 } }),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.check?.planId).toBe('free');
  });

  // Owner decision, 2026-11-10: even when the workspace cannot be
  // resolved (Free decides), the automations dimension stays
  // unlimited — allowed at any count.
  it('null workspace + automations ⇒ still unlimited (owner 2026-11-10)', async () => {
    const fake = createFakeSupabase();
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'activeAutomations',
      env: ON,
      resolveContext: async () => ({ workspaceId: null, usage: { activeAutomations: 9999 } }),
    });
    expect(gate.blocked).toBe(false);
    expect(gate.check?.planId).toBe('free');
    expect(gate.check?.limit).toBeNull();
  });
});

describe('entitlement guard — usage counters', () => {
  it('count only is_active rows, in the requested scope', async () => {
    const fake = createFakeSupabase({
      instagram_accounts: [
        { id: 'a1', user_id: USER, workspace_id: WS, is_active: true },
        { id: 'a2', user_id: USER, workspace_id: WS, is_active: true },
        { id: 'a3', user_id: USER, workspace_id: WS, is_active: false },
        { id: 'a4', user_id: 'someone-else', workspace_id: 'other-ws', is_active: true },
      ],
      automations: [
        { id: 'm1', user_id: USER, workspace_id: WS, is_active: true },
        { id: 'm2', user_id: USER, workspace_id: null, is_active: true },
        { id: 'm3', user_id: USER, workspace_id: WS, is_active: false },
      ],
    });
    const db = fake.client as unknown as SupabaseClient;
    expect(await countWorkspaceInstagramAccounts(db, WS)).toBe(2);
    expect(await countUserInstagramAccounts(db, USER)).toBe(2);
    expect(await countWorkspaceActiveAutomations(db, WS)).toBe(1);
    expect(await countUserActiveAutomations(db, USER)).toBe(2);
  });
});
