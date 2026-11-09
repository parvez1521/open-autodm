import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabase/service";
import {
  isAdminEmail,
  loadAdminOverview,
  type AdminAuthUser,
} from "@/lib/admin/panel";
import { formatPriceMinor } from "@/lib/billing/geo";

// Per-request rendering, always: the gate reads the caller's live
// session and the panel shows live billing state. Prerendering this
// page would freeze both — and evaluate the gate at build time.
export const dynamic = "force-dynamic";

/**
 * Owner admin panel — subscribers (2026-11-09).
 *
 * Shows every workspace that has taken a subscription: who they
 * are, their plan and status, and the recent order book. This is
 * the REAL panel over the billing tables (lib/admin/panel.ts),
 * superseding the Phase 14 synthetic customer-directory prototype
 * that used to render here; the other (admin) pages remain Phase 14
 * prototypes behind their stub.
 *
 * ACCESS GATE (security-critical): the session is resolved
 * server-side from the verified Supabase session (getUser — never
 * client state, never workspace roles), and access requires the
 * session email to be listed in the ADMIN_EMAILS env var. ANYONE
 * else — anonymous visitors, signed-in customers, even the owner
 * while ADMIN_EMAILS is unset — gets notFound(): a plain 404 that
 * does not reveal this panel exists. The service-role client is
 * constructed ONLY after the gate passes, so a denied request
 * never touches billing data.
 */
async function readSessionEmail(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.email ?? null;
  } catch {
    return null;
  }
}

/** Page through the Auth user list (service role) for owner emails. */
async function listAllAuthUsers(db: SupabaseClient): Promise<AdminAuthUser[]> {
  const users: AdminAuthUser[] = [];
  const perPage = 200;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Admin panel: failed to list auth users: ${error.message}`);
    for (const u of data.users) {
      users.push({ id: u.id, email: u.email ?? null, createdAt: u.created_at ?? null });
    }
    if (data.users.length < perPage) break;
  }
  return users;
}

function dateOnly(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function amountLabel(amountMinor: number, currency: "INR" | "USD", billingPeriod: string | null): string {
  const base = formatPriceMinor(amountMinor, currency);
  if (billingPeriod === "annual") return `${base} / yr`;
  if (billingPeriod === "monthly") return `${base} / mo`;
  return base;
}

export default async function AdminSubscribersPage() {
  const email = await readSessionEmail();
  if (!isAdminEmail(email, process.env)) notFound();

  const db = createServiceClient();
  const users = await listAllAuthUsers(db);
  const { subscribers, recentOrders, summary } = await loadAdminOverview(db, users);

  const monthlyValue = (["INR", "USD"] as const)
    .filter((c) => summary.monthlyPlanValueByCurrency[c] !== undefined)
    .map((c) => `${c} ${formatPriceMinor(summary.monthlyPlanValueByCurrency[c] ?? 0, c)}`)
    .join(" · ");

  return (
    <div className="space-y-8" data-testid="admin-panel">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Subscribers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every workspace with a subscription or a paid order. Platform-owner view — internal only.
        </p>
      </div>

      <div className="rounded-xl border border-border">
        <dl className="divide-y divide-border text-sm">
          <div className="flex items-baseline justify-between px-4 py-3">
            <dt className="text-muted-foreground">Customers (workspaces with a subscription or paid order)</dt>
            <dd className="font-semibold">{summary.totalCustomers}</dd>
          </div>
          <div className="flex items-baseline justify-between px-4 py-3">
            <dt className="text-muted-foreground">Active subscriptions</dt>
            <dd className="font-semibold">{summary.activeSubscriptions}</dd>
          </div>
          <div className="flex items-baseline justify-between px-4 py-3">
            <dt className="text-muted-foreground">Paid orders</dt>
            <dd className="font-semibold">{summary.paidOrders}</dd>
          </div>
          <div className="flex items-baseline justify-between px-4 py-3">
            <dt className="text-muted-foreground">
              Monthly plan value (active subscriptions — plan prices, not collected revenue)
            </dt>
            <dd className="font-semibold">{monthlyValue || "—"}</dd>
          </div>
        </dl>
      </div>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Customers</h2>
        {subscribers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left">
                  <th className="px-4 py-2 font-medium">Customer</th>
                  <th className="px-4 py-2 font-medium">Workspace</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Period ends</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Workspace created</th>
                </tr>
              </thead>
              <tbody>
                {subscribers.map((s) => (
                  <tr key={s.workspaceId} className="border-t border-border">
                    <td className="px-4 py-2">{s.ownerEmail ?? "—"}</td>
                    <td className="px-4 py-2">{s.workspaceName}</td>
                    <td className="px-4 py-2">{s.planName}</td>
                    <td className="px-4 py-2">{s.status}</td>
                    <td className="px-4 py-2">{amountLabel(s.amountMinor, s.currency, s.billingPeriod)}</td>
                    <td className="px-4 py-2">{dateOnly(s.currentPeriodEnd)}</td>
                    <td className="px-4 py-2">{s.provider ?? "—"}</td>
                    <td className="px-4 py-2">{dateOnly(s.workspaceCreatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Recent orders</h2>
        {recentOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Customer</th>
                  <th className="px-4 py-2 font-medium">Workspace</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((o) => (
                  <tr key={o.id} className="border-t border-border">
                    <td className="px-4 py-2">{dateOnly(o.createdAt)}</td>
                    <td className="px-4 py-2">{o.ownerEmail ?? "—"}</td>
                    <td className="px-4 py-2">{o.workspaceName}</td>
                    <td className="px-4 py-2">{o.planName}</td>
                    <td className="px-4 py-2">{formatPriceMinor(o.amountMinor, o.currency)}</td>
                    <td className="px-4 py-2">{o.status}</td>
                    <td className="px-4 py-2">{o.provider}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
