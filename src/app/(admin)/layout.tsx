import Link from "next/link";

/**
 * Phase 14 — ISOLATED platform-admin prototype shell. Separate route
 * group from both the live product and the (saas) customer prototype.
 * Every page in this group is gated server-side by the platform-admin
 * stub in src/lib/admin/guard.ts and renders access-denied by default.
 */
export default function AdminPrototypeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold">
            open-autoDM{" "}
            <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
              PLATFORM ADMIN PROTOTYPE — mock data only
            </span>
          </span>
          <nav className="flex gap-4 text-[13px] text-muted-foreground">
            <Link href="/admin" className="hover:text-foreground">Customers</Link>
            <Link href="/admin/subscriptions" className="hover:text-foreground">Subscriptions</Link>
            <Link href="/admin/payment-events" className="hover:text-foreground">Payment events</Link>
            <Link href="/admin/overrides" className="hover:text-foreground">Overrides</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
