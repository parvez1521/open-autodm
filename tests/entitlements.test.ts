/**
 * Phase 13 — entitlement service tests.
 * Pins: plan resolution (incl. Free default for missing/unknown/inactive),
 * every limit dimension at/over limit, log-only mode still computes,
 * catalogue-driven limit changes take effect without code change.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveEntitlement,
  checkEntitlement,
  evaluateAllEntitlements,
  type WorkspaceSubscription,
} from '@/lib/entitlements/service';
import { getPlan } from '@/lib/billing/catalogue';
import type { SaasFlags } from '@/lib/billing/flags';

const ENFORCED: SaasFlags = { publicSignupEnabled: false, entitlementsEnforced: true };
const LOG_ONLY: SaasFlags = { publicSignupEnabled: false, entitlementsEnforced: false };

const active = (planId: string): WorkspaceSubscription => ({ workspaceId: 'ws-1', planId, status: 'active' });

describe('entitlements: plan resolution', () => {
  it('resolves an active paid subscription to its catalogue plan', () => {
    const r = resolveEntitlement(active('creator-pro'));
    expect(r.plan.id).toBe('creator-pro');
    expect(r.resolution).toBe('active-subscription');
    expect(r.dataRetentionDays).toBe(getPlan('creator-pro').dataRetentionDays);
    expect(r.supportLevel).toBe(getPlan('creator-pro').supportLevel);
  });
  it('resolves a trialing subscription to its plan', () => {
    const r = resolveEntitlement({ workspaceId: 'ws-1', planId: 'starter', status: 'trialing' });
    expect(r.plan.id).toBe('starter');
    expect(r.resolution).toBe('trialing-subscription');
  });
  it('missing subscription ⇒ Free default, never unlimited', () => {
    for (const sub of [null, undefined, { workspaceId: 'w', planId: null, status: null }] as const) {
      const r = resolveEntitlement(sub as never);
      expect(r.plan.id).toBe('free');
      expect(r.resolution).toBe('free-default-no-subscription');
      expect(r.plan.limits.dmsPerMonth).toBe(getPlan('free').limits.dmsPerMonth);
      expect(Number.isFinite(r.plan.limits.dmsPerMonth)).toBe(true);
    }
  });
  it('unknown plan id ⇒ Free default', () => {
    const r = resolveEntitlement(active('platinum-ultra'));
    expect(r.plan.id).toBe('free');
    expect(r.resolution).toBe('free-default-unknown-plan');
  });
  it('cancelled / expired / past_due / paused / incomplete ⇒ Free default', () => {
    for (const status of ['cancelled', 'expired', 'past_due', 'paused', 'incomplete'] as const) {
      const r = resolveEntitlement({ workspaceId: 'ws-1', planId: 'agency', status });
      expect(r.plan.id, status).toBe('free');
      expect(r.resolution).toBe('free-default-inactive-subscription');
    }
  });
});

describe('entitlements: limit dimensions', () => {
  const free = getPlan('free');
  const cases: { dimension: Parameters<typeof checkEntitlement>[1]; usage: Record<string, number>; limit: number }[] = [
    { dimension: 'instagramAccounts', usage: { instagramAccounts: free.limits.instagramAccounts }, limit: free.limits.instagramAccounts },
    { dimension: 'activeAutomations', usage: { activeAutomations: free.limits.activeAutomations }, limit: free.limits.activeAutomations },
    { dimension: 'dmsPerMonth', usage: { dmsThisMonth: free.limits.dmsPerMonth }, limit: free.limits.dmsPerMonth },
    { dimension: 'aiDrafting', usage: { aiDraftingThisMonth: free.limits.aiDraftingGenerationsPerMonth }, limit: free.limits.aiDraftingGenerationsPerMonth },
    { dimension: 'scriptWriter', usage: { scriptWriterThisMonth: free.limits.scriptWriterGenerationsPerMonth }, limit: free.limits.scriptWriterGenerationsPerMonth },
    { dimension: 'teamSeats', usage: { teamSeatsUsed: free.limits.teamSeats }, limit: free.limits.teamSeats },
    { dimension: 'followUpsPerMonth', usage: { followUpsThisMonth: free.limits.followUpsPerMonth }, limit: free.limits.followUpsPerMonth },
    { dimension: 'contactsPerMonth', usage: { contactsThisMonth: free.limits.contactsPerMonth }, limit: free.limits.contactsPerMonth },
    { dimension: 'workspaces', usage: { workspacesOwned: free.limits.workspaces }, limit: free.limits.workspaces },
  ];
  for (const c of cases) {
    it(`${c.dimension}: at limit blocks one more; one below allows`, () => {
      const atLimit = checkEntitlement(null, c.dimension, c.usage, { flags: ENFORCED });
      expect(atLimit.limit).toBe(c.limit);
      expect(atLimit.allowed).toBe(false);
      expect(atLimit.effectiveAllowed).toBe(false);
      const belowKey = Object.keys(c.usage)[0]!;
      const below = checkEntitlement(null, c.dimension, { [belowKey]: c.limit - 1 }, { flags: ENFORCED });
      expect(below.allowed).toBe(true);
      expect(below.reason).toBe('within-limit');
    });
    it(`${c.dimension}: over limit reports over/at-limit reason with limit+used`, () => {
      const belowKey = Object.keys(c.usage)[0]!;
      const over = checkEntitlement(null, c.dimension, { [belowKey]: c.limit + 5 }, { flags: ENFORCED });
      expect(over.allowed).toBe(false);
      expect(over.used).toBe(c.limit + 5);
      expect(over.limit).toBe(c.limit);
    });
  }
  it('paid plan raises the ceiling (agency DM limit > free)', () => {
    const r = checkEntitlement(active('agency'), 'dmsPerMonth', { dmsThisMonth: 1000 }, { flags: ENFORCED });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(getPlan('agency').limits.dmsPerMonth);
    expect(r.planId).toBe('agency');
  });
  it('requested > 1 is accounted (batch connect)', () => {
    const r = checkEntitlement(active('creator-pro'), 'instagramAccounts', { instagramAccounts: 2 }, { requested: 2, flags: ENFORCED });
    expect(r.allowed).toBe(false); // 2 used + 2 requested > 3 limit
  });
});

describe('entitlements: log-only mode', () => {
  it('ENTITLEMENTS_ENFORCED=false still COMPUTES the decision but passes through', () => {
    const r = checkEntitlement(null, 'dmsPerMonth', { dmsThisMonth: 999999 }, { flags: LOG_ONLY });
    expect(r.allowed).toBe(false); // computed honestly
    expect(r.enforced).toBe(false);
    expect(r.effectiveAllowed).toBe(true); // pass-through
    expect(r.limit).toBe(getPlan('free').limits.dmsPerMonth);
  });
  it('flipping the flag changes effectiveAllowed without changing the computed decision', () => {
    const usage = { dmsThisMonth: 999999 };
    const off = checkEntitlement(null, 'dmsPerMonth', usage, { flags: LOG_ONLY });
    const on = checkEntitlement(null, 'dmsPerMonth', usage, { flags: ENFORCED });
    expect(off.allowed).toBe(on.allowed);
    expect(off.effectiveAllowed).toBe(true);
    expect(on.effectiveAllowed).toBe(false);
  });
  it('evaluateAll covers all nine dimensions', () => {
    const { checks, resolved } = evaluateAllEntitlements(active('starter'), {}, { flags: LOG_ONLY });
    expect(resolved.plan.id).toBe('starter');
    expect(checks).toHaveLength(9);
  });
});

describe('entitlements: catalogue-driven limits', () => {
  it('a catalogue limit change takes effect with no service code change', async () => {
    // The service reads getPlan() at call time; mutating the catalogue
    // object (as an owner-approved catalogue edit would) is immediately
    // reflected. Restored in finally so other tests are unaffected.
    const plan = getPlan('free') as { limits: { dmsPerMonth: number } };
    const original = plan.limits.dmsPerMonth;
    try {
      plan.limits.dmsPerMonth = 7;
      const r = checkEntitlement(null, 'dmsPerMonth', { dmsThisMonth: 7 }, { flags: ENFORCED });
      expect(r.limit).toBe(7);
      expect(r.allowed).toBe(false);
    } finally {
      plan.limits.dmsPerMonth = original;
    }
    const after = checkEntitlement(null, 'dmsPerMonth', { dmsThisMonth: 7 }, { flags: ENFORCED });
    expect(after.limit).toBe(original);
    expect(after.allowed).toBe(true);
  });
});
