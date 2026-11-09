"use client";

/**
 * Pricing page UI — renders the billing catalogue.
 *
 * This is the CLIENT half of /pricing. The route file
 * (src/app/(saas)/pricing/page.tsx) is a thin server wrapper —
 * the billing page's pattern — that reads the billing flags
 * server-side and passes `checkoutLive`: the exact gate the
 * checkout route itself applies (BILLING_ENABLED on +
 * PAYMENTS_LIVE_MODE on + a payment provider configured; see
 * src/app/api/billing/checkout/route.ts). The header's
 * "Checkout is being switched on…" sentence renders ONLY while
 * that gate is closed. Until 2026-11-08 the sentence was static
 * copy, so it kept claiming nothing could be purchased after
 * checkout had been wired and switched on — now it follows the
 * server-side state and cannot go stale again.
 *
 * Prices are OWNER-APPROVED (2026-11-08, design pass round 5):
 * Free ₹0 · Starter ₹299/mo (1 account) · Growth ₹500/mo (3) ·
 * Pro ₹799/mo (5) · Enterprise custom — "For Business / Agency",
 * Contact Us instead of a price. Creator Studio is included on
 * every plan; self-serve paid plans start with a 15-day free
 * trial, no card needed.
 *
 * Layout: tall VERTICAL plan columns standing side by side,
 * like a classic pricing table (owner screenshot reference,
 * 2026-11-08 ~18:36 IST — this supersedes the round-6 banded
 * rows and the stacked-box fix f7a25c3; both missed what the
 * owner meant by "vertical"). Growth carries a flat "Best
 * value" banner and a stronger brand outline. The columns grid
 * breaks out of the prototype shell's narrow main column so the
 * five columns can stand side by side on desktop (xl: 5 across,
 * lg: 3 + 2 wrap, mobile: one stacked column of tall cards). A
 * limit-by-limit comparison table still sits below the columns.
 *
 * De-clutter + geo-currency + monthly-only pass (owner
 * instruction, 2026-11-08 ~19:38 IST): the page had grown messy,
 * so —
 *  - ONE currency per visitor, chosen by country (India → INR,
 *    everywhere else → USD) via lib/billing/geo +
 *    useDisplayCurrency; ₹ and $ never render together. The
 *    first paint is INR (the SSR default) and the client corrects
 *    it on mount when the visitor is outside India.
 *  - MONTHLY ONLY: the monthly/annual toggle is gone entirely,
 *    and no annual figure renders anywhere on the page. (The
 *    catalogue keeps its annual data fields for the billing
 *    APIs; surfaces simply never show them.)
 *  - Each column is SHORT: plan name → price → CTA → at most
 *    five key facts. The dense capability-notes lists that used
 *    to fill the columns moved out; the full limit-by-limit
 *    detail still lives in the comparison table below.
 *  - Auto DMs are UNLIMITED on every plan (owner decision,
 *    2026-11-09 — the per-plan DM caps were removed); Free's
 *    Creator Studio stays limited, paid plans keep the full
 *    Studio.
 * All figures come from lib/billing/catalogue.
 *
 * Single-file on purpose: the customer-journey render harness
 * esbuild-transforms THIS component file itself and loads its
 * imports through vite without a JSX transform, so a statically
 * imported JSX subcomponent cannot be parsed there. The currency
 * hook is a plain TS module, which the harness loads fine. (The
 * server wrapper page.tsx only passes the checkoutLive boolean
 * in — it holds no UI of its own.)
 *
 * Plan actions (subscription wiring, 2026-11-08): a signed-OUT
 * visitor keeps the get-started flow; a signed-IN user is routed
 * into the billing flow instead (/billing?plan=… preselects the
 * plan) where trial start and checkout are workspace-bound and
 * owner-gated server-side. Exception (QA fix, 2026-11-08): the Free
 * plan's signed-in action is a non-navigating "Current plan"
 * marker — "Manage billing" promised a billing console that does
 * not exist while billing is disabled. Sign-in state is probed client-side
 * (GET /api/workspaces: 401 = signed out, anything else = signed
 * in) so static rendering — and the harness — always shows the
 * signed-out variant.
 */

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { fadeUp, staggerChild, staggerParent } from "@/lib/motion/presets";
import {
  PLANS,
  TRIAL_DAYS,
  isSelfServePaidPlan,
  type Plan,
  type SupportLevel,
} from "@/lib/billing/catalogue";
import { formatPriceMinor } from "@/lib/billing/geo";
import { useDisplayCurrency } from "@/lib/billing/useDisplayCurrency";
import type { CurrencyCode } from "@/lib/billing/catalogue";

/** The contact address the legal pages already publish. */
const CONTACT_HREF = "mailto:work.techhacksai@gmail.com";

/**
 * Check marker for the key-facts lists — Phosphor's regular
 * Check glyph (256 viewBox; path data from the icon set, which
 * the rest of the site draws via "@/components/phosphor") drawn
 * inline instead of imported. The import is avoided on purpose:
 * the render harness loads this page's imports through vite,
 * and the wrapper barrel pulls the whole icon package into that
 * render, pushing the page past the harness's time budget. The
 * glyph, weight and colour are identical to the wrapped Check.
 */
