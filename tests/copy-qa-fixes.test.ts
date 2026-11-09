/**
 * Copy QA fixes (2026-11-08) — source pins.
 *
 * A live QA pass over the preview deployment as a fresh,
 * zero-automation, no-Instagram user found four defects (report:
 * ~/workspace/opendm-audit-2026-11-08/copy-qa-fix-status.md):
 *
 *  1. /automations showed three bare skeleton rectangles forever —
 *     the page discarded the list query's error, so AutomationsList
 *     had NO error state at all: a settled failure silently rendered
 *     the "No automations yet" empty state and an unsettled fetch
 *     left the skeleton up indefinitely. ContactsList (same page)
 *     had the identical flaw.
 *  2. /pricing is catalogue-sourced (pinned here + in
 *     customer-journey), but the Free plan's signed-in button read
 *     "Manage billing" while billing is disabled.
 *  3. Settings → Instagram accounts mapped a failed accounts fetch
 *     to "No accounts connected yet." and shared the unbounded
 *     loading bars.
 *  4. The (saas) shell nav rendered "Get started" for signed-in
 *     users too — no session affordance, no way into the app.
 *  5. (Minor) the dashboard getting-started checklist is pinned
 *     label↔target truthful: every step's link is the surface its
 *     label names.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PLANS } from '../src/lib/billing/catalogue';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

describe('QA fix 1 — the automations list has an honest error state', () => {
  const page = readSrc('app/(main)/automations/page.tsx');
  const list = readSrc('components/automations/AutomationsList.tsx');

  it('the page consumes the query error and hands it to the list with a retry', () => {
    expect(page).toContain('error: automationsError');
    expect(page).toContain('loadError={automationsError?.message ?? null}');
    expect(page).toContain('onRetry={() => void refetchAutomations()}');
  });

  it('the list renders a retryable error state BEFORE the empty state', () => {
    expect(list).toContain('loadError');
    expect(list).toContain('onRetry');
    expect(list).toContain("Couldn&apos;t load your automations");
    expect(list).toContain('Try again');
    expect(list).toContain('role="alert"');
    // The empty state still exists — but only a settled, successful
    // empty result may reach it, so the error branch comes first.
    expect(list).toContain('No automations yet');
    expect(list.indexOf("Couldn&apos;t load your automations")).toBeLessThan(
      list.indexOf('No automations yet'),
    );
  });

  it('a refresh failure with rows on screen says so instead of going silent', () => {
    expect(list).toContain("Couldn&apos;t refresh the list");
  });

  it('ContactsList (same page) no longer maps a failed fetch to its empty state', () => {
    const contacts = readSrc('components/automations/ContactsList.tsx');
    expect(contacts).toContain('error: contactsError');
    expect(contacts).toContain("Couldn&apos;t load your contacts");
    // The error guard is evaluated before the empty-list branch.
    expect(contacts.indexOf('contactsError && !contacts')).toBeLessThan(
      contacts.indexOf('contacts.length === 0'),
    );
    // The pinned counter template is untouched.
    expect(contacts).toContain('`${filtered.length} contact${filtered.length !== 1 ? "s" : ""}`');
  });
});

describe('QA fix 3 — Settings Instagram accounts: failure is not "no accounts"', () => {
  const settings = readSrc('app/(main)/settings/page.tsx');

  it('the accounts query error is consumed with a refetch', () => {
    expect(settings).toContain('error: accountsError');
    expect(settings).toContain('refetch: refetchAccounts');
    expect(settings).toContain('accountsError && !accounts');
  });

  it('the error branch renders before the rows and the empty state', () => {
    expect(settings).toContain("Couldn&apos;t load your Instagram accounts.");
    expect(settings).toContain('No accounts connected yet.');
    expect(settings.indexOf('accountsError && !accounts')).toBeLessThan(
      settings.indexOf('accounts && accounts.length > 0'),
    );
  });
});

describe('QA fix 2 — /pricing: one catalogue source, honest Free action', () => {
  const pricing = readSrc('components/pricing/PricingClient.tsx');
  // Code-only view: the page's header comment legitimately DOCUMENTS
  // the approved figures and the old label; the pins below are about
  // what the code renders, so comments are stripped first.
  const pricingCode = pricing
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('the catalogue holds the owner-approved figures (₹ primary, $ secondary)', () => {
    const byId = new Map(PLANS.map((p) => [p.id, p]));
    expect(byId.get('starter')!.prices.INR.monthlyMinor).toBe(29900);
    expect(byId.get('starter')!.prices.USD.monthlyMinor).toBe(500);
    expect(byId.get('creator-pro')!.prices.INR.monthlyMinor).toBe(50000);
    expect(byId.get('creator-pro')!.prices.USD.monthlyMinor).toBe(900);
    expect(byId.get('agency')!.prices.INR.monthlyMinor).toBe(79900);
    expect(byId.get('agency')!.prices.USD.monthlyMinor).toBe(1500);
  });

  it('the pricing page renders from the catalogue — no second price list', () => {
    expect(pricingCode).toContain('PLANS');
    expect(pricingCode).toContain('lib/billing/catalogue');
    // No hardcoded currency figures anywhere in the page's code
    // (₹0 / $0 are the formatter's zero case, not a price).
    expect(pricingCode).not.toMatch(/₹[1-9]/);
    expect(pricingCode).not.toMatch(/\$[1-9]/);
    expect(pricingCode).not.toContain('monthlyMinor:');
  });

  it('the landing band reads the same catalogue (single source of truth)', () => {
    const landing = readSrc('app/page.tsx');
    expect(landing).toContain('lib/billing/catalogue');
    expect(landing).toContain('PLANS.map');
  });

  it('the Free plan no longer promises a billing console that is switched off', () => {
    expect(pricingCode).not.toContain('Manage billing');
    expect(pricingCode).toContain('Current plan');
    // Signed-out visitors keep the get-started action.
    expect(pricingCode).toContain('Get started');
    // Paid plans keep their trial route into /billing.
    expect(pricingCode).toContain('Start free trial');
  });
});

describe('QA fix 4 — the (saas) shell nav is session-aware', () => {
  const layout = readSrc('app/(saas)/layout.tsx');
  const slot = readSrc('components/saas/SaasNavAccount.tsx');

  it('the layout mounts the session slot instead of a static Get started link', () => {
    expect(layout).toContain('SaasNavAccount');
    expect(layout).not.toContain('href="/get-started"');
  });

  it('the signed-out rendering is the exact link the header always had', () => {
    expect(slot).toContain('<Link href="/get-started" className="hover:text-foreground">');
    expect(slot).toContain('Get started');
    // Initial state is signed-out, so prerendered HTML is unchanged.
    expect(slot).toContain('useState<string | null>(null)');
  });

  it('a confirmed session swaps in the email and an Open app entry', () => {
    expect(slot).toContain('auth');
    expect(slot).toContain('getUser()');
    expect(slot).toContain('href="/dashboard"');
    expect(slot).toContain('Open app');
  });
});

describe('QA fix 5 — dashboard getting-started steps are label↔target truthful', () => {
  // 2026-11-10: the dashboard UI moved to
  // components/dashboard/DashboardClient.tsx (the route page is now
  // a server wrapper), and the first step changed under the owner's
  // directive the same day: "Save your Meta app credentials" (→ the
  // then-public Setup Wizard) became "Choose your plan" (→ /pricing)
  // — the hosted journey starts with a plan, not a Meta app.
  const dashboard = readSrc('components/dashboard/DashboardClient.tsx');

  it('every checklist step links to the surface its label names', () => {
    expect(dashboard).toContain('{ label: "Choose your plan", done: planChoiceDone || billingPlanChosen, href: "/pricing" }');
    expect(dashboard).not.toContain('Save your Meta app credentials');
    expect(dashboard).toContain('{ label: "Connect your Instagram account", done: !!connectedAccount, href: "/settings" }');
    expect(dashboard).toContain('{ label: "Create your first automation", done: (automations?.length ?? 0) > 0, href: "/automations" }');
    expect(dashboard).toContain('{ label: "Activate it", done: activeCount > 0, href: "/automations" }');
  });
});
