/** Phase 12 feature flags — default OFF. Any billing route must check these and be inert (404/503) unless BILLING_ENABLED is on. Live payments additionally require PAYMENTS_LIVE_MODE. This module only reads injected env-like values so tests never touch real env. */
export interface BillingFlags { billingEnabled: boolean; paymentsLiveMode: boolean; }
export function readBillingFlags(env: Record<string, string | undefined> = {}): BillingFlags {
  return { billingEnabled: env.BILLING_ENABLED === 'true', paymentsLiveMode: env.PAYMENTS_LIVE_MODE === 'true' };
}
export const DEFAULT_BILLING_FLAGS: BillingFlags = { billingEnabled: false, paymentsLiveMode: false };
export function assertBillingRouteEnabled(flags: BillingFlags): { ok: true } | { ok: false; status: 503; reason: 'billing-disabled' } {
  return flags.billingEnabled ? { ok: true } : { ok: false, status: 503, reason: 'billing-disabled' };
}

/**
 * Phase 13 — SaaS feature flags. Also default OFF, same pattern:
 *  - PUBLIC_SIGNUP_ENABLED: when off (default) the product keeps its
 *    invite-only posture (see src/lib/signupProtection.ts — untouched by
 *    Phase 13). The (saas) signup prototype renders a disabled state.
 *  - ENTITLEMENTS_ENFORCED: when off (default) the entitlement service
 *    still COMPUTES every decision but reports it in log-only mode and
 *    never blocks. Flipping it on changes behaviour predictably: the
 *    same computed `allowed` value becomes enforced.
 */
export interface SaasFlags {
  publicSignupEnabled: boolean;
  entitlementsEnforced: boolean;
}
export function readSaasFlags(env: Record<string, string | undefined> = {}): SaasFlags {
  return {
    publicSignupEnabled: env.PUBLIC_SIGNUP_ENABLED === 'true',
    entitlementsEnforced: env.ENTITLEMENTS_ENFORCED === 'true',
  };
}
export const DEFAULT_SAAS_FLAGS: SaasFlags = { publicSignupEnabled: false, entitlementsEnforced: false };
