import type { Metadata } from "next";
import { ArrowRight, Check, ShieldCheck } from "@/components/phosphor";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";
import { Reveal, RevealRule } from "@/components/home/Reveal";
import { JsonLd } from "@/components/seo/JsonLd";
import {
  AUTO_DM_DESCRIPTION,
  AUTO_DM_TITLE,
  breadcrumbJsonLd,
  faqPageJsonLd,
  softwareApplicationJsonLd,
  type FaqEntry,
} from "@/lib/seo/schema";
import { PLANS } from "@/lib/billing/catalogue";

/**
 * /auto-dm — the dedicated keyword landing page (SEO pass,
 * 2026-11-10, plan P2). Modelled on the STRUCTURE that ranks #1
 * for "auto dm" (definition-first hero, key-facts box, question-
 * shaped sections, plan guidance, legality, FAQ + schema) with
 * entirely original copy and only shipped product facts: Free ₹0,
 * Starter ₹299 / Growth ₹500 / Pro ₹799, Enterprise custom;
 * accounts 1/1/3/5; unlimited DMs and unlimited automations on
 * every plan; 15-day no-card trial on paid plans; official Meta
 * API with exactly three permissions. No ratings, no reviews,
 * no testimonials — the schema mirrors the visible page.
 */
export const metadata: Metadata = {
  title: AUTO_DM_TITLE,
  description: AUTO_DM_DESCRIPTION,
  alternates: { canonical: "/auto-dm" },
  openGraph: {
    title: `${AUTO_DM_TITLE} | open-autoDM`,
    description: AUTO_DM_DESCRIPTION,
    url: "/auto-dm",
  },
  twitter: {
    title: `${AUTO_DM_TITLE} | open-autoDM`,
    description: AUTO_DM_DESCRIPTION,
  },
};

const AUTO_DM_FAQS: readonly FaqEntry[] = [
  {
    q: "What is an auto DM on Instagram?",
    a: "An auto DM is a direct message that is sent automatically when a trigger happens. With open-autoDM the trigger is a comment: when someone comments the keyword you chose on your Reel or post, they get a public reply under their comment and a DM with your link — no manual typing, even while you sleep.",
  },
  {
    q: "Is open-autoDM free?",
    a: "Yes. The Free plan costs ₹0 and needs no card: comment-to-DM automations for one Instagram account, unlimited DMs, and the limited Creator Studio. Paid plans start at ₹299/mo, and every paid plan begins with a 15-day free trial, no card upfront.",
  },
  {
    q: "Are auto DMs safe for my Instagram account?",
    a: "open-autoDM connects through the official Meta API using your Meta login, so your account works inside Meta's own rules. Built-in sending caps — at most 180 DMs per hour, and the 24-hour messaging window checked before every send — keep volume sensible, and a traffic guard pauses sending automatically when volume spikes.",
  },
  {
    q: "Does it work on Reels and posts?",
    a: "Yes. Keyword comments on both Reels and regular posts can trigger an automation, and you can also choose to respond to every comment on a post instead of only keyword matches.",
  },
  {
    q: "Can I send different DMs for different keywords?",
    a: "Yes. Each automation pairs a post with its own keyword, its own public reply and its own DM, so a comment saying PRICE can receive your pricing while a comment saying LINK receives your guide — each with its own message and button.",
  },
  {
    q: "How many Instagram accounts can I connect?",
    a: "Free and Starter connect 1 Instagram account, Growth connects 3, and Pro connects 5. Enterprise is custom, set by conversation for larger teams and agencies.",
  },
  {
    q: "Is there a limit on DMs?",
    a: "No. DMs are unlimited on every plan, Free included, and automations are unlimited too — there is no per-contact or per-message billing. The built-in safety caps (180 DMs per hour, the 24-hour window) still apply, because they protect your account, not your invoice.",
  },
  {
    q: "Do I need to give my Instagram password?",
    a: "No. You connect your account with the official Meta login and grant exactly three permissions — basic profile access, managing messages and managing comments. open-autoDM never sees or stores your Instagram password.",
  },
];

const KEY_FACTS: [string, string][] = [
  ["Platform", "Instagram — Reels and posts"],
  ["Trigger", "A keyword comment (or every comment, if you choose)"],
  ["What sends", "A public reply under the comment + a DM with your link or button"],
  ["DMs", "Unlimited on every plan, Free included"],
  ["Automations", "Unlimited on every plan"],
  ["Price", "Free plan · paid plans from ₹299/mo"],
  ["Trial", "15 days free on paid plans, no card needed"],
  ["Connection", "Official Meta login — no password, ever"],
];

