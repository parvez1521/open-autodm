import dynamic from "next/dynamic";
import { readBillingFlags } from "@/lib/billing/flags";
import { resolveActiveBillingProvider } from "@/lib/billing/activeProvider";

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
export default function PricingPage() {
  const flags = readBillingFlags(process.env);
  const checkoutLive =
    flags.billingEnabled &&
    flags.paymentsLiveMode &&
    resolveActiveBillingProvider(process.env) !== null;

  return <PricingClient checkoutLive={checkoutLive} />;
}
