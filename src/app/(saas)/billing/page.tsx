import { readBillingFlags, readSaasFlags } from "@/lib/billing/flags";
import { evaluateAllEntitlements } from "@/lib/entitlements/service";

/**
 * Phase 13 prototype — billing dashboard stub.
 * Reads the entitlement service with an illustrative (empty) usage
 * snapshot. While BILLING_ENABLED is off (the default) the page renders
 * an inert state and no billing action exists. Enforcement mode is
 * surfaced honestly: log-only vs enforced.
 */
export default function BillingPrototypePage() {
  const billing = readBillingFlags(process.env);
  const saas = readSaasFlags(process.env);

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

  const { resolved, checks } = evaluateAllEntitlements(
    null,
    {},
    { flags: saas },
  );
  return (
    <div className="space-y-6" data-testid="billing-dashboard-stub">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Billing (prototype)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Current plan: <strong>{resolved.plan.name}</strong> ({resolved.resolution}) ·
          Retention {resolved.dataRetentionDays} days · Support {resolved.supportLevel} ·
          Entitlements {saas.entitlementsEnforced ? "ENFORCED" : "log-only (not enforced)"}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-left">
              <th className="px-4 py-2 font-medium">Limit</th>
              <th className="px-4 py-2 font-medium">Used</th>
              <th className="px-4 py-2 font-medium">Limit</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.dimension} className="border-t border-border">
                <td className="px-4 py-2">{c.dimension}</td>
                <td className="px-4 py-2">{c.used}</td>
                <td className="px-4 py-2">{c.limit}</td>
                <td className="px-4 py-2">{c.allowed ? "Within limit" : "At / over limit"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Prototype stub: usage figures are illustrative (no workspace is connected). Plan changes,
        checkout and payment-method updates are not wired in this phase.
      </p>
    </div>
  );
}
