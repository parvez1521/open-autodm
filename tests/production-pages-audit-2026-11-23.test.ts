/**
 * Production-pages audit implementation (2026-11-23).
 *
 * Pins for the 11 build items in docs/PRODUCTION_PAGE_AUDIT.md:
 * Cookie Policy, Accessibility Statement, Security Policy +
 * Responsible Disclosure, Support page, Privacy §5 drafting-only
 * fix, Settings "Your data" section, error-digest reference codes,
 * session-expired signal, offline banner, shared 403 state — and a
 * no-invented-contact regression (the only operator email anywhere
 * in the new pages is the one already on file).
 *
 * Pins are source-text pins in the repo's usual UI-test style (the
 * suite runs node-only with no DOM, so components cannot be
 * rendered): if one breaks, the page or state it guards regressed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const pageExists = (rel: string): boolean =>
  existsSync(path.resolve(process.cwd(), 'src', 'app', rel, 'page.tsx'));

const cookiePolicy = readSrc('app/cookie-policy/page.tsx');
const accessibility = readSrc('app/accessibility/page.tsx');
const security = readSrc('app/security/page.tsx');
const support = readSrc('app/support/page.tsx');
const legalLayout = readSrc('components/legal/LegalLayout.tsx');
const sitemap = readSrc('app/sitemap.ts');
const homePage = readSrc('app/page.tsx');
const loginPage = readSrc('app/login/page.tsx');
const privacy = readSrc('app/privacy-policy/page.tsx');
const settings = readSrc('app/(main)/settings/page.tsx');
const errorPage = readSrc('app/error.tsx');
const globalError = readSrc('app/global-error.tsx');
const middleware = readSrc('middleware.ts');
const loginForm = readSrc('components/auth/LoginForm.tsx');
const offlineBanner = readSrc('components/ui/OfflineBanner.tsx');
const forbiddenState = readSrc('components/ui/ForbiddenState.tsx');
const rootLayout = readSrc('app/layout.tsx');
const billingPanel = readSrc('components/billing/BillingPanel.tsx');

describe('new legal/support routes exist and are wired into navigation', () => {
  it.each(['/cookie-policy', '/accessibility', '/security', '/support'])(
    'route %s exists as a page',
    (route) => {
      expect(pageExists(route.slice(1))).toBe(true);
    },
  );

  it('all four new routes are in the sitemap', () => {
    for (const route of ['/cookie-policy', '/accessibility', '/security', '/support']) {
      expect(sitemap).toContain(`entry("${route}"`);
    }
  });

  it('the homepage footer links all four new pages', () => {
    for (const route of ['/cookie-policy', '/accessibility', '/security', '/support']) {
      expect(homePage).toContain(`href="${route}"`);
    }
  });

  it('the sign-in page footer links Support', () => {
    expect(loginPage).toContain('href="/support"');
  });

  it('the legal nav covers all six legal pages', () => {
    for (const route of [
      '/privacy-policy',
      '/terms',
      '/data-deletion',
      '/cookie-policy',
      '/accessibility',
      '/security',
    ]) {
      expect(legalLayout).toContain(`href: '${route}'`);
    }
    expect(legalLayout).toContain("activePath: '/privacy-policy' | '/terms' | '/data-deletion' | '/cookie-policy' | '/accessibility' | '/security'");
  });

  it('the legal footer links the three new legal pages', () => {
    for (const route of ['/cookie-policy', '/accessibility', '/security']) {
      expect(legalLayout).toContain(`href="${route}"`);
    }
  });
});

describe('cookie policy describes only the verified cookies and storage', () => {
  it('names the session cookies and the display-currency cookie with its 30-day life', () => {
    expect(cookiePolicy).toContain('auth-token');
    expect(cookiePolicy).toContain('geo-currency');
    expect(cookiePolicy).toContain('30 days');
  });

  it('names the real localStorage keys', () => {
    for (const key of [
      'opendm:selected-workspace-id',
      'opendm-automations-channel',
      'opendm-analytics-channel',
      'opendm-switcher-channel',
      'open-autodm:script-writer-history',
    ]) {
      expect(cookiePolicy).toContain(key);
    }
  });

  it('states plainly that no analytics, advertising, or tracking cookies exist', () => {
    expect(cookiePolicy).toContain('no analytics');
    expect(cookiePolicy).toContain('No analytics cookies');
    expect(cookiePolicy).toContain('there is no cookie consent banner to dismiss');
  });
});

describe('accessibility statement makes no conformance claim', () => {
  it('states that no formal audit has been completed and claims no WCAG conformance', () => {
    expect(accessibility).toContain('No formal accessibility audit has been completed');
    expect(accessibility).toContain('makes no claim of conformance with WCAG');
  });

  it('lists only verified features (focus rings, keyboard, reduced motion, announced feedback)', () => {
    expect(accessibility).toContain('focus ring');
    expect(accessibility).toContain('Reduced motion');
    expect(accessibility).toContain('Announced feedback');
  });
});

describe('security page claims no certification and names the contact on file', () => {
  it('lists the verified practices only', () => {
    expect(security).toContain('AES-256-GCM');
    expect(security).toContain('HMAC-SHA256');
    expect(security).toContain('Row Level Security');
  });

  it('claims no certification', () => {
    expect(security).toContain('does not claim any security certification');
    expect(security).not.toContain('SOC 2');
    expect(security).not.toContain('ISO 27001');
    expect(security).not.toContain('PCI-DSS');
  });

  it('disclosure goes to the operator email on file, flagged as such', () => {
    expect(security).toContain('work.techhacksai@gmail.com');
    expect(security).toContain('operator contact on file');
  });
});

describe('support page is honest about the channel', () => {
  it('names email as the support channel and links the real self-serve pages', () => {
    expect(support).toContain('mailto:work.techhacksai@gmail.com');
    expect(support).toContain('There is no live chat');
    expect(support).toContain('href="/billing"');
    expect(support).toContain('href="/settings"');
    expect(support).toContain('href="/data-deletion"');
    expect(support).toContain('href="/#faq"');
  });

  it('tells users what to include in a report', () => {
    expect(support).toContain('What to include in your message');
    expect(support).toContain('reference code');
  });
});

describe('privacy policy §5 is drafting-only', () => {
  it('no longer claims automated contextual responses', () => {
    expect(privacy).not.toContain('generating automated contextual responses');
    expect(privacy).toContain('drafting');
    expect(privacy).toContain('does not generate live automated replies');
  });

  it('records the correction in the header review note', () => {
    expect(privacy).toContain('CORRECTED 2026-11-23');
  });
});

describe('settings has a Your data section with real actions only', () => {
  it('links the contacts export and the data-deletion instructions, with no fake delete button', () => {
    expect(settings).toContain('Your data');
    expect(settings).toContain('href="/contacts"');
    expect(settings).toContain('Export contacts (CSV)');
    expect(settings).toContain('href="/data-deletion"');
    expect(settings).not.toContain('Delete my account');
    expect(settings).not.toContain('Delete account');
  });
});

describe('error boundaries show the digest as a support reference code', () => {
  it('error.tsx renders error.digest with a support link', () => {
    expect(errorPage).toContain('error.digest');
    expect(errorPage).toContain('Reference code:');
    expect(errorPage).toContain('href="/support"');
  });

  it('global-error.tsx accepts the error prop and renders the digest', () => {
    expect(globalError).toContain('error: Error & { digest?: string }');
    expect(globalError).toContain('error.digest');
    expect(globalError).toContain('Reference code:');
  });
});

describe('session-expired signal', () => {
  it('middleware marks the redirect when a session cookie exists but verification failed', () => {
    expect(middleware).toContain("redirectUrl.searchParams.set('session', 'expired')");
    expect(middleware).toContain('hasSupabaseSessionCookie');
    expect(middleware).toContain("cookie.name.includes('auth-token')");
    // A verified-but-disallowed identity is not an expiry.
    expect(middleware).toContain('if (!verifiedUser && hasSupabaseSessionCookie(request))');
  });

  it('the login form surfaces the expired-session message and scrubs the parameter', () => {
    expect(loginForm).toContain('Your session expired. Sign in again.');
    expect(loginForm).toContain('fromQuery.get("session") === "expired"');
  });
});

describe('offline banner', () => {
  it('listens to online/offline events, shows only while offline, and offers a retry', () => {
    expect(offlineBanner).toContain('navigator.onLine');
    expect(offlineBanner).toContain('window.addEventListener("offline", update)');
    expect(offlineBanner).toContain('window.addEventListener("online", update)');
    expect(offlineBanner).toContain('role="status"');
    expect(offlineBanner).toContain('window.location.reload()');
    expect(offlineBanner).toContain("if (!isOffline) return null;");
  });

  it('is rendered in the root layout inside AppProviders and claims no offline queue', () => {
    expect(rootLayout).toContain('<OfflineBanner />');
    expect(offlineBanner).toContain('no offline queue');
  });
});

describe('shared 403 state', () => {
  it('ForbiddenState exists with a compact inline form and a full-page form', () => {
    expect(forbiddenState).toContain('role="alert"');
    expect(forbiddenState).toContain('compact = false');
    expect(forbiddenState).toContain('href="/dashboard"');
    expect(forbiddenState).toContain('href="/support"');
  });

  it('the billing viewer-role denial uses it (compact), keeping the original wording', () => {
    expect(billingPanel).toContain('<ForbiddenState');
    expect(billingPanel).toContain('compact');
    expect(billingPanel).toContain('Billing is managed by the workspace owner');
    expect(billingPanel).toContain('only the workspace owner can start a trial or check out');
  });
});

describe('no invented contact regression', () => {
  it('the only email address in the new pages is the operator email already on file', () => {
    const newPages = [cookiePolicy, accessibility, security, support, legalLayout];
    const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    for (const source of newPages) {
      const emails = source.match(emailPattern) ?? [];
      expect(emails.length).toBeGreaterThan(0);
      for (const email of emails) {
        expect(email).toBe('work.techhacksai@gmail.com');
      }
    }
  });

  it('no separate security@, privacy@, or support@ address was invented', () => {
    for (const source of [cookiePolicy, accessibility, security, support, legalLayout]) {
      expect(source).not.toContain('security@');
      expect(source).not.toContain('privacy@');
      expect(source).not.toContain('support@');
    }
  });
});
