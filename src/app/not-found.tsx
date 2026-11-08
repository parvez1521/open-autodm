import Link from "next/link";
import { LogoMark } from "@/components/ui/Logo";

/**
 * Branded 404 (functional audit fix, 2026-11-08) — before this,
 * unknown URLs fell back to the unbranded Next.js default with no
 * route back into the product.
 */
export default function NotFound() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-16 text-foreground">
            <LogoMark className="h-10 w-10" />
            <p className="micro-label mt-8">404</p>
            <h1 className="mt-3 text-center font-heading text-2xl font-semibold tracking-tight lg:text-3xl">
                This page doesn&apos;t exist
            </h1>
            <p className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                The link may be old, or the address may have a typo. Nothing is broken —
                the page just isn&apos;t here.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Link
                    href="/dashboard"
                    className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-[13.5px] font-semibold text-background transition-opacity hover:opacity-90"
                >
                    Go to your console
                </Link>
                <Link
                    href="/"
                    className="inline-flex h-10 items-center rounded-lg border border-border px-4 text-[13.5px] font-medium transition-colors hover:bg-muted"
                >
                    Back to home
                </Link>
            </div>
        </div>
    );
}
