"use client";

/**
 * Pricing page rendering the billing catalogue.
 *
 * Prices are OWNER-APPROVED (2026-11-08, design pass round 5):
 * Free ₹0 · Starter ₹299/mo (1 account) · Growth ₹500/mo (3) ·
 * Pro ₹799/mo (5) · Enterprise custom — "For Business / Agency",
 * Contact Us instead of a price. Creator Studio is included on
 * every plan; self-serve paid plans start with a 15-day free
 * trial, no card needed. Nothing here can charge anyone yet:
 * checkout is being switched on (BILLING_ENABLED /
 * PAYMENTS_LIVE_MODE default OFF, no provider keys configured),
 * and the copy says so.
 *
 * Layout: banded comparison rows with a monthly/annual toggle,
 * plus a limit-by-limit comparison table — no tier-card grid.
 * Round 6 (2026-11-08, owner feedback): each plan row now sits
 * in its own flat outlined box with vertical gaps, so every
 * plan reads as an individual unit; copy and figures unchanged.
 * Motion pass (2026-11-08, owner instruction ~17:59 IST): the
 * period toggle is a segmented control with a shared layoutId
 * indicator, plan boxes stagger in and reflow with `layout`, and
 * the price figure flips vertically when the period changes —
 * all from the shared motion system (lib/motion/presets), on the
 * `motion` package. Figures and copy unchanged.
 * All figures come from lib/billing/catalogue.
 *
 * Single-file on purpose: the customer-journey render harness
 * esbuild-transforms the page file itself and loads its imports
 * through vite without a JSX transform, so a statically imported
 * JSX subcomponent cannot be parsed there. The toggle state lives
 * in this client page instead.
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
import { AnimatePresence, motion } from "motion/react";
import { EASE_OUT, SPRING_SNAPPY, fadeUp, staggerChild, staggerParent } from "@/lib/motion/presets";
import {
  PLANS,
  CATALOGUE_STATUS,
  TRIAL_DAYS,
  isSelfServePaidPlan,
  type BillingPeriod,
  type CurrencyCode,
  type Plan,
  type SupportLevel,
} from "@/lib/billing/catalogue";

/** The contact address the legal pages already publish. */
const CONTACT_HREF = "mailto:work.techhacksai@gmail.com";

function formatMinor(minor: number, currency: CurrencyCode): string {
  if (minor === 0) return currency === "INR" ? "₹0" : "$0";
  const major = minor / 100;
  return currency === "INR"
    ? `₹${major.toLocaleString("en-IN")}`
    : `$${major.toLocaleString("en-US")}`;
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
  { label: "Active automations", value: (p) => orCustom(p, String(p.limits.activeAutomations)) },
  { label: "DMs / month", value: (p) => orCustom(p, p.limits.dmsPerMonth.toLocaleString("en-IN")) },
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
  { label: "Creator Studio", value: () => "Included" },
];

