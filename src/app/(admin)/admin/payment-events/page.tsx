import { notFound } from "next/navigation";
import { evaluatePlatformAdminGate } from "@/lib/admin/guard";
import { AdminService } from "@/lib/admin/service";
import { createSyntheticAdminStore } from "@/lib/admin/store";

/**
 * Phase 14 prototype — payment event history (platform-admin only).
 * Mirrors the Phase 12 sanitized event model: metadata only, no raw
 * payloads, no card data.
 */
export default function AdminPaymentEventsPage() {
  const gate = evaluatePlatformAdminGate(process.env);
  // Gate posture (2026-11-09): like /admin, a failed gate is a plain
  // 404 — an "Access denied" page with HTTP 200 told anonymous
  // visitors this restricted area exists.
  if (!gate.allowed || !gate.actor) notFound();

  const service = new AdminService({ store: createSyntheticAdminStore() });
  const events = service.listPaymentEvents(gate.actor);
  const failed = service.listFailedPayments(gate.actor);
  return (
    <div className="space-y-6" data-testid="admin-payment-events">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Payment event history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {events.length} synthetic events · {failed.events.length} failed payment(s) needing recovery follow-up.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-left">
              <th className="px-4 py-2 font-medium">Provider event</th>
              <th className="px-4 py-2 font-medium">Workspace</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Outcome</th>
              <th className="px-4 py-2 font-medium">Occurred</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.eventId} className="border-t border-border">
                <td className="px-4 py-2">{e.provider}/{e.providerEventId}</td>
                <td className="px-4 py-2">{e.workspaceId}</td>
                <td className="px-4 py-2">{e.type}</td>
                <td className="px-4 py-2">{e.outcome}</td>
                <td className="px-4 py-2">{e.occurredAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
