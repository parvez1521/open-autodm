import Link from "next/link";
import { SaasNavAccount } from "@/components/saas/SaasNavAccount";
import { PageTransition, ScrollProgress } from "@/components/motion/primitives";

/**
 * SaaS shell for the public pages (pricing / billing / onboarding /
 * get-started) served on opendm.in. This route group began as the
 * Phase 13 productization prototype; since the 2026-11-08 domain
 * move it IS the live product surface, so the old prototype banner
 * badge was removed (2026-11-09 cleanup). The capabilities behind
 * it stay flag-gated exactly as before.
 *
 * QA fix (2026-11-08): the last nav slot is session-aware
 * (SaasNavAccount) — signed-out visitors see the exact "Get started"
 * link this header always rendered; a signed-in user sees their
 * email and an "Open app" entry instead.
 */
export default function SaasPrototypeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <ScrollProgress />
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold">
            open-autoDM
          </span>
          <nav className="flex gap-4 text-[13px] text-muted-foreground">
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
            <SaasNavAccount />
            <Link href="/onboarding" className="hover:text-foreground">Onboarding</Link>
            <Link href="/billing" className="hover:text-foreground">Billing</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <PageTransition>{children}</PageTransition>
      </main>
    </div>
  );
}
