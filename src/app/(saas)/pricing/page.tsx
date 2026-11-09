import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { readBillingFlags } from "@/lib/billing/flags";
import { resolveActiveBillingProvider } from "@/lib/billing/activeProvider";
import { PRICING_DESCRIPTION, PRICING_TITLE } from "@/lib/seo/schema";

/**
 * Page metadata (SEO pass, 2026-11-10, plan P1): keyword/price
 * title + description from the research templates, self-canonical,
 * social tags (the image comes from the root opengraph-image).
 */
export const metadata: Metadata = {
  title: PRICING_TITLE,
  description: PRICING_DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: `${PRICING_TITLE} | open-autoDM`,
    description: PRICING_DESCRIPTION,
    url: "/pricing",
  },
  twitter: {
    title: `${PRICING_TITLE} | open-autoDM`,
    description: PRICING_DESCRIPTION,
  },
};

// Loaded via next/dynamic (the billing page's pattern) so this
// server page stays free of static client-component imports — the
// customer-journey render harness cannot parse a statically
// imported JSX component; it renders the client component file
// (src/components/pricing/PricingClient.tsx) directly instead.
const PricingClient = dynamic(() => import("@/components/pricing/PricingClient"));

/**
 * Pricing — server wrapper (launch fix, 2026-11-08).
 *
 * The page used to carry a static sentence claiming checkout was
 * "being switched on, so no plan can be purchased" — true when it
 * was written, stale the moment the owner wired Cashfree and
 * flipped the billing flags on: the page kept telling customers
 * they could not buy while checkout was live.
 *
 * The sentence now follows the SAME server-side state the
 * checkout route itself enforces (src/app/api/billing/checkout):
 * checkout is live exactly when BILLING_ENABLED is on AND
 * PAYMENTS_LIVE_MODE is on AND a payment provider is configured
 * (lib/billing/activeProvider — Cashfree primary, Razorpay
 * fallback). `checkoutLive` is computed here, server-side, and
 * passed down; the client component renders the sentence only
 * while the gate is closed, so the copy tracks reality on every
 * deployment without a code change when flags flip.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string | string[] }>;
}) {
  const flags = readBillingFlags(process.env);
  const checkoutLive =
    flags.billingEnabled &&
    flags.paymentsLiveMode &&
    resolveActiveBillingProvider(process.env) !== null;

  // Plan-picker mode (owner directive, 2026-11-10): the dashboard
  // routes brand-new users here ONCE with ?welcome=1 when they
  // have no plan state and no recorded choice. The client renders
  // the plan-choice banner + choice-recording actions for
  // signed-in users in that mode; a plain public visit is
  // unchanged.
  const params = await searchParams;
  const welcome = params.welcome === "1";

  return <PricingClient checkoutLive={checkoutLive} welcome={welcome} />;
}
