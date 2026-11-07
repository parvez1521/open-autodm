/**
 * Phase 14 — access-denied surface for the (admin) prototype. Rendered
 * whenever the platform-admin gate stub denies: it contains NO customer
 * data, by design (the pages only build the admin service after the
 * gate passes).
 */
export default function AdminAccessDenied({ reason }: { reason: string }) {
  return (
    <div className="mx-auto max-w-md space-y-4 rounded-xl border border-border bg-card p-6" data-testid="admin-denied">
      <h1 className="font-heading text-xl font-semibold">Platform admin — access denied</h1>
      <p className="text-sm text-muted-foreground">
        This area is restricted to platform administrators. Workspace owner/admin roles do not
        grant access. ({reason})
      </p>
    </div>
  );
}
