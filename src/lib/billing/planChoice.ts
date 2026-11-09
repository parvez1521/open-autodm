/**
 * Plan-choice routing state (owner directive, 2026-11-10).
 *
 * New customers must land on a plan choice, not on the old
 * "set up your own Meta app" journey: after signup + email
 * confirmation, a user whose billing workspace has NO plan state
 * yet — no real subscription, no trial (active or past) — and who
 * has not made/dismissed the choice is routed to
 * /pricing?welcome=1 (the plan picker). Picking a paid plan
 * creates plan state through the trial/checkout flow; picking
 * Free — or dismissing the picker — records the marker below,
 * and the routing never fires again for that user.
 *
 * Routing placement (Task F correction, 2026-11-10): the route
 * fires at the POST-AUTH surfaces only (lib/billing/
 * planChoiceServer, consulted by /auth/callback and by the
 * login/signup forms) — NOT on dashboard entry, where it also
 * bounced the signed-in owner off the homepage. The pure
 * decision below is unchanged.
 *
 * The marker lives in the auth user's app_metadata (server-only
 * writes via the service role; users cannot forge it through
 * user_metadata) under PLAN_CHOICE_MADE_AT_KEY. It is per-USER,
 * matching the "routed once" semantics: the choice is a one-time
 * onboarding gate, not a per-workspace setting.
 */

/** app_metadata key holding the ISO timestamp of the plan choice. */
export const PLAN_CHOICE_MADE_AT_KEY = 'plan_choice_made_at';

/** The subscription facts the plan-choice decision reads. */
export interface PlanChoiceSubscriptionView {
  planId: string;
  status: string;
  trialEndsAt: string | null;
}

/** The marker timestamp from an auth user's app_metadata, or null. */
export function planChoiceMadeAt(appMetadata: unknown): string | null {
  if (!appMetadata || typeof appMetadata !== 'object') return null;
  const value = (appMetadata as Record<string, unknown>)[PLAN_CHOICE_MADE_AT_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * True when a subscription view carries real plan state: a
 * non-default plan/status, or any trial (a set trialEndsAt means
 * a trial was started, live or lapsed). The bare default row the
 * billing schema seeds — plan 'free', status 'free', no trial —
 * is NOT plan state: the customer has not chosen anything yet.
 */
export function hasPlanState(sub: PlanChoiceSubscriptionView | null): boolean {
  if (!sub) return false;
  if (sub.trialEndsAt) return true;
  return !(sub.planId === 'free' && sub.status === 'free');
}

/**
 * The routing decision: route to the plan picker only when the
 * marker is unset AND no plan state exists.
 */
export function needsPlanChoice(
  sub: PlanChoiceSubscriptionView | null,
  markerMade: boolean,
): boolean {
  if (markerMade) return false;
  return !hasPlanState(sub);
}
