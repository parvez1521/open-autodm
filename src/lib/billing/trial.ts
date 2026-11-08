/**
 * Trial flow — SaaS subscription wiring (2026-11-08).
 *
 * Owner policy (catalogue.ts, decided 2026-11-08): every self-serve
 * paid plan starts with a 15-day free trial, NO card upfront; at expiry
 * the workspace drops back to Free limitations unless its owner checks
 * out. Nobody is ever silently charged.
 *
 * This module is the pure domain logic for that flow:
 *  - the trial window (start = now, end = now + TRIAL_DAYS),
 *  - whether a workspace may start a trial (one trial per workspace —
 *    a workspace whose trial already ran does not get a second one;
 *    that is the conservative reading of the owner's "a 15-day free
 *    trial" offer and is flagged in the wiring status doc),
 *  - days remaining for the billing UI,
 *  - lapse evaluation: a `trialing` subscription whose trial_ends_at
 *    has passed is EFFECTIVELY expired. The entitlement service
 *    already resolves `expired` → Free, so lapse needs no new
 *    entitlement code — readers apply applyTrialLapse() to the stored
 *    row before resolving, and the status route also persists the
 *    `expired` transition lazily on read (no cron required).
 *
 * Nothing here touches ENTITLEMENTS_ENFORCED: enforcement stays
 * flag-gated OFF by default in the entitlement service, exactly as
 * before. This module only computes subscription STATE.
 */

import { TRIAL_DAYS, isSelfServePaidPlan, getPlan, type PlanId } from './catalogue';
import type { SubscriptionStatus } from './lifecycle';

/** The subscription fields the trial logic reads (subset of the subscriptions row). */
export interface TrialSubscriptionView {
  planId: string | null;
  status: SubscriptionStatus | 'free' | null;
  trialEndsAt: string | null;
}

export interface TrialWindow {
  startsAt: Date;
  endsAt: Date;
}

/** Trial window for a trial starting at `now` (TRIAL_DAYS from the catalogue policy). */
export function trialWindow(now: Date): TrialWindow {
  const endsAt = new Date(now.getTime());
  endsAt.setUTCDate(endsAt.getUTCDate() + TRIAL_DAYS);
  return { startsAt: new Date(now.getTime()), endsAt };
}

/** Whole days remaining on a trial (ceil — a partial last day counts as 1); 0 once ended. */
export function trialDaysRemaining(trialEndsAt: string | null, now: Date): number {
  if (!trialEndsAt) return 0;
  const ms = Date.parse(trialEndsAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

export type TrialStartDecision =
  | { ok: true }
  | { ok: false; code: 'TRIAL_NOT_AVAILABLE' | 'ALREADY_TRIALING' | 'ALREADY_SUBSCRIBED' | 'TRIAL_ALREADY_USED'; message: string };

/**
 * May this workspace start a trial of `planId`?
 *  - the plan must be a self-serve paid plan (Free needs no trial;
 *    Enterprise is sales-led),
 *  - an active paid subscription blocks a trial (it is already paid),
 *  - a running trial blocks a second concurrent trial,
 *  - a workspace whose subscription row carries a trial end in the
 *    past has USED its trial (the marker is the recorded
 *    trial_ends_at; payment conversion deliberately keeps it as
 *    history so this check survives the paid period).
 * A lapsed trial is evaluated on the STORED row as-is: a `trialing`
 * row past its end still carries the marker, so it lands on
 * TRIAL_ALREADY_USED via the marker check below.
 */
export function evaluateTrialStart(existing: TrialSubscriptionView | null, planId: PlanId): TrialStartDecision {
  const plan = getPlan(planId);
  if (!isSelfServePaidPlan(plan)) {
    return { ok: false, code: 'TRIAL_NOT_AVAILABLE', message: 'This plan does not offer a self-serve free trial.' };
  }
  if (!existing || existing.status === null || existing.status === 'free') {
    return { ok: true };
  }
  if (existing.status === 'active') {
    return { ok: false, code: 'ALREADY_SUBSCRIBED', message: 'This workspace already has an active paid subscription.' };
  }
  if (existing.status === 'trialing') {
    return { ok: false, code: 'ALREADY_TRIALING', message: 'This workspace already has a trial running.' };
  }
  if (existing.trialEndsAt) {
    return { ok: false, code: 'TRIAL_ALREADY_USED', message: 'This workspace has already used its free trial.' };
  }
  // cancelled / expired / past_due / paused / incomplete without a
  // recorded trial: a trial may start.
  return { ok: true };
}

/** True when a trialing subscription's window has closed without payment. */
export function isTrialLapsed(sub: TrialSubscriptionView | null, now: Date): boolean {
  if (!sub || sub.status !== 'trialing' || !sub.trialEndsAt) return false;
  const end = Date.parse(sub.trialEndsAt);
  return Number.isFinite(end) && end <= now.getTime();
}

/**
 * The EFFECTIVE subscription view for entitlement resolution: a lapsed
 * trial reads as `expired`, which the entitlement service resolves to
 * the Free plan with its limitations. Pure — persistence of the lapse
 * is the caller's job (the status route writes it lazily).
 */
export function applyTrialLapse<T extends TrialSubscriptionView>(sub: T | null, now: Date): T | null {
  if (!sub || !isTrialLapsed(sub, now)) return sub;
  return { ...sub, status: 'expired' as SubscriptionStatus };
}
