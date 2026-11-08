"use client";

import "./globals.css";

/**
 * Root-level error boundary (functional audit fix, 2026-11-08).
 * Renders only if the root layout itself fails, so it must carry
 * its own <html>/<body> and import the design tokens itself. Kept
 * deliberately plain — flat surfaces, the product's own fonts via
 * globals.css, no imagery — so it still reads as open-autoDM with
 * nothing else loaded.
 */
export default function GlobalError({
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <html lang="en">
            <body className="bg-background text-foreground antialiased">
                <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
                    <p className="micro-label">Something went wrong</p>
                    <h1 className="mt-3 text-center font-heading text-2xl font-semibold tracking-tight">
                        open-autoDM hit an error
                    </h1>
                    <p className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                        The console failed to load. Your automations and data are
                        unaffected. Reload to try again.
                    </p>
                    <button
                        type="button"
                        onClick={() => reset()}
                        className="mt-8 inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-[13.5px] font-semibold text-background transition-opacity hover:opacity-90"
                    >
                        Reload
                    </button>
                </div>
            </body>
        </html>
    );
}