const USE_CASES: { title: string; body: string }[] = [
  {
    title: "Send a lead-magnet link",
    body: "Post a Reel about your free guide, checklist or template. Everyone who comments the keyword gets the download link in their DMs automatically — the post keeps collecting leads long after you have moved on to the next video.",
  },
  {
    title: "Share a product or course link",
    body: "Selling a course, a template pack or a product? One keyword on the launch post turns every interested comment into a DM carrying the buy link, instead of a link-in-bio hunt most people never finish.",
  },
  {
    title: "Answer “price” comments",
    body: "Price questions are buying intent. An automation on the keyword PRICE replies publicly so other viewers see the answer exists, and DMs the details privately — the same question stops costing you the same ten minutes, forty times a day.",
  },
  {
    title: "Collect enquiries",
    body: "Coaches, consultants and local businesses can route “details” and “book” comments straight into a DM conversation with a booking link or a first question — the enquiry starts itself, while the interest is warm.",
  },
];

const WHY_POINTS: { title: string; body: string }[] = [
  {
    title: "Unlimited DMs, honestly",
    body: "No per-contact tiers and no per-message charges. A Reel that goes viral is a good day, not a bigger bill.",
  },
  {
    title: "Unlimited automations",
    body: "One automation per post, per keyword, per campaign — as many as your content needs, on every plan.",
  },
  {
    title: "Priced for Indian creators",
    body: "₹299, ₹500 and ₹799 a month, in rupees, with a 15-day free trial and no card asked upfront.",
  },
  {
    title: "Creator Studio included",
    body: "Every plan carries the Studio that makes the next video — scripts, ideas, voiceover and more (limited on Free, full on paid plans).",
  },
  {
    title: "Room for a team",
    body: "Paid plans add Instagram accounts and team seats inside one workspace, so a manager or editor can run the loop with you.",
  },
  {
    title: "Analytics that close the loop",
    body: "See which posts and keywords actually produced comments and DMs, then make more of what worked.",
  },
];

const inr = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN")}`;

