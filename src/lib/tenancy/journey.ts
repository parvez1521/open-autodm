/**
 * Phase 13 — customer journey / onboarding state machine.
 *
 * The 18-step journey (see saas/phase13-customer-journey.md) modelled as
 * an ordered state list so it is unit-testable without a browser. Each
 * step records: whether it exists in today's invite-only release, and
 * which flag gates the SaaS version of it.
 *
 * This module is pure data + pure transitions. It creates no accounts,
 * calls nothing external, and does NOT weaken the invite-only posture:
 * `signupProtection.ts` remains the release's only access gate.
 */
import { readSaasFlags, readBillingFlags, type SaasFlags } from '../billing/flags';

export type JourneyStepId =
  | 'landing'
  | 'pricing'
  | 'signup'
  | 'email-verification'
  | 'workspace-creation'
  | 'plan-choice'
  | 'trial-or-purchase'
  | 'checkout'
  | 'instagram-connect'
  | 'meta-permissions-explained'
  | 'first-automation'
  | 'dashboard-onboarding'
  | 'billing-dashboard'
  | 'trial-ending-warning'
  | 'payment-failure-recovery'
  | 'cancellation'
  | 'plan-change'
  | 'account-deletion';

export type StepAvailability = 'exists-today' | 'new-saas' | 'partial-today';

export interface JourneyStep {
  id: JourneyStepId;
  /** 1-based position in the canonical journey. */
  order: number;
  title: string;
  availability: StepAvailability;
  /** Flag that gates the SaaS behaviour, or null when ungated. */
  gatedBy: 'PUBLIC_SIGNUP_ENABLED' | 'BILLING_ENABLED' | 'PAYMENTS_LIVE_MODE' | 'ENTITLEMENTS_ENFORCED' | null;
  notes: string;
}

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  { id: 'landing', order: 1, title: 'Landing page', availability: 'exists-today', gatedBy: null, notes: 'Today: the product landing at `/`, with plan CTAs.' },
  { id: 'pricing', order: 2, title: 'Pricing page', availability: 'new-saas', gatedBy: null, notes: 'Live at (saas)/pricing rendering catalogue.ts; prices owner-approved 2026-11-08. Read-only, safe ungated.' },
  { id: 'signup', order: 3, title: 'Signup', availability: 'new-saas', gatedBy: 'PUBLIC_SIGNUP_ENABLED', notes: 'Public signup; renders a disabled state while PUBLIC_SIGNUP_ENABLED is off.' },
  { id: 'email-verification', order: 4, title: 'Email verification', availability: 'new-saas', gatedBy: 'PUBLIC_SIGNUP_ENABLED', notes: 'Supabase Auth email confirmation; no account is usable before verification.' },
  { id: 'workspace-creation', order: 5, title: 'Workspace creation', availability: 'new-saas', gatedBy: 'PUBLIC_SIGNUP_ENABLED', notes: 'Automatic since the 2026-11-08 launch fix: the first workspace + owner membership are created on first console load (WorkspaceProvider → POST /api/workspaces → create_workspace RPC, migration …000031); before that, signup created no workspace at all.' },
  { id: 'plan-choice', order: 6, title: 'Plan choice', availability: 'new-saas', gatedBy: 'BILLING_ENABLED', notes: 'Free requires no billing; paid plans need BILLING_ENABLED. Since 2026-11-10 (owner directive): a user with no plan state (no subscription, no trial) and no recorded choice is routed to /pricing?welcome=1, the plan picker — originally from the dashboard, but corrected the same day (Task F) to the post-auth surfaces only (the /auth/callback redirect and the login/signup forms via GET /api/billing/plan-choice), because the dashboard redirect also bounced the signed-in owner off the homepage; choosing Free or dismissing stamps plan_choice_made_at in app_metadata (POST /api/billing/plan-choice) and the routing never repeats. There is no message-us / create-your-own-app step — the hosted service runs on the platform Meta app, whose Setup Wizard is admin-only.' },
  { id: 'trial-or-purchase', order: 7, title: 'Trial / purchase decision', availability: 'new-saas', gatedBy: 'BILLING_ENABLED', notes: 'Owner decision 2026-11-08: 15-day free trial on self-serve paid plans, no card upfront, auto-downgrade to Free at expiry; no silent auto-charge, ever.' },
  { id: 'checkout', order: 8, title: 'Checkout', availability: 'new-saas', gatedBy: 'PAYMENTS_LIVE_MODE', notes: 'Provider checkout via Phase 12 BillingProvider; mock-only until owner enables live mode with real credentials.' },
  { id: 'instagram-connect', order: 9, title: 'Connect Instagram', availability: 'partial-today', gatedBy: null, notes: 'Exists today per-user; SaaS retargets binding to the workspace (Phase 11 §B.6) and checks the instagramAccounts entitlement.' },
  { id: 'meta-permissions-explained', order: 10, title: 'Meta permission explanation', availability: 'new-saas', gatedBy: null, notes: 'Plain-language explanation of requested Meta scopes before OAuth; required for informed consent + App Review.' },
  { id: 'first-automation', order: 11, title: 'First automation', availability: 'exists-today', gatedBy: 'ENTITLEMENTS_ENFORCED', notes: 'Automation product exists today; automations are unlimited on every plan (owner decision, 2026-11-10), so the activeAutomations entitlement check never blocks.' },
  { id: 'dashboard-onboarding', order: 12, title: 'Dashboard onboarding checklist', availability: 'partial-today', gatedBy: null, notes: 'Today: 4-step getting-started checklist on the dashboard. The (saas)/onboarding page extends it with SaaS steps.' },
  { id: 'billing-dashboard', order: 13, title: 'Billing dashboard', availability: 'new-saas', gatedBy: 'BILLING_ENABLED', notes: 'Live at (saas)/billing reading the entitlement service; inert while BILLING_ENABLED off.' },
  { id: 'trial-ending-warning', order: 14, title: 'Trial-ending warnings', availability: 'new-saas', gatedBy: 'BILLING_ENABLED', notes: 'Warnings at T-3d / T-1d / expiry; expiry behaviour (downgrade vs auth-required) is an owner decision.' },
  { id: 'payment-failure-recovery', order: 15, title: 'Payment-failure recovery', availability: 'new-saas', gatedBy: 'BILLING_ENABLED', notes: 'past_due state (Phase 12 lifecycle) + update-payment-method flow; entitlement falls back to Free while past_due (no grace — owner decision pending).' },
  { id: 'cancellation', order: 16, title: 'Cancellation', availability: 'new-saas', gatedBy: 'BILLING_ENABLED', notes: 'cancel_at_period_end semantics; safety floor (opt-outs, deletion, webhook safety) keeps running after cancellation.' },
  { id: 'plan-change', order: 17, title: 'Upgrade / downgrade', availability: 'new-saas', gatedBy: 'BILLING_ENABLED', notes: 'Provider-dependent (Phase 12: Razorpay in-place for eligible cards; Cashfree cancel+recreate). Proration is provider-capability-gated.' },
  { id: 'account-deletion', order: 18, title: 'Account deletion', availability: 'partial-today', gatedBy: null, notes: 'Meta data-deletion callbacks exist today; SaaS adds workspace deletion (owner-only) + retention-window purge — retention window is an owner decision.' },
] as const;