function PlanRow({ plan, period, signedIn }: { plan: Plan; period: BillingPeriod; signedIn: boolean }) {
  const inr = plan.prices.INR;
  const usd = plan.prices.USD;
  const inrFigure = period === "monthly" ? inr.monthlyMinor : inr.annualMonthlyMinor;
  const usdFigure = period === "monthly" ? usd.monthlyMinor : usd.annualMonthlyMinor;

  if (plan.customPricing) {
    // Enterprise (owner instruction, 2026-11-08): positioned
    // "For Business / Agency", Contact Us instead of any price,
    // figure or checkout action.
    return (
      <motion.div
        layout
        variants={staggerChild}
        className="grid gap-5 border border-border p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-12 lg:p-7"
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
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            Contact us
          </a>
        </div>
        <div>
          <ul className="space-y-1 text-[13px]">
            {plan.capabilityNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-muted-foreground">
            Accounts, seats and volumes are agreed with you — custom limits,
            priority support.
          </p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      variants={staggerChild}
      className="grid gap-5 border border-border p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-12 lg:p-7"
      data-testid={`plan-${plan.id}`}
    >
      <div>
        <h2 className="font-heading text-base font-semibold">{plan.name}</h2>
        <p className="mt-3 font-heading text-3xl font-semibold">
          <span className="relative inline-flex overflow-hidden">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={period}
                initial={{ y: 14, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -14, opacity: 0 }}
                transition={{ duration: 0.28, ease: EASE_OUT }}
                className="inline-flex items-baseline"
              >
                {formatMinor(inrFigure, "INR")}
                <span className="text-sm font-normal text-muted-foreground"> / mo · </span>
                {formatMinor(usdFigure, "USD")}
                <span className="text-sm font-normal text-muted-foreground"> / mo</span>
              </motion.span>
            </AnimatePresence>
          </span>
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          {period === "monthly"
            ? `Annual billing: ${formatMinor(inr.annualMonthlyMinor, "INR")} / ${formatMinor(usd.annualMonthlyMinor, "USD")} per month, billed yearly.`
            : `Billed yearly: ${formatMinor(inr.annualTotalMinor, "INR")} / ${formatMinor(usd.annualTotalMinor, "USD")} per year.`}
        </p>
        {isSelfServePaidPlan(plan) && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            Starts with a {TRIAL_DAYS}-day free trial — no card needed.
          </p>
        )}
        {signedIn ? (
          plan.id === "free" ? (
            // QA fix (2026-11-08): the Free row used to offer "Manage
            // billing" — a promise of a working billing console while
            // BILLING_ENABLED is off and /billing renders its inert
            // state. A signed-in user without a paid subscription IS
            // on Free, so the honest state is a non-action marker.
            <span
              aria-disabled="true"
              className="mt-4 inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm font-semibold text-muted-foreground"
            >
              Current plan
            </span>
          ) : (
            <a
              href={`/billing?plan=${plan.id}&period=${period}`}
              className="mt-4 inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
            >
              Start free trial
            </a>
          )
        ) : (
          <a
            href="/get-started"
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            Get started
          </a>
        )}
      </div>
      <div className="grid gap-x-10 gap-y-4 sm:grid-cols-2">
        <ul className="space-y-1 text-[13px] text-muted-foreground">
          <li>{plan.limits.instagramAccounts} Instagram account(s) · {plan.limits.teamSeats} seat(s)</li>
          <li>{plan.limits.activeAutomations} active automations · {plan.limits.dmsPerMonth.toLocaleString("en-IN")} DMs / month</li>
          <li>{plan.limits.aiDraftingGenerationsPerMonth} AI drafting generations / month</li>
          <li>Data retention: {plan.dataRetentionDays} days · Support: {SUPPORT_LABELS[plan.supportLevel]}</li>
        </ul>
        <ul className="space-y-1 text-[13px]">
          {plan.capabilityNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </motion.div>
  );
}

export default function PricingPrototypePage() {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
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
        <h1 className="font-heading text-2xl font-semibold">Pricing (prototype)</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Catalogue status: <strong>{CATALOGUE_STATUS}</strong> — these prices were set by the
          owner on 2026-11-08. Checkout is being switched on, so no plan can be purchased and no
          payment is taken on this page yet. The hosted service itself is in preparation —
          self-hosting the open-source release stays free.
        </p>
      </motion.div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Motion pass (2026-11-08): the period toggle is now a
            segmented control whose indicator is one shared element
            (layoutId) that springs between Monthly and Annual. */}
        <div className="flex items-center gap-1 rounded-lg border border-border p-1" role="group" aria-label="Billing period">
          {(["monthly", "annual"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
              className="relative h-8 rounded-md px-4 text-sm font-medium"
            >
              {period === p && (
                <motion.span
                  layoutId="billing-period-pill"
                  className="absolute inset-0 rounded-md bg-foreground"
                  transition={SPRING_SNAPPY}
                />
              )}
              <span className={`relative z-10 ${period === p ? "font-semibold text-background" : "text-foreground"}`}>
                {p === "monthly" ? "Monthly" : "Annual"}
              </span>
            </button>
          ))}
        </div>
        <p className="text-[13px] text-muted-foreground">
          Annual billing runs about 20% lower on every paid tier. Every paid plan starts with a{" "}
          {TRIAL_DAYS}-day free trial — no card needed.
        </p>
      </div>

      <motion.div className="space-y-5" variants={staggerParent} initial="hidden" animate="show">
        {PLANS.map((plan) => (
          <PlanRow key={plan.id} plan={plan} period={period} signedIn={signedIn} />
        ))}
      </motion.div>

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
          Creator Studio, safety and compliance features, recipient opt-outs, data deletion,
          webhook verification, comment moderation, are included on every tier including Free and
          are never metered.
        </p>
      </motion.div>
    </div>
  );
}
