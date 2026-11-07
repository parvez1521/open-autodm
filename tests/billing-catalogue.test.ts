/**
 * Phase 11 — draft billing catalogue invariants.
 *
 * The catalogue is DRAFT-UNAPPROVED data. These tests pin the structural
 * rules that must hold for ANY future approved version too:
 *  - every price is an integer in minor units (paise / cents), never a float
 *  - both currencies (INR + USD) are present for every paid plan
 *  - the free plan costs exactly 0 in both currencies, on both periods
 *  - every limit is a non-negative number
 *  - the draft status flag is present on the catalogue, every plan and
 *    every trial option, and no trial option is selected
 *  - annual totals are internally consistent (annualMonthly × 12)
 *  - no trial option ever permits a silent auto-charge
 */

import { describe, it, expect } from 'vitest';
import {
  CATALOGUE_STATUS,
  PLANS,
  TRIAL_OPTIONS,
  SELECTED_TRIAL_OPTION_ID,
  getPlan,
  isPaidPlan,
  type CurrencyCode,
} from '@/lib/billing/catalogue';

const CURRENCIES: CurrencyCode[] = ['INR', 'USD'];

describe('billing catalogue (draft)', () => {
  it('carries the draft-unapproved status flag', () => {
    expect(CATALOGUE_STATUS).toBe('draft-unapproved');
    for (const plan of PLANS) {
      expect(plan.status).toBe('draft-unapproved');
    }
    for (const option of TRIAL_OPTIONS) {
      expect(option.status).toBe('draft-unapproved');
    }
  });

  it('has the four proposed tiers', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['free', 'starter', 'creator-pro', 'agency']);
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

  it('presents both currencies for every paid plan, with positive prices', () => {
    for (const plan of PLANS.filter(isPaidPlan)) {
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

  it('keeps annual totals consistent: annualMonthly × 12 = annualTotal', () => {
    for (const plan of PLANS) {
      for (const currency of CURRENCIES) {
        expect(plan.prices[currency].annualTotalMinor).toBe(
          plan.prices[currency].annualMonthlyMinor * 12,
        );
      }
    }
  });

  it('keeps every limit a non-negative finite number', () => {
    for (const plan of PLANS) {
      for (const [key, value] of Object.entries(plan.limits)) {
        expect(typeof value, `${plan.id}.limits.${key}`).toBe('number');
        expect(Number.isFinite(value), `${plan.id}.limits.${key}`).toBe(true);
        expect(value, `${plan.id}.limits.${key}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never allows a silent auto-charge in any trial option, and selects none', () => {
    expect(TRIAL_OPTIONS.length).toBeGreaterThan(0);
    for (const option of TRIAL_OPTIONS) {
      expect(option.silentAutoChargeAllowed).toBe(false);
      expect([7, 14, 30]).toContain(option.days);
    }
    expect(SELECTED_TRIAL_OPTION_ID).toBeNull();
  });
});
