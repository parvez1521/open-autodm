/**
 * Phase 13 — entitlement service tests.
 * Pins: plan resolution (incl. Free default for missing/unknown/inactive),
 * every capped limit dimension at/over limit, log-only mode still computes,
 * catalogue-driven limit changes take effect without code change.
 * (DMs are the one uncapped dimension — unlimited on every plan since
 * the owner's 2026-11-09 decision; pinned in their own describe.)
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
  it('missing subscription ⇒ Free default (DMs unlimited there too — owner, 2026-11-09)', () => {
    for (const sub of [null, undefined, { workspaceId: 'w', planId: null, status: null }] as const) {
      const r = resolveEntitlement(sub as never);
      expect(r.plan.id).toBe('free');
      expect(r.resolution).toBe('free-default-no-subscription');
      expect(r.plan.limits.dmsPerMonth).toBe(getPlan('free').limits.dmsPerMonth);
      // Owner decision, 2026-11-09: the Free default's DM limit is
      // null (unlimited) like every other plan's — resolution to
      // Free no longer caps DM volume.
      expect(r.plan.limits.dmsPerMonth).toBeNull();
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
    // dmsPerMonth is NOT in this loop: since the owner's 2026-11-09
    // decision it is null (unlimited) on every plan, so there is no
    // at-limit state to pin here — it has its own describe below.
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
  it('paid plan DM check: unlimited there too (owner, 2026-11-09)', () => {
    const r = checkEntitlement(active('agency'), 'dmsPerMonth', { dmsThisMonth: 1000 }, { flags: ENFORCED });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBeNull();
    expect(r.planId).toBe('agency');
  });
  it('requested > 1 is accounted (batch connect)', () => {
    const r = checkEntitlement(active('creator-pro'), 'instagramAccounts', { instagramAccounts: 2 }, { requested: 2, flags: ENFORCED });
    expect(r.allowed).toBe(false); // 2 used + 2 requested > 3 limit
  });
});

describe('entitlements: DMs are unlimited (owner decision, 2026-11-09)', () => {
  it('no DM volume blocks a workspace — Free default, ENFORCED mode', () => {
    const r = checkEntitlement(null, 'dmsPerMonth', { dmsThisMonth: 999_999_999 }, { flags: ENFORCED });
    expect(r.limit).toBeNull();
    expect(r.allowed).toBe(true);
    expect(r.effectiveAllowed).toBe(true);
    expect(r.reason).toBe('within-limit');
  });
  it('no DM volume blocks a workspace — paid plan, ENFORCED mode', () => {
    const r = checkEntitlement(active('starter'), 'dmsPerMonth', { dmsThisMonth: 999_999_999 }, { flags: ENFORCED });
    expect(r.limit).toBeNull();
    expect(r.allowed).toBe(true);
    expect(r.effectiveAllowed).toBe(true);
  });
  it('evaluateAll reports the DM check as unlimited + allowed at extreme usage', () => {
    const { checks } = evaluateAllEntitlements(null, { dmsThisMonth: 999_999_999 }, { flags: ENFORCED });
    const dm = checks.find((c) => c.dimension === 'dmsPerMonth');
    expect(dm?.limit).toBeNull();
    expect(dm?.allowed).toBe(true);
    expect(dm?.effectiveAllowed).toBe(true);
  });
});

describe('entitlements: log-only mode', () => {
  // These two pins exercise the block path, so they use a dimension
  // that is still capped (contactsPerMonth: Free 250). They used
  // dmsPerMonth until the owner's 2026-11-09 decision made DMs
  // unlimited — a DM check can no longer compute "blocked".
  it('ENTITLEMENTS_ENFORCED=false still COMPUTES the decision but passes through', () => {
    const r = checkEntitlement(null, 'contactsPerMonth', { contactsThisMonth: 999999 }, { flags: LOG_ONLY });
    expect(r.allowed).toBe(false); // computed honestly
    expect(r.enforced).toBe(false);
    expect(r.effectiveAllowed).toBe(true); // pass-through
    expect(r.limit).toBe(getPlan('free').limits.contactsPerMonth);
  });
  it('flipping the flag changes effectiveAllowed without changing the computed decision', () => {
    const usage = { contactsThisMonth: 999999 };
    const off = checkEntitlement(null, 'contactsPerMonth', usage, { flags: LOG_ONLY });
    const on = checkEntitlement(null, 'contactsPerMonth', usage, { flags: ENFORCED });
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
    // Owner decision, 2026-11-09: the catalogue value is null
    // (unlimited) until this test temporarily sets a numeric cap —
    // proving the service reads the catalogue live, either way.
    const plan = getPlan('free') as { limits: { dmsPerMonth: number | null } };
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

// ── Period lapse (Bug 1 fix, owner-approved 2026-11-09) ───────────
// Payments are one-time orders with NO autopay: once the recorded
// current_period_end passes, the paid plan stops granting until a
// renewal payment writes a later end. Before this fix, resolution
// granted on status='active' alone (public-readiness-audit.md Bug 1:
// "paid plans never expire").
describe('entitlements: period lapse (Bug 1, 2026-11-09)', () => {
  const NOW = new Date('2026-11-09T10:00:00Z');
  const PAST = '2026-11-08T10:00:00Z';
  const FUTURE = '2026-12-09T10:00:00Z';

  it('active + period end in the past ⇒ Free with resolution free-default-period-ended', () => {
    const r = resolveEntitlement(
      { workspaceId: 'ws-1', planId: 'creator-pro', status: 'active', currentPeriodEnd: PAST },
      NOW,
    );
    expect(r.plan.id).toBe('free');
    expect(r.resolution).toBe('free-default-period-ended');
    expect(r.entitled).toBe(true);
  });

  it('active + period end in the future ⇒ paid plan still grants', () => {
    const r = resolveEntitlement(
      { workspaceId: 'ws-1', planId: 'creator-pro', status: 'active', currentPeriodEnd: FUTURE },
      NOW,
    );
    expect(r.plan.id).toBe('creator-pro');
    expect(r.resolution).toBe('active-subscription');
  });

  it('active + no recorded period end ⇒ paid plan still grants (no lapse evidence — pre-fix behaviour)', () => {
    const withNull = resolveEntitlement(
      { workspaceId: 'ws-1', planId: 'creator-pro', status: 'active', currentPeriodEnd: null },
      NOW,
    );
    expect(withNull.plan.id).toBe('creator-pro');
    const omitted = resolveEntitlement({ workspaceId: 'ws-1', planId: 'creator-pro', status: 'active' }, NOW);
    expect(omitted.plan.id).toBe('creator-pro');
  });

  it('active + unparseable period end ⇒ paid plan still grants (never strip on bad evidence)', () => {
    const r = resolveEntitlement(
      { workspaceId: 'ws-1', planId: 'creator-pro', status: 'active', currentPeriodEnd: 'not-a-date' },
      NOW,
    );
    expect(r.plan.id).toBe('creator-pro');
  });

  it('trialing + current period end in the past ⇒ Free (period ended)', () => {
    const r = resolveEntitlement(
      { workspaceId: 'ws-1', planId: 'starter', status: 'trialing', currentPeriodEnd: PAST },
      NOW,
    );
    expect(r.plan.id).toBe('free');
    expect(r.resolution).toBe('free-default-period-ended');
  });

  it('checkEntitlement honours the lapse: usage over the FREE limit blocks once the paid period has ended', () => {
    const lapsed = { workspaceId: 'ws-1', planId: 'creator-pro', status: 'active' as const, currentPeriodEnd: PAST };
    const live = { ...lapsed, currentPeriodEnd: FUTURE };
    // creator-pro allows 3 Instagram accounts; Free allows 1. At 2 used:
    expect(
      checkEntitlement(live, 'instagramAccounts', { instagramAccounts: 2 }, { flags: ENFORCED, now: NOW }).allowed,
    ).toBe(true);
    const blocked = checkEntitlement(lapsed, 'instagramAccounts', { instagramAccounts: 2 }, { flags: ENFORCED, now: NOW });
    expect(blocked.planId).toBe('free');
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(getPlan('free').limits.instagramAccounts);
  });
});
