"use client";

import { useEffect } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/ui/Logo";

/**
 * Route-level error boundary (functional audit fix, 2026-11-08) —
 * a render/runtime failure in a page segment lands here with a
 * branded recovery path instead of the framework default.
 */
export default function ErrorPage({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        // Keep the failure visible in the console for self-hosters;
        // nothing is sent anywhere.
        console.error(error);
    }, [error]);

    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-foreground">
            <LogoMark className="h-10 w-10" />
            <p className="micro-label mt-8">Something went wrong</p>
            <h1 className="mt-3 text-center font-heading text-2xl font-semibold tracking-tight">
                This page hit an error
            </h1>
            <p className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                Your automations and data are unaffected — this is a display problem on
                this page only. Try again, or head back to the console.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <button
                    type="button"
                    onClick={() => reset()}
                    className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-[13.5px] font-semibold text-background transition-opacity hover:opacity-90"
                >
                    Try again
                </button>
                <Link
                    href="/dashboard"
                    className="inline-flex h-10 items-center rounded-lg border border-border px-4 text-[13.5px] font-medium transition-colors hover:bg-muted"
                >
                    Go to your console
                </Link>
            </div>
        </div>
    );
}
