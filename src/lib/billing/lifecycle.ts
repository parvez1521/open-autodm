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
