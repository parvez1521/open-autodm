/**
 * Cookie Policy — describes only the cookies and browser storage
 * this application actually uses, verified against the code
 * (2026-11-23, production-pages audit):
 *  - Supabase session cookies via @supabase/ssr (middleware session
 *    refresh, src/middleware.ts); default naming
 *    sb-<project>-auth-token, no cookieOptions override anywhere
 *    in src/lib/supabase/ or src/middleware.ts.
 *  - The geo display-currency cookie `geo-currency`, 30-day maxAge
 *    (src/middleware.ts, src/lib/billing/geo.ts).
 *  - localStorage keys for workspace selection and channel-tab
 *    choices (src/components/workspace/WorkspaceProvider.tsx,
 *    src/app/(main)/automations/page.tsx,
 *    src/app/(main)/analytics/page.tsx,
 *    src/components/dashboard/AccountSwitcher.tsx) and the Script
 *    Writer history (src/app/(main)/script-writer/page.tsx).
 * No analytics, advertising, or cross-site tracking scripts exist
 * (verified: root layout + providers carry none), so there is no
 * non-essential tracking to consent to and no consent banner.
 * Legal review still recommended — this page states verified
 * facts only and claims no compliance certification.
 */
import type { Metadata } from 'next';
import { LegalLayout } from '@/components/legal/LegalLayout';
import Link from 'next/link';

export const metadata: Metadata = {
  // Bare segment — the root template renders "Cookie Policy | open-autoDM".
  title: 'Cookie Policy',
  description: 'The cookies and browser storage open-autoDM uses, what each one is for, and how to clear them.',
  alternates: { canonical: '/cookie-policy' },
  openGraph: {
    title: 'Cookie Policy | open-autoDM',
    description: 'The cookies and browser storage open-autoDM uses, what each one is for, and how to clear them.',
    url: '/cookie-policy',
  },
  twitter: {
    title: 'Cookie Policy | open-autoDM',
    description: 'The cookies and browser storage open-autoDM uses, what each one is for, and how to clear them.',
  },
};

export default function CookiePolicyPage() {
  return (
    <LegalLayout
      title="Cookie Policy"
      subtitle="The cookies and browser storage open-autoDM uses, what each one is for, and how to clear them."
      lastUpdated="November 23, 2026"
      activePath="/cookie-policy"
    >
      {/* Overview */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">1. Overview</h2>
        <p>
          open-autoDM uses only functional cookies and browser storage —
          the pieces needed to keep you signed in, show prices in the
          right currency, and remember which workspace and tab you had
          open. It sets <strong className="text-foreground">no analytics,
          advertising, or cross-site tracking cookies</strong>, and it
          loads no third-party tracking scripts. Because nothing
          non-essential is set, there is no cookie consent banner to dismiss. If that ever changes, this page will be updated
          first.
        </p>
      </section>

      {/* Cookies */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">2. Cookies We Set</h2>
        <p>
          Cookies are small pieces of data your browser stores and sends
          back to open-autoDM with each request:
        </p>

        <div className="space-y-4 pt-2">
          <div className="p-4 rounded-lg bg-muted/40 border border-border">
            <h3 className="font-semibold text-foreground text-[15px] mb-1">A. Sign-in session cookies</h3>
            <p className="text-muted-foreground text-[13.5px]">
              Set by Supabase Auth (the service that handles sign-in) to
              keep you signed in as you move around the console. Their
              names start with <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">sb-</code> and
              contain <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">auth-token</code>
              (a large session is split into numbered parts, for example
              <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono"> .0</code> and
              <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono"> .1</code>).
              They are refreshed automatically while you use the app and
              cleared when you sign out. Without them you would have to
              sign in again on every page.
            </p>
          </div>

          <div className="p-4 rounded-lg bg-muted/40 border border-border">
            <h3 className="font-semibold text-foreground text-[15px] mb-1">B. Display currency cookie</h3>
            <p className="text-muted-foreground text-[13.5px]">
              Name: <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">geo-currency</code>.
              Remembers whether prices are shown in INR or USD, decided once from your country when you first visit.
              It lasts 30 days and is set only when absent. It holds no personal data — just the currency code.
            </p>
          </div>
        </div>
      </section>

      {/* Browser storage */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">3. Browser Storage (localStorage)</h2>
        <p>
          These values live only in your own browser and are never sent
          to the server. Clearing them resets the remembered choices to
          their defaults; the app keeps working.
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
          <li>
            <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">opendm:selected-workspace-id</code> — the
            workspace you last opened.
          </li>
          <li>
            <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">opendm-automations-channel</code>,{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">opendm-analytics-channel</code>,{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">opendm-switcher-channel</code> — whether
            the Instagram or Facebook tab was selected on the automations
            page, the analytics page, and the account switcher.
          </li>
          <li>
            <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">open-autodm:script-writer-history</code> — your
            Script Writer history, kept in your browser only.
          </li>
        </ul>
      </section>

      {/* What we do not use */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">4. What We Do Not Use</h2>
        <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
          <li>No analytics cookies or analytics scripts.</li>
          <li>No advertising cookies or ad networks.</li>
          <li>No cross-site tracking or fingerprinting.</li>
          <li>No social-media tracking pixels.</li>
        </ul>
        <p>
          Your browsing on open-autoDM is not shared with advertisers,
          and nothing on this site is used to follow you around the web.
        </p>
      </section>

      {/* Managing cookies */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">5. Managing Cookies &amp; Storage</h2>
        <p>
          You can clear cookies and site data at any time from your
          browser&apos;s settings. Doing so signs you out of open-autoDM
          and resets the remembered workspace and tab choices; your
          automations, contacts, and billing records are stored
          server-side and are not affected. Signing out from Settings
          also clears the sign-in session cookies.
        </p>
        <p>
          For how your account and automation data is handled, see
          our{' '}
          <Link href="/privacy-policy" className="text-primary underline underline-offset-2 hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </section>

      {/* Contact */}
      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-xl font-heading font-bold text-foreground">6. Contact the Operator</h2>
        <p>
          If you have questions about the cookies or storage described
          on this page, contact open-autoDM Administration:
        </p>
        <div className="p-4 rounded-lg bg-muted/30 border border-border flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="font-semibold text-foreground text-[14px]">open-autoDM Administration</p>
            <p className="text-xs text-muted-foreground">Privacy &amp; Cookie Inquiries</p>
          </div>
          <a
            href="mailto:work.techhacksai@gmail.com"
            className="text-sm font-mono text-primary hover:underline hover:text-foreground transition-colors"
          >
            work.techhacksai@gmail.com
          </a>
        </div>
      </section>
    </LegalLayout>
  );
}
