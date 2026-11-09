import Link from "next/link";
import { notFound } from "next/navigation";
import { evaluatePlatformAdminGate } from "@/lib/admin/guard";
import { AdminService } from "@/lib/admin/service";
import { createSyntheticAdminStore } from "@/lib/admin/store";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@/lib/billing/lifecycle";

const FILTERS: readonly (SubscriptionStatus | "free")[] = [...SUBSCRIPTION_STATUSES, "free"];

/**
 * Phase 14 prototype — subscription list with status filters
 * (platform-admin only). The filter is a query param read on the
 * server; the list itself comes from AdminService.listSubscriptions.
 */
export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>;
}) {
  const gate = evaluatePlatformAdminGate(process.env);
  // Gate posture (2026-11-09): like /admin, a failed gate is a plain
  // 404 — an "Access denied" page with HTTP 200 told anonymous
  // visitors this restricted area exists.
  if (!gate.allowed || !gate.actor) notFound();

  const params = (await searchParams) ?? {};
  const status = FILTERS.find((f) => f === params.status);
  const service = new AdminService({ store: createSyntheticAdminStore() });
  const subs = service.listSubscriptions(gate.actor, status ? { status } : {});
  return (
    <div className="space-y-6" data-testid="admin-subscriptions">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Subscriptions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Status filter:{" "}
          <Link href="/admin/subscriptions" className="underline">all</Link>
          {FILTERS.map((f) => (
            <span key={f}>
              {" · "}
              <Link href={`/admin/subscriptions?status=${f}`} className="underline">{f}</Link>
            </span>
          ))}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-left">
              <th className="px-4 py-2 font-medium">Workspace</th>
              <th className="px-4 py-2 font-medium">Plan</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Amount (minor)</th>
              <th className="px-4 py-2 font-medium">Period end</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.subscriptionId} className="border-t border-border">
                <td className="px-4 py-2">{s.workspaceId}</td>
                <td className="px-4 py-2">{s.planId}</td>
                <td className="px-4 py-2">{s.status}</td>
                <td className="px-4 py-2">{s.currency} {s.amountMinor}</td>
                <td className="px-4 py-2">{s.currentPeriodEnd ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {subs.length === 0 && <p className="text-sm text-muted-foreground">No synthetic subscriptions with this status.</p>}
    </div>
  );
}
