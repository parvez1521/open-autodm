import { PLANS, CATALOGUE_STATUS, type CurrencyCode, type Plan } from "@/lib/billing/catalogue";

/**
 * Phase 13 prototype — pricing page rendering the DRAFT catalogue.
 * Prices are proposals only (catalogue status: draft-unapproved) and are
 * labelled as such in the UI. Nothing here can charge anyone:
 * BILLING_ENABLED / PAYMENTS_LIVE_MODE default OFF.
 */
function formatMinor(minor: number, currency: CurrencyCode): string {
  if (minor === 0) return currency === "INR" ? "₹0" : "$0";
  const major = minor / 100;
  return currency === "INR"
    ? `₹${major.toLocaleString("en-IN")}`
    : `$${major.toLocaleString("en-US")}`;
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5" data-testid={`plan-${plan.id}`}>
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">{plan.proposedName}</h2>
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          DRAFT — unapproved
        </span>
      </div>
      <p className="mt-3 text-2xl font-semibold">
        {formatMinor(plan.prices.INR.monthlyMinor, "INR")}
        <span className="text-sm font-normal text-muted-foreground"> / mo · </span>
        {formatMinor(plan.prices.USD.monthlyMinor, "USD")}
        <span className="text-sm font-normal text-muted-foreground"> / mo</span>
      </p>
      <p className="text-[12px] text-muted-foreground">
        Annual: {formatMinor(plan.prices.INR.annualMonthlyMinor, "INR")} / {formatMinor(plan.prices.USD.annualMonthlyMinor, "USD")} per month, billed yearly — draft figures.
      </p>
      <ul className="mt-4 space-y-1 text-[13px] text-muted-foreground">
        <li>{plan.limits.instagramAccounts} Instagram account(s) · {plan.limits.teamSeats} seat(s)</li>
        <li>{plan.limits.activeAutomations} active automations · {plan.limits.dmsPerMonth.toLocaleString()} DMs / month</li>
        <li>{plan.limits.aiDraftingGenerationsPerMonth} AI drafting generations / month</li>
        <li>Data retention: {plan.dataRetentionDays} days · Support: {plan.supportLevel}</li>
      </ul>
      <ul className="mt-3 space-y-1 text-[13px]">
        {plan.capabilityNotes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

export default function PricingPrototypePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Pricing (prototype)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Catalogue status: <strong>{CATALOGUE_STATUS}</strong>. Every price and limit below is a
          draft proposal awaiting owner approval — no plan can be purchased and no payment is taken
          on this page.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {PLANS.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
      </div>
      <p className="text-[12px] text-muted-foreground">
        Safety and compliance features — recipient opt-outs, data deletion, webhook verification,
        comment moderation — are included on every tier including Free and are never metered.
      </p>
    </div>
  );
}
