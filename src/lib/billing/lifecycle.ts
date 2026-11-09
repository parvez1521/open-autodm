/**
 * Phase 12 — subscription lifecycle state machine.
 * Provider statuses NEVER map blindly 1:1 onto these states; each adapter
 * carries an explicit mapping table (see providers/*.ts).
 */
export type SubscriptionStatus = 'trialing' | 'incomplete' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'expired';
export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['trialing','incomplete','active','past_due','paused','cancelled','expired'] as const;

/** Explicit allowed-transitions table. Same-state is a no-op, not a transition. */
export const ALLOWED_TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  incomplete: ['trialing', 'active', 'cancelled', 'expired'],
  trialing: ['active', 'past_due', 'cancelled', 'expired'],
  active: ['past_due', 'paused', 'cancelled', 'expired'],
  past_due: ['active', 'cancelled', 'expired'],
  paused: ['active', 'cancelled', 'expired'],
  cancelled: [],
  expired: [],
} as const;

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  if (from === to) return true; // idempotent no-op
  return ALLOWED_TRANSITIONS[from].includes(to);
}
export function isTerminal(status: SubscriptionStatus): boolean { return status === 'cancelled' || status === 'expired'; }
/** Entitlement: only active/trialing grant paid access. past_due does NOT silently grant in this design (grace policy is an owner decision, Phase 11 unresolved). */
export function grantsEntitlement(status: SubscriptionStatus): boolean { return status === 'active' || status === 'trialing'; }

/** The subscription fields the period-lapse evaluation reads. */
export interface PeriodLapseView {
  status: SubscriptionStatus | 'free' | null;
  currentPeriodEnd: string | null;
}

/**
 * Period lapse (Bug 1 fix, owner-approved 2026-11-09): payments here
 * are one-time orders with NO autopay, so when an `active` (or
 * `trialing`) subscription's recorded `current_period_end` has passed
 * and no renewal payment has written a later one, the paid period is
 * simply over. Nothing in the stored row changes — lapse is computed
 * at READ/RESOLUTION time from the row's own period end, mirroring
 * the trial lapse in billing/trial.ts. A renewal checkout + webhook
 * activation writes a fresh future period end (billing/persistence),
 * after which the same row no longer lapses and the paid plan
 * resolves again — no resurrection write is needed here.
 */
export function isPeriodLapsed(sub: PeriodLapseView | null | undefined, now: Date): boolean {
  if (!sub || (sub.status !== 'active' && sub.status !== 'trialing') || !sub.currentPeriodEnd) return false;
  const end = Date.parse(sub.currentPeriodEnd);
  return Number.isFinite(end) && end <= now.getTime();
}

/**
 * The EFFECTIVE subscription view for entitlement resolution: a
 * period-lapsed subscription reads as `expired`, which the
 * entitlement service resolves to the Free plan. Pure — persisting
 * any transition is the caller's choice (billing reads deliberately
 * do NOT persist period lapse; the stored row stays as the payment
 * record left it).
 */
export function applyPeriodLapse<T extends PeriodLapseView>(sub: T | null, now: Date): T | null {
  if (!sub || !isPeriodLapsed(sub, now)) return sub;
  return { ...sub, status: 'expired' as SubscriptionStatus };
}
