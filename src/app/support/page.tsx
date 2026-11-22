/**
 * Support — the genuine support route for open-autoDM
 * (2026-11-23, production-pages audit). There is no live-chat
 * widget or ticket system in this product: the verified support
 * channel is email to the operator (work.techhacksai@gmail.com,
 * the same contact used in the Privacy Policy §7 and the billing
 * panel). This page states that honestly, tells users what to
 * include in a report, and links to the real places that resolve
 * most issues (Billing, Settings, Data Deletion, FAQ). Public
 * chrome mirrors the sign-in page header/footer.
 */
import type { Metadata } from "next";
import { ArrowLeft, EnvelopeSimple } from "@/components/phosphor";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";

export const metadata: Metadata = {
  // Bare segment — the root template renders "Support | open-autoDM".
  title: "Support",
  description: "Get help with open-autoDM — contact the operator, what to include in a report, and links to Billing, Settings, and Data Deletion.",
  alternates: { canonical: "/support" },
  openGraph: {
    title: "Support | open-autoDM",
    description: "Get help with open-autoDM — contact the operator, what to include in a report, and links to Billing, Settings, and Data Deletion.",
    url: "/support",
  },
  twitter: {
    title: "Support | open-autoDM",
    description: "Get help with open-autoDM — contact the operator, what to include in a report, and links to Billing, Settings, and Data Deletion.",
  },
};

export default function SupportPage() {
  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      {/* Header — same public chrome as the sign-in page */}
      <header className="relative z-10">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6 lg:px-10">
          <a href="/" className="flex items-center gap-3" aria-label="open-autoDM home">
            <LogoMark className="h-8 w-8" />
            <LogoWordmark className="text-[15px]" />
          </a>
          <a
            href="/"
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </a>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-2xl flex-1 px-6 py-10 sm:py-14">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Support
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          Something not working, or a question about your account,
          billing, or an automation? Write to the operator — email is
          the support channel for open-autoDM. There is no live chat,
          so email is the fastest way to reach a person who can help.
        </p>

        {/* Contact */}
        <section className="mt-8 rounded-xl border border-border bg-card p-5">
          <h2 className="font-heading text-[15px] font-semibold text-foreground">Contact the operator</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
            For account, billing, and automation issues. Include the
            details below so the problem can be found without a
            back-and-forth.
          </p>
          <a
            href="mailto:work.techhacksai@gmail.com"
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-[13.5px] font-semibold text-background transition-opacity hover:opacity-90"
          >
            <EnvelopeSimple className="h-4 w-4" />
            work.techhacksai@gmail.com
          </a>
        </section>

        {/* What to include */}
        <section className="mt-8">
          <h2 className="font-heading text-[15px] font-semibold text-foreground">What to include in your message</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-muted-foreground">
            <li>The email address you sign in with.</li>
            <li>Your workspace name, if you know it.</li>
            <li>What you were doing when the problem happened, and what you expected instead.</li>
            <li>The automation name, if the issue is about one automation.</li>
            <li>Any error message shown on screen — copy the text, or the reference code if one was shown.</li>
            <li>A screenshot, if it helps show the problem.</li>
          </ul>
        </section>

        {/* Quick links */}
        <section className="mt-8">
          <h2 className="font-heading text-[15px] font-semibold text-foreground">Things you can check yourself</h2>
          <ul className="mt-3 space-y-2 text-[14px] leading-relaxed">
            <li>
              <a href="/billing" className="text-primary underline underline-offset-2 hover:text-foreground">Billing</a>
              <span className="text-muted-foreground"> — your plan, trial, recent orders, and payment status.</span>
            </li>
            <li>
              <a href="/settings" className="text-primary underline underline-offset-2 hover:text-foreground">Settings</a>
              <span className="text-muted-foreground"> — connected Instagram accounts and Facebook Pages, password, and session.</span>
            </li>
            <li>
              <a href="/data-deletion" className="text-primary underline underline-offset-2 hover:text-foreground">Data Deletion</a>
              <span className="text-muted-foreground"> — how to remove a connected account or request deletion of your data.</span>
            </li>
            <li>
              <a href="/#faq" className="text-primary underline underline-offset-2 hover:text-foreground">Frequently asked questions</a>
              <span className="text-muted-foreground"> — answers to the most common questions, on the homepage.</span>
            </li>
          </ul>
        </section>
      </main>

      {/* Footer — same public chrome as the sign-in page */}
      <footer className="relative z-10">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-x-5 gap-y-2 px-6 py-8 text-[13px] text-muted-foreground lg:px-10">
          <span>open-autoDM</span>
          <a href="/privacy-policy" className="transition-colors hover:text-foreground">
            Privacy Policy
          </a>
          <a href="/terms" className="transition-colors hover:text-foreground">
            Terms
          </a>
          <a href="/data-deletion" className="transition-colors hover:text-foreground">
            Data Deletion
          </a>
        </div>
      </footer>
    </div>
  );
}
