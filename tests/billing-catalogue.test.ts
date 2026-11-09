/**
 * Billing catalogue invariants — OWNER-APPROVED catalogue (round 5,
 * 2026-11-08).
 *
 * The owner approved the prices, account counts, Enterprise shape
 * and trial policy on 2026-11-08 (superseding the Phase-11 draft).
 * These tests pin the structural rules plus the approved figures:
 *  - every price is an integer in minor units (paise / cents)
 *  - both currencies (INR + USD) are present for every self-serve
 *    paid plan, with positive prices
 *  - Free costs exactly 0; Enterprise is custom-priced — it carries
 *    NO price figure (zeros) and can never be self-serve purchased
 *  - approved tiers: ₹299/1 account, ₹500/3, ₹799/5, Enterprise custom
 *  - Creator Studio is included on every plan — full on paid
 *    plans, LIMITED on Free (owner instruction, 2026-11-08
 *    ~19:38 IST); auto DMs are unlimited on every plan (owner
 *    decision, 2026-11-09 — supersedes that day's Free 1,000/mo cap)
 *  - the 15-day no-card trial is the selected option; no trial
 *    option ever permits a silent auto-charge
 *  - annual totals are internally consistent (annualMonthly × 12)
 */

import { describe, it, expect } from 'vitest';
import {
  CATALOGUE_STATUS,
  PLANS,
  TRIAL_OPTIONS,
  SELECTED_TRIAL_OPTION_ID,
  TRIAL_DAYS,
  getPlan,
  isPaidPlan,
  isSelfServePaidPlan,
  type CurrencyCode,
} from '@/lib/billing/catalogue';

const CURRENCIES: CurrencyCode[] = ['INR', 'USD'];

