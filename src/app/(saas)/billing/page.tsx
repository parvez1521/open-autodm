import dynamic from "next/dynamic";
import { readBillingFlags } from "@/lib/billing/flags";

// Loaded via next/dynamic (the get-started page's pattern) so this
// server page stays free of static client-component imports — the
// customer-journey render harness cannot parse a statically imported
// JSX component.
const BillingPanel = dynamic(() => import("@/components/billing/BillingPanel"));

/**
 * Billing section — SaaS subscription wiring (2026-11-08).
 *
 * While BILLING_ENABLED is off (the default) the page renders the
 * inert state and no billing action exists — pinned by the customer-
 * journey tests. When the owner enables billing, the page mounts the
 * customer BillingPanel: current plan + trial state from
 * GET /api/billing/status, trial start and Razorpay checkout actions,
 * all workspace-bound and owner-gated server-side. The panel never
 * claims activation itself — the signed webhook is the only path from
 * payment to access, and the panel shows what the server reports.
 */
export default function BillingPage() {
  const billing = readBillingFlags(process.env);

  if (!billing.billingEnabled) {
    return (
      <div className="mx-auto max-w-md space-y-4 rounded-xl border border-border bg-card p-6" data-testid="billing-inert">
        <h1 className="font-heading text-xl font-semibold">Billing is not enabled</h1>
        <p className="text-sm text-muted-foreground">
          This prototype workspace is on the Free plan. Paid plans are not available yet —
          billing is gated by BILLING_ENABLED, which is off by default, and no payment method
          can be added or charged.
        </p>
      </div>
    );
  }

  return <BillingPanel />;
}
