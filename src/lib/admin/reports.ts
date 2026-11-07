/**
 * Phase 14 — billing reports as pure computations over the billing
 * tables (the SQL-view equivalents live in migration …000029).
 *
 * Money rules (Phase 11/12, unchanged): integer minor units only, and
 * currencies are NEVER summed together — every money report is keyed
 * by currency and there is deliberately no cross-currency total field.
 */
import type { CurrencyCode } from '../billing/catalogue';
import type { InternalSubscriptionRecord } from './types';

export type MrrByCurrency = Partial<Record<CurrencyCode, number>>;

/**
 * MRR: subscriptions in `active` or `past_due` (contracted revenue;
 * trialing has not converted, paused/cancelled/expired/incomplete are
 * not revenue). Monthly plans contribute amountMinor; annual plans
 * contribute floor(amountMinor / 12) — the remainder stays in the
 * annual period and is documented, never rounded up.
 */
export function computeMrr(subs: readonly InternalSubscriptionRecord[]): MrrByCurrency {
  const out: MrrByCurrency = {};
  for (const s of subs) {
    if (s.status !== 'active' && s.status !== 'past_due') continue;
    const monthly = s.billingPeriod === 'monthly' ? s.amountMinor : Math.floor(s.amountMinor / 12);
    out[s.currency] = (out[s.currency] ?? 0) + monthly;
  }
  return out;
}

export interface ChurnReport {
  periodStart: string;
  periodEnd: string;
  /** Subscriptions active at period start (created before, not cancelled before). */
  base: number;
  cancelledInPeriod: number;
  /** Integer basis points (1% = 100 bps); 0 when base is 0. */
  churnBps: number;
}

export function computeChurn(
  subs: readonly InternalSubscriptionRecord[],
  period: { start: string; end: string },
): ChurnReport {
  let base = 0;
  let cancelledInPeriod = 0;
  for (const s of subs) {
    const wasActiveAtStart = s.createdAt < period.start && (s.cancelledAt === null || s.cancelledAt >= period.start);
    if (wasActiveAtStart) base += 1;
    if (s.cancelledAt !== null && s.cancelledAt >= period.start && s.cancelledAt < period.end) cancelledInPeriod += 1;
  }
  return {
    periodStart: period.start,
    periodEnd: period.end,
    base,
    cancelledInPeriod,
    churnBps: base === 0 ? 0 : Math.round((cancelledInPeriod * 10000) / base),
  };
}

export type AgingBucketId = '0-7' | '8-30' | '31-60' | '61+';
export interface AgingBucket {
  count: number;
  amountMinor: number;
}
export type PastDueAging = Partial<Record<CurrencyCode, Record<AgingBucketId, AgingBucket>>>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function computePastDueAging(subs: readonly InternalSubscriptionRecord[], asOf: string): PastDueAging {
  const asOfMs = Date.parse(asOf);
  const out: PastDueAging = {};
  for (const s of subs) {
    if (s.status !== 'past_due' || s.pastDueSince === null) continue;
    const days = Math.floor((asOfMs - Date.parse(s.pastDueSince)) / DAY_MS);
    const bucket: AgingBucketId = days <= 7 ? '0-7' : days <= 30 ? '8-30' : days <= 60 ? '31-60' : '61+';
    const perCurrency = (out[s.currency] ??= {
      '0-7': { count: 0, amountMinor: 0 },
      '8-30': { count: 0, amountMinor: 0 },
      '31-60': { count: 0, amountMinor: 0 },
      '61+': { count: 0, amountMinor: 0 },
    });
    perCurrency[bucket].count += 1;
    perCurrency[bucket].amountMinor += s.amountMinor;
  }
  return out;
}

export interface TrialConversionReport {
  trialsStarted: number;
  converted: number;
  /** Integer basis points; 0 when no trials started. */
  conversionBps: number;
}

/** Converted = had a trial and is now `active` (first paid period reached). */
export function computeTrialConversion(subs: readonly InternalSubscriptionRecord[]): TrialConversionReport {
  const trialed = subs.filter((s) => s.hadTrial);
  const converted = trialed.filter((s) => s.status === 'active').length;
  return {
    trialsStarted: trialed.length,
    converted,
    conversionBps: trialed.length === 0 ? 0 : Math.round((converted * 10000) / trialed.length),
  };
}

export interface BillingReports {
  mrrByCurrency: MrrByCurrency;
  churn: ChurnReport;
  pastDueAging: PastDueAging;
  trialConversion: TrialConversionReport;
}

export function computeBillingReports(
  subs: readonly InternalSubscriptionRecord[],
  opts: { asOf: string; churnPeriod: { start: string; end: string } },
): BillingReports {
  return {
    mrrByCurrency: computeMrr(subs),
    churn: computeChurn(subs, opts.churnPeriod),
    pastDueAging: computePastDueAging(subs, opts.asOf),
    trialConversion: computeTrialConversion(subs),
  };
}
