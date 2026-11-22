/**
 * Security Policy + Responsible Disclosure — describes only
 * practices verified in the code (2026-11-23, production-pages
 * audit):
 *  - Meta access tokens encrypted at rest with AES-256-GCM
 *    (src/lib/crypto.ts; Privacy Policy §2B/§4).
 *  - Meta webhook signatures verified with HMAC-SHA256
 *    (src/app/api/webhook/route.ts; Privacy Policy §3).
 *  - Row Level Security on all application tables (Privacy §4).
 *  - Sessions verified server-side with supabase.auth.getUser()
 *    on every protected request — never a locally decoded token
 *    (src/middleware.ts, src/lib/auth.ts).
 *  - Rolling-window rate limits and circuit breakers on the
 *    automation engine (Privacy Policy §3).
 * This page claims NO security certification. The disclosure
 * contact is the operator email already on file
 * (work.techhacksai@gmail.com, Privacy Policy §7) — no separate
 * dedicated security-report address has been set up. Legal review still
 * recommended.
 */
import type { Metadata } from 'next';
import { LegalLayout } from '@/components/legal/LegalLayout';
import Link from 'next/link';

export const metadata: Metadata = {
  // Bare segment — the root template renders "Security | open-autoDM".
  title: 'Security',
  description: 'How open-autoDM protects your accounts and data, and how to report a security issue responsibly.',
  alternates: { canonical: '/security' },
  openGraph: {
    title: 'Security | open-autoDM',
    description: 'How open-autoDM protects your accounts and data, and how to report a security issue responsibly.',
    url: '/security',
  },
  twitter: {
    title: 'Security | open-autoDM',
    description: 'How open-autoDM protects your accounts and data, and how to report a security issue responsibly.',
  },
};

export default function SecurityPage() {
  return (
    <LegalLayout
      title="Security"
      subtitle="How open-autoDM protects your accounts and data, and how to report a security issue responsibly."
      lastUpdated="November 23, 2026"
      activePath="/security"
    >
      {/* Practices */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">1. How Your Accounts &amp; Data Are Protected</h2>
        <p>
          open-autoDM connects to your Instagram and Facebook accounts
          and sends messages on your behalf, so protecting those
          connections is central to how the service is built. These are
          the practices actually in place:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Encrypted tokens:</strong> the
            access tokens received from Meta are encrypted at rest with
            AES-256-GCM before they are stored in the database.
          </li>
          <li>
            <strong className="text-foreground">Verified webhooks:</strong> every
            incoming webhook from Meta has its signature checked with
            HMAC-SHA256 against the configured Meta app secret, so
            spoofed or injected events are rejected.
          </li>
          <li>
            <strong className="text-foreground">Database access control:</strong> all
            application tables use Row Level Security, and direct
            database mutations are locked down to trusted server-side
            execution roles.
          </li>
          <li>
            <strong className="text-foreground">Verified sessions:</strong> every
            protected request verifies the session server-side with the
            authentication provider. Sessions are never trusted from a
            token decoded on the client.
          </li>
          <li>
            <strong className="text-foreground">Abuse limits:</strong> rolling-window
            rate limits and automated circuit breakers cap how many
            messages an automation can send, protecting connected
            accounts from runaway sends.
          </li>
          <li>
            <strong className="text-foreground">Payments:</strong> card and bank
            details are entered on Cashfree&apos;s own payment pages and
            are never received or stored by open-autoDM.
          </li>
        </ul>
        <p>
          This page describes practices we actually follow. It does not claim any security certification, and no certification
          should be assumed from anything on this site.
        </p>
      </section>

      {/* Limits */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">2. Limits To Be Aware Of</h2>
        <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
          <li>
            No system is immune to attack. If you reuse passwords or
            share your login, open-autoDM cannot protect your account —
            use a unique password and keep it private.
          </li>
          <li>
            Messages are delivered through Meta&apos;s platforms, so
            delivery also depends on Meta&apos;s availability and rules.
            See the Terms of Service for the platform limitations that
            apply.
          </li>
        </ul>
      </section>

      {/* Responsible disclosure */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">3. Responsible Disclosure</h2>
        <p>
          If you find a security issue in open-autoDM, please report it
          privately so it can be fixed before it is discussed publicly.
          Send a description of the issue, the steps to reproduce it,
          and what you believe the impact is to the operator contact
          on file:
        </p>
        <div className="p-4 rounded-lg bg-muted/30 border border-border flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="font-semibold text-foreground text-[14px]">open-autoDM Administration</p>
            <p className="text-xs text-muted-foreground">Security Reports (operator contact on file)</p>
          </div>
          <a
            href="mailto:work.techhacksai@gmail.com"
            className="text-sm font-mono text-primary hover:underline hover:text-foreground transition-colors"
          >
            work.techhacksai@gmail.com
          </a>
        </div>
        <p>When testing, please follow these rules:</p>
        <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
          <li>
            Test only against your own account and workspace. Do not
            attempt to access, modify, or delete other customers&apos;
            accounts, workspaces, or data.
          </li>
          <li>
            Do not use automated scanning that degrades the service for
            others, and do not attempt social engineering or phishing
            of the operator or other users.
          </li>
          <li>
            Do not publish details of an issue before it has been fixed.
          </li>
        </ul>
        <p>
          Reports are reviewed by the operator. Please do not expect a
          fixed response time — every report is assessed and genuine
          issues are fixed as a priority.
        </p>
      </section>

      {/* Related */}
      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-xl font-heading font-bold text-foreground">4. Related Pages</h2>
        <p>
          For how your data is collected and handled, see the{' '}
          <Link href="/privacy-policy" className="text-primary underline underline-offset-2 hover:text-foreground">
            Privacy Policy
          </Link>
          {' '}and the{' '}
          <Link href="/cookie-policy" className="text-primary underline underline-offset-2 hover:text-foreground">
            Cookie Policy
          </Link>
          . For the rules of using the service, see the{' '}
          <Link href="/terms" className="text-primary underline underline-offset-2 hover:text-foreground">
            Terms of Service
          </Link>
          .
        </p>
      </section>
    </LegalLayout>
  );
}
