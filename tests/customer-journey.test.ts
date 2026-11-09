/**
 * Phase 13 — customer journey tests.
 * Pins: the 18-step journey model, flag gating (signup disabled by
 * default, billing routes inert by default), prototype page rendering
 * under default flags, and the onboarding state machine's ordering.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The suite runs in node env with no JSX transform (vitest.config.ts), so
 * page .tsx files are transformed with esbuild (jsx: automatic) into a
 * temp module and really rendered with react-dom/server. This exercises
 * the actual page components, not copies of them.
 */
async function renderPage(relPath: string): Promise<string> {
  const src = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
  const { code } = transformSync(src, { loader: 'tsx', jsx: 'automatic', format: 'esm', target: 'es2022' });
  // Written inside the project so vite/vitest resolves the @/ alias and
  // the pages' .ts lib imports exactly as the app build would.
  const tmpDir = path.resolve(process.cwd(), 'tests/.p13-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const name = `page-${Math.random().toString(36).slice(2)}.mjs`;
  fs.writeFileSync(path.join(tmpDir, name), code);
  try {
    const mod = (await import(`./.p13-tmp/${name}`)) as { default: React.ComponentType };
    return renderToStaticMarkup(React.createElement(mod.default));
  } finally {
    fs.unlinkSync(path.join(tmpDir, name));
  }
}

/** renderPage variant for components that take props (e.g. the
 * pricing client, whose checkoutLive boolean comes from the server
 * wrapper page). */
async function renderComponent(relPath: string, props: Record<string, unknown>): Promise<string> {
  const src = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
  const { code } = transformSync(src, { loader: 'tsx', jsx: 'automatic', format: 'esm', target: 'es2022' });
  const tmpDir = path.resolve(process.cwd(), 'tests/.p13-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const name = `page-${Math.random().toString(36).slice(2)}.mjs`;
  fs.writeFileSync(path.join(tmpDir, name), code);
  try {
    const mod = (await import(`./.p13-tmp/${name}`)) as {
      default: React.ComponentType<Record<string, unknown>>;
    };
    return renderToStaticMarkup(React.createElement(mod.default, props));
  } finally {
    fs.unlinkSync(path.join(tmpDir, name));
  }
}
import {
  JOURNEY_STEPS,
  ONBOARDING_STEP_IDS,
  initialOnboardingState,
  nextOnboardingStep,
  completeOnboardingStep,
  isOnboardingComplete,
  isStepReachable,
} from '@/lib/tenancy/journey';
import { readSaasFlags, readBillingFlags, DEFAULT_SAAS_FLAGS } from '@/lib/billing/flags';

describe('journey model', () => {
  it('has exactly 18 steps in canonical order 1..18', () => {
    expect(JOURNEY_STEPS).toHaveLength(18);
    expect(JOURNEY_STEPS.map((s) => s.order)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(new Set(JOURNEY_STEPS.map((s) => s.id)).size).toBe(18);
  });
  it('marks which steps exist today vs new', () => {
    const byId = new Map(JOURNEY_STEPS.map((s) => [s.id, s]));
    expect(byId.get('landing')!.availability).toBe('exists-today');
    expect(byId.get('first-automation')!.availability).toBe('exists-today');
    expect(byId.get('signup')!.availability).toBe('new-saas');
    expect(byId.get('pricing')!.availability).toBe('new-saas');
    expect(byId.get('checkout')!.availability).toBe('new-saas');
    expect(byId.get('instagram-connect')!.availability).toBe('partial-today');
  });
});

describe('flag gating', () => {
  it('new flags default OFF', () => {
    expect(DEFAULT_SAAS_FLAGS).toEqual({ publicSignupEnabled: false, entitlementsEnforced: false });
    expect(readSaasFlags({})).toEqual({ publicSignupEnabled: false, entitlementsEnforced: false });
    expect(readSaasFlags({ PUBLIC_SIGNUP_ENABLED: 'true' }).publicSignupEnabled).toBe(true);
    expect(readSaasFlags({ PUBLIC_SIGNUP_ENABLED: 'yes' }).publicSignupEnabled).toBe(false);
  });
  it('flag-off: signup and billing journey steps are unreachable', () => {
    expect(isStepReachable('signup', {})).toBe(false);
    expect(isStepReachable('email-verification', {})).toBe(false);
    expect(isStepReachable('workspace-creation', {})).toBe(false);
    expect(isStepReachable('billing-dashboard', {})).toBe(false);
    expect(isStepReachable('checkout', {})).toBe(false);
    expect(isStepReachable('cancellation', {})).toBe(false);
  });
  it('flag-off: ungated steps stay reachable (landing, pricing, onboarding info)', () => {
    expect(isStepReachable('landing', {})).toBe(true);
    expect(isStepReachable('pricing', {})).toBe(true);
    expect(isStepReachable('meta-permissions-explained', {})).toBe(true);
  });
  it('checkout needs BOTH billing enabled and live mode', () => {
    expect(isStepReachable('checkout', { BILLING_ENABLED: 'true' })).toBe(false);
    expect(isStepReachable('checkout', { BILLING_ENABLED: 'true', PAYMENTS_LIVE_MODE: 'true' })).toBe(true);
    expect(readBillingFlags({ BILLING_ENABLED: 'true' }).billingEnabled).toBe(true);
  });
  it('signup becomes reachable only with PUBLIC_SIGNUP_ENABLED=true', () => {
    expect(isStepReachable('signup', { PUBLIC_SIGNUP_ENABLED: 'true' })).toBe(true);
  });
});

describe('prototype pages under default flags (all OFF)', () => {
  it('signup page renders the disabled / invite-only state, with no form', async () => {
    const html = await renderPage('src/app/(saas)/get-started/page.tsx');
    expect(html).toContain('signup-disabled');
    expect(html).toContain('invite-only');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('signup-form-prototype');
  });
  it('billing page renders the inert state while BILLING_ENABLED is off', async () => {
    const html = await renderPage('src/app/(saas)/billing/page.tsx');
    expect(html).toContain('billing-inert');
    expect(html).toContain('Billing is not enabled');
  });
  it('pricing page renders every catalogue plan at the owner-approved prices', async () => {
    // The route file is now a thin server wrapper (it computes the
    // checkoutLive gate from the billing flags); the harness renders
    // the client component it loads, with checkout CLOSED — the
    // default-flags posture.
    const html = await renderComponent('src/components/pricing/PricingClient.tsx', {
      checkoutLive: false,
    });
    for (const id of ['free', 'starter', 'creator-pro', 'agency', 'enterprise']) {
      expect(html).toContain(`plan-${id}`);
    }
    // Round 5 (2026-11-08): the owner approved the prices, so the
    // DRAFT labelling is gone; Enterprise renders custom + Contact
    // Us instead of a figure, and the trial offer is on the page.
    expect(html).not.toContain('DRAFT');
    expect(html).not.toContain('draft-unapproved');
    expect(html).toContain('approved');
    expect(html).toContain('₹299');
    // Owner instruction, 2026-11-08 ~19:38 IST: ONE currency per
    // visitor (the server render is the INR default — no $ figure
    // may appear alongside), monthly only (no annual text), Free
    // carries 1,000 auto DMs and the limited Studio.
    expect(html).not.toContain('$5');
    expect(html).not.toContain('$9');
    expect(html).not.toContain('$15');
    expect(html).not.toContain('Annual');
    expect(html).toContain('1,000 auto DMs / month');
    expect(html).toContain('Creator Studio (limited)');
    expect(html).toContain('Custom pricing');
    expect(html).toContain('For Business / Agency');
    expect(html).toContain('Contact us');
    expect(html).toContain('15-day free trial');
    // While checkout is closed, the header says so (the sentence is
    // gated on the server-side billing state — see the next test).
    expect(html).toContain('Checkout is being switched on');
  });
  it('pricing drops the "being switched on" note once checkout is live (2026-11-08 fix)', async () => {
    // The note was STATIC copy until this fix: it kept claiming no
    // plan could be purchased after the owner wired Cashfree and
    // turned the billing flags on. The server wrapper now passes
    // checkoutLive (BILLING_ENABLED + PAYMENTS_LIVE_MODE + a
    // configured provider — the checkout route's own gate) and the
    // sentence renders only while that gate is closed.
    const html = await renderComponent('src/components/pricing/PricingClient.tsx', {
      checkoutLive: true,
    });
    expect(html).not.toContain('Checkout is being switched on');
    expect(html).not.toContain('no plan can be purchased');
    // The catalogue attribution line itself stays, in both states.
    expect(html).toContain('Catalogue status');
    expect(html).toContain('these prices were set by the');
    for (const id of ['free', 'starter', 'creator-pro', 'agency', 'enterprise']) {
      expect(html).toContain(`plan-${id}`);
    }
  });
  it('onboarding page renders the checklist in journey order', async () => {
    const html = await renderPage('src/app/(saas)/onboarding/page.tsx');
    const positions = ONBOARDING_STEP_IDS.map((id) => {
      const step = JOURNEY_STEPS.find((s) => s.id === id)!;
      return html.indexOf(step.title);
    });
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('onboarding state machine', () => {
  it('starts at workspace-creation and is incomplete', () => {
    const s = initialOnboardingState();
    expect(nextOnboardingStep(s)).toBe('workspace-creation');
    expect(isOnboardingComplete(s)).toBe(false);
  });
  it('advances strictly in order; out-of-order completion is rejected', () => {
    let s = initialOnboardingState();
    const early = completeOnboardingStep(s, 'instagram-connect');
    expect(early.advanced).toBe(false);
    expect(early.state.completed).toEqual([]);
    for (const id of ONBOARDING_STEP_IDS) {
      const r = completeOnboardingStep(s, id);
      expect(r.advanced, id).toBe(true);
      s = r.state;
    }
    expect(isOnboardingComplete(s)).toBe(true);
    expect(nextOnboardingStep(s)).toBeNull();
  });
  it('re-completing a step and unknown steps are no-ops', () => {
    const s = completeOnboardingStep(initialOnboardingState(), 'workspace-creation').state;
    expect(completeOnboardingStep(s, 'workspace-creation').advanced).toBe(false);
    expect(completeOnboardingStep(s, 'checkout').advanced).toBe(false); // not an onboarding step
  });
});
