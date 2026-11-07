import { evaluatePlatformAdminGate } from "@/lib/admin/guard";
import { AdminService } from "@/lib/admin/service";
import { createSyntheticAdminStore } from "@/lib/admin/store";
import AdminAccessDenied from "@/lib/admin/denied";

/**
 * Phase 14 prototype — customer directory (platform-admin only).
 * Data comes from the AdminService over synthetic records; when the
 * gate stub denies (the default), no service is constructed and no
 * customer data is rendered.
 */
export default function AdminCustomerDirectoryPage() {
  const gate = evaluatePlatformAdminGate(process.env);
  if (!gate.allowed || !gate.actor) return <AdminAccessDenied reason={gate.reason} />;

  const service = new AdminService({ store: createSyntheticAdminStore() });
  const customers = service.listCustomers(gate.actor);
  return (
    <div className="space-y-6" data-testid="admin-customers">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Customer directory (prototype)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {customers.length} synthetic workspaces. Platform-admin view — workspace roles confer no access here.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-left">
              <th className="px-4 py-2 font-medium">Workspace</th>
              <th className="px-4 py-2 font-medium">Owner</th>
              <th className="px-4 py-2 font-medium">Plan</th>
              <th className="px-4 py-2 font-medium">Subscription</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.workspaceId} className="border-t border-border">
                <td className="px-4 py-2">{c.workspaceName}</td>
                <td className="px-4 py-2">{c.ownerEmail}</td>
                <td className="px-4 py-2">{c.planId ?? "—"}</td>
                <td className="px-4 py-2">{c.subscriptionStatus ?? "—"}</td>
                <td className="px-4 py-2">{c.workspaceStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
