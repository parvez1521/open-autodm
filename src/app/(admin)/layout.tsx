import type { Metadata } from "next";
import Link from "next/link";

/** The platform-admin surface is never indexed (SEO pass, 2026-11-10). */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Platform-admin shell. /admin is the REAL owner panel (subscribers
 * over the live billing tables, gated server-side by the
 * ADMIN_EMAILS allowlist — see src/lib/admin/panel.ts); the other
 * pages in this group (subscriptions, payment-events, overrides)
 * remain Phase 14 prototypes over synthetic data, gated by the
 * platform-admin stub in src/lib/admin/guard.ts, and label
 * themselves as prototypes in their own headings.
 */
export default function AdminPrototypeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold">
            open-autoDM{" "}
            <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
              PLATFORM ADMIN
            </span>
          </span>
          <nav className="flex gap-4 text-[13px] text-muted-foreground">
            <Link href="/admin" className="hover:text-foreground">Subscribers</Link>
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