/** Onboarding checklist subset — the steps a new workspace walks in order. */
export const ONBOARDING_STEP_IDS: readonly JourneyStepId[] = [
  'workspace-creation',
  'plan-choice',
  'instagram-connect',
  'meta-permissions-explained',
  'first-automation',
  'dashboard-onboarding',
] as const;

export interface OnboardingState {
  completed: readonly JourneyStepId[];
}

export function initialOnboardingState(): OnboardingState {
  return { completed: [] };
}

/** The next incomplete onboarding step, or null when onboarding is done. */
export function nextOnboardingStep(state: OnboardingState): JourneyStepId | null {
  for (const id of ONBOARDING_STEP_IDS) {
    if (!state.completed.includes(id)) return id;
  }
  return null;
}

/**
 * Advance the state machine. Steps must complete IN ORDER: completing a
 * later step while an earlier one is pending is rejected (returns the
 * unchanged state + `advanced: false`).
 */
export function completeOnboardingStep(
  state: OnboardingState,
  step: JourneyStepId,
): { state: OnboardingState; advanced: boolean } {
  if (!ONBOARDING_STEP_IDS.includes(step)) return { state, advanced: false };
  if (state.completed.includes(step)) return { state, advanced: false };
  if (nextOnboardingStep(state) !== step) return { state, advanced: false };
  return { state: { completed: [...state.completed, step] }, advanced: true };
}

export function isOnboardingComplete(state: OnboardingState): boolean {
  return nextOnboardingStep(state) === null;
}

/**
 * Is a journey step reachable under the given flags? A step gated by an
 * OFF flag is not reachable in its SaaS form (the invite-only release
 * behaviour, where one exists, is a different path and is not modelled
 * as reachable here).
 */
export function isStepReachable(
  stepId: JourneyStepId,
  env: Record<string, string | undefined> = {},
  flags?: SaasFlags,
): boolean {
  const step = JOURNEY_STEPS.find((s) => s.id === stepId);
  if (!step) return false;
  if (step.gatedBy === null) return true;
  const saas = flags ?? readSaasFlags(env);
  const billing = readBillingFlags(env);
  switch (step.gatedBy) {
    case 'PUBLIC_SIGNUP_ENABLED': return saas.publicSignupEnabled;
    case 'ENTITLEMENTS_ENFORCED': return true; // step exists; enforcement mode only changes blocking, not reachability
    case 'BILLING_ENABLED': return billing.billingEnabled;
    case 'PAYMENTS_LIVE_MODE': return billing.billingEnabled && billing.paymentsLiveMode;
  }
}