export default function AutoDmPage() {
  const selfServe = PLANS.filter((p) => !p.customPricing);
  const enterprise = PLANS.find((p) => p.customPricing);

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <JsonLd data={softwareApplicationJsonLd()} />
      <JsonLd data={faqPageJsonLd(AUTO_DM_FAQS)} />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Auto DM", path: "/auto-dm" },
        ])}
      />

      {/* Header — mirrors the landing chrome. */}
      <header className="relative z-10 border-b border-border">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
          <a href="/" className="flex items-center gap-3" aria-label="open-autoDM home">
            <LogoMark className="h-8 w-8" />
            <LogoWordmark className="text-[15px]" />
          </a>
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
            <a href="/auto-dm" className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-foreground">
              Auto DM
            </a>
            <a href="/pricing" className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground">
              Pricing
            </a>
            <a href="#faq" className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <a
              href="/login"
              className="hidden h-9 items-center rounded-md px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:inline-flex"
            >
              Sign in
            </a>
            <a
              href="/get-started"
              className="inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
            >
              Get started
            </a>
          </div>
        </div>
      </header>

      <main>
        {/* ── Hero ─────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-5 pb-16 pt-12 sm:pt-16 lg:px-8">
          <nav aria-label="Breadcrumb" className="text-[13px] text-muted-foreground">
            <a href="/" className="transition-colors hover:text-foreground">Home</a>
            <span aria-hidden className="mx-2">/</span>
            <span className="text-foreground">Auto DM</span>
          </nav>
          <Reveal className="mt-8 max-w-3xl">
            <h1 className="font-heading text-[38px] font-bold leading-[1.08] tracking-tight sm:text-5xl">
              Auto DM for Instagram: automatic DMs from <em>comments</em>
            </h1>
            <p className="mt-5 text-base leading-relaxed text-muted-foreground lg:text-lg lg:leading-relaxed">
              An auto DM is a direct message Instagram sends for you when someone
              comments your keyword on a Reel or post. open-autoDM watches for that
              comment, replies to it publicly so the thread looks alive, and sends
              the commenter a DM with your link — through the official Meta API,
              with a follow check if you want one. Set it up once; every comment
              after that answers itself. The Free plan is enough to start.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <span className="conic-glow-pill">
                <a
                  href="/get-started"
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-obsidian/30 bg-side px-5 text-sm font-bold text-obsidian"
                >
                  Start free
                  <ArrowRight className="h-4 w-4" />
                </a>
              </span>
              <a
                href="/pricing"
                className="inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                See pricing
              </a>
            </div>
          </Reveal>

          {/* Key facts */}
          <Reveal className="mt-14">
            <h2 className="micro-label">Key facts</h2>
            <dl className="mt-5 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {KEY_FACTS.map(([term, value]) => (
                <div key={term} className="bg-card p-5">
                  <dt className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {term}
                  </dt>
                  <dd className="mt-2 text-sm font-medium leading-relaxed">{value}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </section>

        {/* ── What is an auto DM? ──────────────────────────── */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20 lg:px-8">
            <Reveal className="max-w-3xl">
              <p className="micro-label">The basics</p>
              <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                What is an <em>auto DM?</em>
              </h2>
              <RevealRule className="mt-6 max-w-24" />
              <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-muted-foreground">
                <p>
                  Creators end their Reels with a call to action: “Comment LINK and
                  I will send you the guide.” Without automation, that promise
                  means hours of manual replying — and most commenters never get
                  their DM, because a person cannot keep up with a post that is
                  taking off. An auto DM tool keeps the promise automatically:
                  it detects the keyword in a new comment and sends the prepared
                  message instantly.
                </p>
                <p>
                  The good version does two things at once. The commenter gets a
                  public reply under their comment (“Sent — check your DMs”), which
                  shows every other viewer that commenting works, and a private DM
                  carrying the link, offer or next step. The comment thread stays
                  warm, the link actually lands, and the creator's evening stays
                  their own.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────── */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20 lg:px-8">
            <Reveal className="max-w-2xl">
              <p className="micro-label">How it works</p>
              <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                How Instagram auto DM works with <em>open-autoDM</em>
              </h2>
              <RevealRule className="mt-6 max-w-24" />
            </Reveal>
            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-3">
              {[
                {
                  n: "01",
                  title: "Connect Instagram",
                  body: "Sign in with the official Meta login and grant three permissions — basic profile access, managing messages and managing comments. No password is typed into open-autoDM, and nothing runs through a browser bot.",
                },
                {
                  n: "02",
                  title: "Create the automation",
                  body: "Pick the Reel or post, choose the keyword, and write the two messages: the public reply everyone sees, and the DM with your link or button. Add an optional follow check if the link should ask for a follow first.",
                },
                {
                  n: "03",
                  title: "Turn it on",
                  body: "From that moment, every matching comment gets its reply and its DM within moments, day or night. Your analytics show which posts and keywords are pulling comments and DMs, so the next post is an informed one.",
                },
              ].map((step) => (
                <div key={step.n} className="bg-card p-6 sm:p-8">
                  <p className="font-accent text-lg italic text-muted-foreground">{step.n}</p>
                  <h3 className="mt-3 font-heading text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Use cases ────────────────────────────────────── */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20 lg:px-8">
            <Reveal className="max-w-2xl">
              <p className="micro-label">Use cases</p>
              <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                What can you use auto DM <em>for?</em>
              </h2>
              <RevealRule className="mt-6 max-w-24" />
            </Reveal>
            <div className="mt-10 grid gap-6 sm:grid-cols-2">
              {USE_CASES.map((u) => (
                <Reveal key={u.title}>
                  <h3 className="font-heading text-lg font-semibold">{u.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{u.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── Why open-autoDM ──────────────────────────────── */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20 lg:px-8">
            <Reveal className="max-w-2xl">
              <p className="micro-label">Why open-autoDM</p>
              <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                Why creators pick <em>open-autoDM</em>
              </h2>
              <RevealRule className="mt-6 max-w-24" />
            </Reveal>
            <ul className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {WHY_POINTS.map((w) => (
                <li key={w.title} className="flex gap-3">
                  <Check className="mt-0.5 h-5 w-5 shrink-0 text-secondary" aria-hidden />
                  <div>
                    <h3 className="font-heading text-[15px] font-semibold">{w.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{w.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Which plan ───────────────────────────────────── */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20 lg:px-8">
            <Reveal className="max-w-2xl">
              <p className="micro-label">Plans</p>
              <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                Which plan do I <em>need?</em>
              </h2>
              <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
                Start Free if you run one account and want the loop working today.
                Move up when you add accounts or teammates — DMs and automations
                stay unlimited on every tier. Every paid plan starts with a
                15-day free trial, no card needed.
              </p>
              <RevealRule className="mt-6 max-w-24" />
            </Reveal>
            <Reveal className="mt-10 overflow-hidden rounded-xl border border-border">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-[12px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th scope="col" className="px-5 py-3.5 font-semibold">Plan</th>
                    <th scope="col" className="px-5 py-3.5 font-semibold">Price</th>
                    <th scope="col" className="px-5 py-3.5 font-semibold">Instagram accounts</th>
                    <th scope="col" className="px-5 py-3.5 font-semibold">DMs &amp; automations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-card">
                  {selfServe.map((plan) => (
                    <tr key={plan.id}>
                      <th scope="row" className="px-5 py-4 font-heading font-semibold">
                        {plan.name}
                      </th>
                      <td className="px-5 py-4">
                        {plan.prices.INR.monthlyMinor === 0
                          ? "₹0"
                          : `${inr(plan.prices.INR.monthlyMinor)} / month`}
                      </td>
                      <td className="px-5 py-4">{plan.limits.instagramAccounts}</td>
                      <td className="px-5 py-4">Unlimited</td>
                    </tr>
                  ))}
                  {enterprise && (
                    <tr>
                      <th scope="row" className="px-5 py-4 font-heading font-semibold">
                        {enterprise.name}
                      </th>
                      <td className="px-5 py-4">Custom</td>
                      <td className="px-5 py-4">Custom</td>
                      <td className="px-5 py-4">Unlimited</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Reveal>
            <p className="mt-5 text-sm text-muted-foreground">
              Full comparison, including Creator Studio and team seats, on the{" "}
              <a href="/pricing" className="font-medium text-foreground underline underline-offset-4">
                pricing page
              </a>
              .
            </p>
          </div>
        </section>

        {/* ── Allowed by Meta ──────────────────────────────── */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20 lg:px-8">
            <Reveal className="max-w-3xl">
              <p className="micro-label">Safety</p>
              <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                Is Instagram auto DM <em>allowed?</em>
              </h2>
              <RevealRule className="mt-6 max-w-24" />
              <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-muted-foreground">
                <p>
                  Yes — when it runs the way open-autoDM runs it. The connection
                  uses Meta's official API and your own Meta login; you grant
                  exactly three permissions, and the tool works inside the same
                  messaging rules Meta sets for every business and creator
                  account, including the 24-hour window for message replies.
                </p>
                <p className="flex gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-secondary" aria-hidden />
                  <span>
                    What to avoid anywhere: tools that ask for your Instagram
                    password, run browser bots that pretend to be you, or blast
                    messages outside Meta's windows. Those are the patterns that
                    get accounts restricted — none of them is how this works.
                  </span>
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────── */}
        <section id="faq" className="scroll-mt-16 border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20 lg:px-8">
            <Reveal className="max-w-2xl">
              <p className="micro-label">FAQ</p>
              <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                Frequently asked <em>questions</em>
              </h2>
              <RevealRule className="mt-6 max-w-24" />
            </Reveal>
            <div className="mt-10 max-w-3xl divide-y divide-border border-y border-border">
              {AUTO_DM_FAQS.map((f) => (
                <div key={f.q} className="py-6">
                  <h3 className="font-heading text-[15px] font-semibold">{f.q}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
                </div>
              ))}
            </div>

            <Reveal className="mt-14 max-w-3xl">
              <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                Your next Reel could answer its own <em>comments</em>
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                Create the free account, connect Instagram, and put your first
                keyword live in minutes.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <a
                  href="/get-started"
                  className="inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                >
                  Start free
                  <ArrowRight className="h-4 w-4" />
                </a>
                <a
                  href="/"
                  className="inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  See how the platform works
                </a>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* Footer — mirrors the landing footer. */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8 lg:px-10">
          <div className="flex items-center gap-2.5">
            <LogoMark className="h-6 w-6" />
            <span className="text-[13px] text-muted-foreground">open-autoDM</span>
          </div>
          <div className="flex flex-wrap items-center gap-5 text-[13px] text-muted-foreground">
            <a href="/auto-dm" className="transition-colors hover:text-foreground">
              Auto DM
            </a>
            <a href="/pricing" className="transition-colors hover:text-foreground">
              Pricing
            </a>
            <a href="/get-started" className="transition-colors hover:text-foreground">
              Get started
            </a>
            <a href="/privacy-policy" className="transition-colors hover:text-foreground">
              Privacy Policy
            </a>
            <a href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </a>
            <a href="/data-deletion" className="transition-colors hover:text-foreground">
              Data Deletion
            </a>
            <a href="/login" className="transition-colors hover:text-foreground">
              Sign in
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
