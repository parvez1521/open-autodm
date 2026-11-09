import { notFound } from "next/navigation";
import { evaluatePlatformAdminGate } from "@/lib/admin/guard";

/**
 * Phase 14 prototype — manual support override form (MOCK).
 * The form is non-functional by design: submission is disabled, no
 * server action exists, and the real path is AdminService (reason
 * required + audit-before-mutate) exercised only in tests. It exists
 * to pin the UX contract: an override can never be submitted without
 * a reason.
 */
export default function AdminOverridesPage() {
  const gate = evaluatePlatformAdminGate(process.env);
  // Gate posture (2026-11-09): like /admin, a failed gate is a plain
  // 404 — an "Access denied" page with HTTP 200 told anonymous
  // visitors this restricted area exists.
  if (!gate.allowed || !gate.actor) notFound();

  return (
    <div className="mx-auto max-w-lg space-y-6" data-testid="admin-overrides">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Support override</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Form over synthetic data — submission is disabled. Every override requires a reason and writes an
          append-only audit event before any state changes; if the audit write fails, the
          override is aborted. Refund execution is not available here — refunds are
          recording-only.
        </p>
      </div>
      <form className="space-y-4 rounded-xl border border-border bg-card p-6" aria-label="Override form">
        <label className="block text-sm">
          Workspace (synthetic)
          <select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" defaultValue="ws-beta" disabled>
            <option value="ws-alpha">Alpha Creators (synthetic)</option>
            <option value="ws-beta">Beta Studio (synthetic)</option>
            <option value="ws-gamma">Gamma Media (synthetic)</option>
          </select>
        </label>
        <label className="block text-sm">
          Override type
          <select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" defaultValue="trial-extension" disabled>
            <option value="plan-change">Plan change</option>
            <option value="trial-extension">Trial extension (days)</option>
            <option value="entitlement-bump">Entitlement bump</option>
          </select>
        </label>
        <label className="block text-sm">
          Reason (required — recorded in the audit log)
          <textarea className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" rows={3} placeholder="e.g. Support ticket #0000 — payment method update in progress" disabled />
        </label>
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground opacity-50" disabled>
          Apply override (disabled)
        </button>
      </form>
    </div>
  );
}
