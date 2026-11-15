/**
 * Forever-free owner comp — owner decision 2026-11-15 ("mere account
 * me koi bhi paid na lena pade, sab free access rahe"): the owner's
 * own account (parvezsiddiqui018@gmail.com) bypasses EVERY plan limit
 * and never needs a paid plan.
 *
 * Pins:
 *  - isOwnerFree: the owner email (case-insensitive) is comped, and
 *    so is the env-configured instance owner; nobody else is.
 *  - checkEntitlement with ownerFree: every dimension unlimited
 *    (limit null, always allowed) even at/over the Free caps.
 *  - resolveEntitlement with ownerFree: resolution 'owner-free'.
 *  - evaluateEntitlementGate with ownerFree: passes without ever
 *    resolving context (no subscription read, no usage count).
 *  - Non-owner contrast: a Free user at 1 Instagram account is
 *    still blocked from adding a 2nd — the comp changes nothing
 *    for anyone else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFakeSupabase } from './helpers/fake-supabase';
import { isOwnerFree, OWNER_FREE_EMAILS } from '@/lib/owner';
import {
  resolveEntitlement,
  checkEntitlement,
  evaluateAllEntitlements,
  type WorkspaceSubscription,
} from '@/lib/entitlements/service';
import { evaluateEntitlementGate, planLimitResponse } from '@/lib/entitlements/guard';
import type { SaasFlags } from '@/lib/billing/flags';

const OWNER_EMAIL = 'parvezsiddiqui018@gmail.com';
const OTHER_EMAIL = 'someone-else@example.com';
const ENFORCED: SaasFlags = { publicSignupEnabled: false, entitlementsEnforced: true };
const WS = '50000000-0000-4000-8000-000000000001';
const ON = { ENTITLEMENTS_ENFORCED: 'true' };

// Free workspace: no subscription row at all (the Free default).
const freeSub: WorkspaceSubscription | null = null;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.OWNER_USER_ID = process.env['OWNER_USER_ID'];
  savedEnv.OWNER_EMAIL = process.env['OWNER_EMAIL'];
  delete process.env['OWNER_USER_ID'];
  delete process.env['OWNER_EMAIL'];
});

afterEach(() => {
  if (savedEnv.OWNER_USER_ID === undefined) delete process.env['OWNER_USER_ID'];
  else process.env['OWNER_USER_ID'] = savedEnv.OWNER_USER_ID;
  if (savedEnv.OWNER_EMAIL === undefined) delete process.env['OWNER_EMAIL'];
  else process.env['OWNER_EMAIL'] = savedEnv.OWNER_EMAIL;
});

describe('isOwnerFree — the comp keys on the owner identity only', () => {
  it('comps the owner email', () => {
    expect(OWNER_FREE_EMAILS).toContain(OWNER_EMAIL);
    expect(isOwnerFree({ id: 'user-owner', email: OWNER_EMAIL })).toBe(true);
  });

  it('matches the owner email case-insensitively (and trims whitespace)', () => {
    expect(isOwnerFree({ id: 'user-owner', email: '  ParvezSiddiqui018@Gmail.Com  ' })).toBe(true);
  });

  it('does not comp any other email', () => {
    expect(isOwnerFree({ id: 'user-other', email: OTHER_EMAIL })).toBe(false);
    expect(isOwnerFree({ id: 'user-other', email: undefined })).toBe(false);
  });

  it('also comps the env-configured instance owner (OWNER_USER_ID wins)', () => {
    process.env['OWNER_USER_ID'] = 'user-env-owner';
    expect(isOwnerFree({ id: 'user-env-owner', email: OTHER_EMAIL })).toBe(true);
    expect(isOwnerFree({ id: 'user-not-owner', email: OTHER_EMAIL })).toBe(false);
  });

  it('also comps the env-configured instance owner by email (OWNER_EMAIL)', () => {
    process.env['OWNER_EMAIL'] = 'Boss@Example.com';
    expect(isOwnerFree({ id: 'user-x', email: 'boss@example.com' })).toBe(true);
    expect(isOwnerFree({ id: 'user-x', email: OTHER_EMAIL })).toBe(false);
  });
});

describe('checkEntitlement — ownerFree makes every dimension unlimited', () => {
  it('owner on Free at the 1-account cap can still add a 2nd and a 3rd account', () => {
    for (const used of [1, 2, 5]) {
      const check = checkEntitlement(freeSub, 'instagramAccounts', { instagramAccounts: used }, { flags: ENFORCED, ownerFree: true });
      expect(check.allowed, `used=${used}`).toBe(true);
      expect(check.effectiveAllowed, `used=${used}`).toBe(true);
      expect(check.limit, `used=${used}`).toBeNull();
    }
  });

  it('owner on Free is unlimited on every other capped dimension too', () => {
    const cases = [
      ['teamSeats', { teamSeatsUsed: 1 }],
      ['workspaces', { workspacesOwned: 1 }],
      ['aiDrafting', { aiDraftingThisMonth: 20 }],
      ['scriptWriter', { scriptWriterThisMonth: 10 }],
      ['followUpsPerMonth', { followUpsThisMonth: 100 }],
      ['contactsPerMonth', { contactsThisMonth: 250 }],
    ] as const;
    for (const [dimension, usage] of cases) {
      const check = checkEntitlement(freeSub, dimension, usage, { flags: ENFORCED, ownerFree: true });
      expect(check.allowed, dimension).toBe(true);
      expect(check.effectiveAllowed, dimension).toBe(true);
      expect(check.limit, dimension).toBeNull();
    }
  });

  it('non-owner on Free at the 1-account cap is still blocked from a 2nd account', () => {
    const check = checkEntitlement(freeSub, 'instagramAccounts', { instagramAccounts: 1 }, { flags: ENFORCED });
    expect(check.allowed).toBe(false);
    expect(check.effectiveAllowed).toBe(false);
    expect(check.limit).toBe(1);
    expect(check.reason).toBe('at-limit');
  });

  it('evaluateAllEntitlements with ownerFree allows every check', () => {
    const { resolved, checks } = evaluateAllEntitlements(
      freeSub,
      { instagramAccounts: 3, teamSeatsUsed: 4, workspacesOwned: 2, aiDraftingThisMonth: 999 },
      { flags: ENFORCED, ownerFree: true },
    );
    expect(resolved.resolution).toBe('owner-free');
    for (const check of checks) {
      expect(check.allowed, check.dimension).toBe(true);
      expect(check.effectiveAllowed, check.dimension).toBe(true);
    }
  });
});

describe('resolveEntitlement — ownerFree resolves as owner-free, plan stays honestly Free', () => {
  it('reports resolution owner-free without inventing a paid plan', () => {
    const r = resolveEntitlement(freeSub, new Date(), { ownerFree: true });
    expect(r.plan.id).toBe('free');
    expect(r.resolution).toBe('owner-free');
    expect(r.entitled).toBe(true);
  });

  it('without ownerFree the same workspace resolves as an ordinary Free default', () => {
    const r = resolveEntitlement(freeSub);
    expect(r.plan.id).toBe('free');
    expect(r.resolution).toBe('free-default-no-subscription');
  });
});

describe('evaluateEntitlementGate — ownerFree passes with no database work', () => {
  it('passes a 2nd Instagram account without resolving context', async () => {
    const fake = createFakeSupabase();
    let resolved = false;
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: ON,
      ownerFree: true,
      resolveContext: async () => {
        resolved = true;
        throw new Error('resolveContext must not run for the owner');
      },
    });
    expect(gate.blocked).toBe(false);
    expect(gate.check).toBeNull();
    expect(gate.message).toBeNull();
    expect(resolved).toBe(false);
  });

  it('non-owner Free user at 1 account is still blocked (2nd account refused)', async () => {
    const fake = createFakeSupabase();
    const gate = await evaluateEntitlementGate(fake.client as unknown as SupabaseClient, {
      dimension: 'instagramAccounts',
      env: ON,
      resolveContext: async () => ({ workspaceId: WS, usage: { instagramAccounts: 1 } }),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.check?.limit).toBe(1);
    expect(gate.check?.planId).toBe('free');
    expect(gate.message).toContain('Free plan includes up to 1 Instagram account');
    const res = planLimitResponse(gate);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PLAN_LIMIT_REACHED');
  });
});