function CheckMark() {
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
    >
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

const SUPPORT_LABELS: Record<SupportLevel, string> = {
  community: "Community",
  email: "Email",
  "priority-email": "Priority email",
  dedicated: "Dedicated",
};

/** Numeric dimensions render "Custom" for the custom-priced plan. */
function orCustom(plan: Plan, value: string): string {
  return plan.customPricing ? "Custom" : value;
}

const DIMENSIONS: { label: string; value: (plan: Plan) => string }[] = [
  { label: "Workspaces", value: (p) => orCustom(p, String(p.limits.workspaces)) },
  { label: "Instagram accounts", value: (p) => orCustom(p, String(p.limits.instagramAccounts)) },
  { label: "Team seats", value: (p) => orCustom(p, String(p.limits.teamSeats)) },
  { label: "Active automations", value: (p) => orCustom(p, p.limits.activeAutomations === null ? "Unlimited automations" : String(p.limits.activeAutomations)) },
  { label: "DMs / month", value: (p) => orCustom(p, p.limits.dmsPerMonth === null ? "Unlimited" : p.limits.dmsPerMonth.toLocaleString("en-IN")) },
  { label: "Audience contacts / month", value: (p) => orCustom(p, p.limits.contactsPerMonth.toLocaleString("en-IN")) },
  { label: "AI drafting generations / month", value: (p) => orCustom(p, p.limits.aiDraftingGenerationsPerMonth.toLocaleString("en-IN")) },
  { label: "Script Writer generations / month", value: (p) => orCustom(p, p.limits.scriptWriterGenerationsPerMonth.toLocaleString("en-IN")) },
  { label: "Follow-up messages / month", value: (p) => orCustom(p, p.limits.followUpsPerMonth.toLocaleString("en-IN")) },
  { label: "Data retention", value: (p) => orCustom(p, `${p.dataRetentionDays} days`) },
  { label: "Support", value: (p) => SUPPORT_LABELS[p.supportLevel] },
  {
    label: "Free trial",
    value: (p) => (p.customPricing ? "Talk to us" : isSelfServePaidPlan(p) ? `${TRIAL_DAYS} days, no card needed` : "—"),
  },
  {
    label: "Creator Studio",
    // Owner instruction, 2026-11-08 ~19:38 IST: full Studio on
    // paid plans, limited on Free.
    value: (p) => (p.id === "free" ? "Included (limited)" : "Included"),
  },
];

/** The Studio line for a plan column: limited on Free, full elsewhere. */
function studioFact(plan: Plan): string {
  return plan.id === "free" ? "Creator Studio (limited)" : "Creator Studio included";
}

/**
 * The column's SHORT key-facts list (owner de-clutter instruction,
 * 2026-11-08 ~19:38 IST): accounts, auto DMs, automations, Studio
 * — never more than five lines. Everything else lives in the
 * comparison table below the columns.
 */
function keyFacts(plan: Plan): string[] {
  const accounts = plan.limits.instagramAccounts;
  return [
    `${accounts} Instagram account${accounts === 1 ? "" : "s"}`,
    plan.limits.dmsPerMonth === null
      ? "Unlimited auto DMs / month"
      : `${plan.limits.dmsPerMonth.toLocaleString("en-IN")} auto DMs / month`,
    plan.limits.activeAutomations === null
      ? "Unlimited automations"
      : `${plan.limits.activeAutomations} active automations`,
    studioFact(plan),
  ];
}

/** Enterprise keeps three short facts of its own (all limits custom). */
const ENTERPRISE_FACTS: readonly string[] = [
  "Custom accounts, seats and volumes",
  "Creator Studio included",
  "Priority support",
];

/**
 * One tall vertical plan column, deliberately sparse: name →
 * price → CTA → short key facts, top-to-bottom in a single
 * column. Growth (owner screenshot reference, 2026-11-08
 * ~18:36 IST) is the highlighted pick: a flat brand "Best value"
 * banner across the top of its column and a stronger outline.
 */
function PlanColumn({ plan, currency, signedIn }: { plan: Plan; currency: CurrencyCode; signedIn: boolean }) {
  const highlighted = plan.id === "creator-pro";
  const columnClassName = `flex h-full flex-col p-6 ${
    highlighted ? "border-2 border-primary" : "border border-border"
  }`;

  if (plan.customPricing) {
    // Enterprise (owner instruction, 2026-11-08): positioned
    // "For Business / Agency", Contact Us instead of any price,
    // figure or checkout action.
    return (
      <motion.div
        layout
        variants={staggerChild}
        className={columnClassName}
        data-testid={`plan-${plan.id}`}
      >
        <div>
          <h2 className="font-heading text-base font-semibold">{plan.name}</h2>
          <p className="mt-3 font-heading text-3xl font-semibold">Custom pricing</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            For Business / Agency. Tell us how many accounts you run and we
            will put a number on it — no checkout, no card.
          </p>
          <a
            href={CONTACT_HREF}
            className="mt-5 flex h-10 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            Contact us
          </a>
        </div>
        <div className="mt-6 border-t border-border pt-6">
          <ul className="space-y-2.5 text-[13px]">
            {ENTERPRISE_FACTS.map((fact) => (
              <li key={fact} className="flex gap-2">
                <CheckMark />
                <span>{fact}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      variants={staggerChild}
      className={columnClassName}
      data-testid={`plan-${plan.id}`}
    >
      {highlighted && (
        <p className="animate-caption-pop -mx-6 -mt-6 mb-6 bg-primary px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-primary-foreground">
          Best value
        </p>
      )}
      <div>
        <h2 className="font-heading text-base font-semibold">{plan.name}</h2>
        <p className="mt-3 font-heading text-3xl font-semibold">
          {formatPriceMinor(plan.prices[currency].monthlyMinor, currency)}
          <span className="text-sm font-normal text-muted-foreground"> / mo</span>
        </p>
        {isSelfServePaidPlan(plan) && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            Starts with a {TRIAL_DAYS}-day free trial — no card needed.
          </p>
        )}
        {signedIn ? (
          plan.id === "free" ? (
            // QA fix (2026-11-08): the Free column used to offer "Manage
            // billing" — a promise of a working billing console while
            // BILLING_ENABLED is off and /billing renders its inert
            // state. A signed-in user without a paid subscription IS
            // on Free, so the honest state is a non-action marker.
            <span
              aria-disabled="true"
              className="mt-5 flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-muted-foreground"
            >
              Current plan
            </span>
          ) : (
            <a
              href={`/billing?plan=${plan.id}`}
              className="mt-5 flex h-10 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
            >
              Start free trial
            </a>
          )
        ) : (
          <a
            href="/get-started"
            className="mt-5 flex h-10 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            Get started
          </a>
        )}
      </div>
      <div className="mt-6 border-t border-border pt-6">
        <ul className="space-y-2.5 text-[13px]">
          {keyFacts(plan).map((fact) => (
            <li key={fact} className="flex gap-2">
              <CheckMark />
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </div>
    </motion.div>
  );
}

export default function PricingClient({ checkoutLive }: { checkoutLive: boolean }) {
  const currency = useDisplayCurrency();
  const [signedIn, setSignedIn] = useState(false);

  // Session probe (client-only; static renders stay signed-out):
  // GET /api/workspaces authenticates first — 401 means signed out,
  // any other response (200 list, or 503 while workspace runtime is
  // off) means a session exists.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces")
      .then((res) => {
        if (!cancelled) setSignedIn(res.status !== 401);
      })
      .catch(() => {
        /* offline / blocked: keep the signed-out variant */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="space-y-6">
      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <h1 className="font-heading text-2xl font-semibold">Pricing</h1>
        {/* Persona-QA fix 6 (2026-11-09, owner-approved): the
            internal catalogue-attribution line that used to sit
            under this heading — staging bookkeeping naming the
            catalogue's approval state, the date the prices were
            set, and a "service in preparation" claim — rendered on
            the public page, where it contradicted the live
            trial/checkout offers. It is gone. The checkout-honesty
            sentence stays: it renders ONLY while checkout is
            genuinely closed (checkoutLive false), which is the one
            case where a visitor must be told no payment can be
            taken here yet. */}
        {!checkoutLive && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Checkout is being switched on, so no plan can be purchased and no payment is taken
            on this page yet.
          </p>
        )}
      </motion.div>

      {/* The plan columns break out of the shell's narrow main
          column so the five tall columns can stand side by side
          on desktop, as in the owner's reference. */}
      <div className="relative left-1/2 w-[min(80rem,calc(100vw_-_2.5rem))] -translate-x-1/2">
        <motion.div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
          variants={staggerParent}
          initial="hidden"
          animate="show"
        >
          {PLANS.map((plan) => (
            <PlanColumn key={plan.id} plan={plan} currency={currency} signedIn={signedIn} />
          ))}
        </motion.div>
      </div>

      <motion.div
        className="overflow-x-auto"
        variants={fadeUp}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-6% 0px -6% 0px" }}
      >
        <p className="micro-label">Compare every limit</p>
        <table className="mt-4 w-full min-w-[620px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-3 pr-4 font-medium text-muted-foreground">
                Included
              </th>
              {PLANS.map((plan) => (
                <th key={plan.id} scope="col" className="py-3 pr-4 font-heading text-sm font-semibold">
                  {plan.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DIMENSIONS.map((dim) => (
              <tr key={dim.label} className="border-b border-border">
                <th scope="row" className="py-3 pr-4 font-normal text-muted-foreground">
                  {dim.label}
                </th>
                {PLANS.map((plan) => (
                  <td key={plan.id} className="py-3 pr-4">
                    {dim.value(plan)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </motion.div>

      <motion.div
        className="border-t border-border pt-6"
        variants={fadeUp}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-6% 0px -6% 0px" }}
      >
        <p className="micro-label">On every plan, including Free</p>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          Creator Studio comes with every plan — limited on Free, full on paid plans. Safety and
          compliance features, recipient opt-outs, data deletion, webhook verification and comment
          moderation are included on every tier including Free and are never metered.
        </p>
      </motion.div>
    </div>
  );
}