describe('billing catalogue (owner-approved 2026-11-08)', () => {
  it('carries the approved status flag on the catalogue, plans and trial options', () => {
    expect(CATALOGUE_STATUS).toBe('approved');
    for (const plan of PLANS) {
      expect(plan.status).toBe('approved');
    }
    for (const option of TRIAL_OPTIONS) {
      expect(option.status).toBe('approved');
    }
  });

  it('has the five approved tiers with their approved names', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['free', 'starter', 'creator-pro', 'agency', 'enterprise']);
    expect(PLANS.map((p) => p.name)).toEqual(['Free', 'Starter', 'Growth', 'Pro', 'Enterprise']);
  });

  it('stores every price as integer minor units', () => {
    for (const plan of PLANS) {
      for (const currency of CURRENCIES) {
        const price = plan.prices[currency];
        expect(price, `${plan.id}/${currency} missing`).toBeDefined();
        for (const value of [price.monthlyMinor, price.annualMonthlyMinor, price.annualTotalMinor]) {
          expect(Number.isInteger(value), `${plan.id}/${currency}: ${value} is not an integer`).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('presents both currencies for every self-serve paid plan, with positive prices', () => {
    for (const plan of PLANS.filter(isSelfServePaidPlan)) {
      for (const currency of CURRENCIES) {
        expect(plan.prices[currency].monthlyMinor).toBeGreaterThan(0);
        expect(plan.prices[currency].annualMonthlyMinor).toBeGreaterThan(0);
        expect(plan.prices[currency].annualTotalMinor).toBeGreaterThan(0);
      }
    }
  });

  it('prices the free plan at exactly 0 in both currencies', () => {
    const free = getPlan('free');
    for (const currency of CURRENCIES) {
      expect(free.prices[currency].monthlyMinor).toBe(0);
      expect(free.prices[currency].annualMonthlyMinor).toBe(0);
      expect(free.prices[currency].annualTotalMinor).toBe(0);
    }
  });

  it('carries the owner-approved prices and account counts (2026-11-08)', () => {
    const starter = getPlan('starter');
    expect(starter.prices.INR.monthlyMinor).toBe(29900); // ₹299
    expect(starter.prices.USD.monthlyMinor).toBe(500); // $5
    expect(starter.limits.instagramAccounts).toBe(1);

    const growth = getPlan('creator-pro');
    expect(growth.prices.INR.monthlyMinor).toBe(50000); // ₹500
    expect(growth.prices.USD.monthlyMinor).toBe(900); // $9
    expect(growth.limits.instagramAccounts).toBe(3);

    const pro = getPlan('agency');
    expect(pro.prices.INR.monthlyMinor).toBe(79900); // ₹799
    expect(pro.prices.USD.monthlyMinor).toBe(1500); // $15
    expect(pro.limits.instagramAccounts).toBe(5);
  });

  it('keeps Enterprise custom-priced: no figure anywhere, never self-serve', () => {
    const enterprise = getPlan('enterprise');
    expect(enterprise.customPricing).toBe(true);
    expect(isPaidPlan(enterprise)).toBe(true);
    expect(isSelfServePaidPlan(enterprise)).toBe(false);
    for (const currency of CURRENCIES) {
      expect(enterprise.prices[currency].monthlyMinor).toBe(0);
      expect(enterprise.prices[currency].annualMonthlyMinor).toBe(0);
      expect(enterprise.prices[currency].annualTotalMinor).toBe(0);
    }
    expect(enterprise.capabilityNotes.join(' ')).toContain('For Business / Agency');
  });

  it('includes Creator Studio on every plan, Free included', () => {
    for (const plan of PLANS) {
      expect(
        plan.capabilityNotes.some((n) => n.includes('Creator Studio included')),
        `${plan.id} must include Creator Studio`,
      ).toBe(true);
    }
  });

  // Owner decision, 2026-11-09 (supersedes the 2026-11-08 ~19:38
  // IST rule that gave Free 1,000 auto DMs a month): auto DMs are
  // UNLIMITED on every plan — dmsPerMonth is null across the whole
  // catalogue. Free still carries the LIMITED Creator Studio; paid
  // plans keep the full Studio (their notes never say "limited").
  it('gives every plan unlimited auto DMs and Free the limited Studio (owner, 2026-11-09)', () => {
    const free = getPlan('free');
    for (const plan of PLANS) {
      expect(plan.limits.dmsPerMonth, `${plan.id} DMs must be unlimited`).toBeNull();
    }
    expect(
      free.capabilityNotes.some((n) => n.includes('Creator Studio included (limited)')),
    ).toBe(true);
    for (const plan of PLANS.filter((p) => p.id !== 'free')) {
      expect(
        plan.capabilityNotes.some((n) => n.toLowerCase().includes('limited')),
        `${plan.id} must keep the full Studio`,
      ).toBe(false);
    }
  });

  it('keeps annual totals consistent: annualMonthly × 12 = annualTotal', () => {
    for (const plan of PLANS) {
      for (const currency of CURRENCIES) {
        expect(plan.prices[currency].annualTotalMinor).toBe(
          plan.prices[currency].annualMonthlyMinor * 12,
        );
      }
    }
  });

  // Owner decision, 2026-11-10 (supersedes the 3 / 10 / 50 / 200 /
  // 500 per-plan automation caps): active automations are UNLIMITED
  // on every plan — activeAutomations is null across the catalogue,
  // exactly like dmsPerMonth (owner, 2026-11-09).
  it('gives every plan unlimited active automations (owner, 2026-11-10)', () => {
    for (const plan of PLANS) {
      expect(plan.limits.activeAutomations, `${plan.id} automations must be unlimited`).toBeNull();
    }
  });

  it('keeps every capped limit a non-negative finite number (DMs + automations excepted: null = unlimited, owner 2026-11-09 / 2026-11-10)', () => {
    for (const plan of PLANS) {
      for (const [key, value] of Object.entries(plan.limits)) {
        if (key === 'dmsPerMonth' || key === 'activeAutomations') {
          // Owner decisions, 2026-11-09 (DMs) and 2026-11-10
          // (automations): both dimensions are unlimited on every
          // plan, encoded as null — the catalogue's two non-numeric
          // limits.
          expect(value, `${plan.id}.limits.${key}`).toBeNull();
          continue;
        }
        expect(typeof value, `${plan.id}.limits.${key}`).toBe('number');
        expect(Number.isFinite(value), `${plan.id}.limits.${key}`).toBe(true);
        expect(value, `${plan.id}.limits.${key}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('selects the owner-decided 15-day no-card trial, and never allows a silent auto-charge', () => {
    expect(TRIAL_OPTIONS.length).toBeGreaterThan(0);
    for (const option of TRIAL_OPTIONS) {
      expect(option.silentAutoChargeAllowed).toBe(false);
      expect([7, 14, 15, 30]).toContain(option.days);
    }
    // Owner decision 2026-11-08 (was: no trial selected under the
    // draft catalogue): 15 days, no card upfront, auto-downgrade to
    // Free at expiry.
    expect(SELECTED_TRIAL_OPTION_ID).toBe('15d-no-card-then-checkout-auto-downgrade-to-free');
    expect(TRIAL_DAYS).toBe(15);
  });
});
