/**
 * Accessibility Statement — states only verified facts about this
 * application (2026-11-23, production-pages audit):
 *  - Semantic headings/landmarks and visible focus indicators are
 *    used across the console (focus-visible rings).
 *  - Keyboard operation: buttons, dialogs, tabs, and forms are
 *    reachable and operable by keyboard.
 *  - Reduced motion is honoured: MotionConfig reducedMotion="user"
 *    (src/components/providers/Providers.tsx) follows the operating
 *    system's setting.
 *  - Error and success states are announced (role="alert" /
 *    role="status" usage in the console).
 *  - The Analytics page shows the same figures in a per-automation
 *    table alongside its charts.
 * NO formal accessibility audit has been completed, and this page
 * makes NO WCAG or other conformance claim. Known limits are stated
 * honestly below. Legal review still recommended.
 */
import type { Metadata } from 'next';
import { LegalLayout } from '@/components/legal/LegalLayout';
import Link from 'next/link';

export const metadata: Metadata = {
  // Bare segment — the root template renders "Accessibility | open-autoDM".
  title: 'Accessibility',
  description: 'How open-autoDM approaches accessibility, what is in place today, known limits, and how to report an issue.',
  alternates: { canonical: '/accessibility' },
  openGraph: {
    title: 'Accessibility | open-autoDM',
    description: 'How open-autoDM approaches accessibility, what is in place today, known limits, and how to report an issue.',
    url: '/accessibility',
  },
  twitter: {
    title: 'Accessibility | open-autoDM',
    description: 'How open-autoDM approaches accessibility, what is in place today, known limits, and how to report an issue.',
  },
};

export default function AccessibilityPage() {
  return (
    <LegalLayout
      title="Accessibility"
      subtitle="How open-autoDM approaches accessibility, what is in place today, known limits, and how to report an issue."
      lastUpdated="November 23, 2026"
      activePath="/accessibility"
    >
      {/* Commitment */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">1. Our Approach</h2>
        <p>
          open-autoDM is built to be usable by as many people as
          possible, including people who navigate by keyboard or use
          assistive technology. Accessibility work is ongoing: this page
          describes what is in place today, states the limits honestly,
          and tells you how to report a problem so it can be fixed.
        </p>
        <p>
          <strong className="text-foreground">No formal accessibility audit has been completed yet</strong>, and this
          page makes no claim of conformance with WCAG or any other accessibility standard. The statements below describe
          features that exist in the product today.
        </p>
      </section>

      {/* What is in place */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">2. What Is In Place Today</h2>
        <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Semantic structure:</strong> pages
            use real headings and landmarks, so screen readers can move
            through the console by section.
          </li>
          <li>
            <strong className="text-foreground">Visible focus:</strong> interactive
            elements show a visible focus ring when navigated to by
            keyboard, so you can always tell where you are.
          </li>
          <li>
            <strong className="text-foreground">Keyboard operation:</strong> buttons,
            dialogs, tabs, menus, and forms in the console are reachable
            and operable without a mouse, and dialogs can be closed with
            the Escape key.
          </li>
          <li>
            <strong className="text-foreground">Reduced motion:</strong> animations
            follow your operating system&apos;s reduced-motion setting —
            when it is on, motion is minimised across the site.
          </li>
          <li>
            <strong className="text-foreground">Announced feedback:</strong> error
            and success messages are announced to assistive technology,
            and error states explain what went wrong and what to do
            next instead of failing silently.
          </li>
          <li>
            <strong className="text-foreground">Data beyond charts:</strong> on the
            Analytics page the same figures shown in charts also appear
            in a per-automation table.
          </li>
        </ul>
      </section>

      {/* Known limits */}
      <section className="space-y-3">
        <h2 className="text-xl font-heading font-bold text-foreground">3. Known Limits</h2>
        <p>
          The following are known gaps. They are listed here so nobody
          has to discover them by trial and error:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
          <li>
            No independent accessibility audit has been carried out, so
            issues in less-used flows may still exist.
          </li>
          <li>
            Some charts and visual previews are primarily visual; where
            a table alternative exists it is linked on the same page,
            but not every visual has one yet.
          </li>
          <li>
            The console is designed for desktop and mobile browsers;
            very small screens may require horizontal scrolling in dense
            tables such as the contacts list.
          </li>
        </ul>
      </section>

      {/* Feedback */}
      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-xl font-heading font-bold text-foreground">4. Report An Accessibility Issue</h2>
        <p>
          If you run into a barrier while using open-autoDM, tell us
          and it will be looked into. Please include the page you were
          on, what you were trying to do, and the device and assistive
          technology you use (for example, a screen reader and browser).
        </p>
        <div className="p-4 rounded-lg bg-muted/30 border border-border flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="font-semibold text-foreground text-[14px]">open-autoDM Administration</p>
            <p className="text-xs text-muted-foreground">Accessibility Feedback</p>
          </div>
          <a
            href="mailto:work.techhacksai@gmail.com"
            className="text-sm font-mono text-primary hover:underline hover:text-foreground transition-colors"
          >
            work.techhacksai@gmail.com
          </a>
        </div>
        <p>
          You can also read how your data is handled in our{' '}
          <Link href="/privacy-policy" className="text-primary underline underline-offset-2 hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </section>
    </LegalLayout>
  );
}
