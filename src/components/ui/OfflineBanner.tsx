"use client";

import { useEffect, useState } from "react";
import { ArrowClockwise, Warning } from "@/components/phosphor";

/**
 * Offline banner (production-pages audit, 2026-11-23).
 *
 * The console needs the internet to load and save anything, and
 * before this there was no online/offline detection at all — a
 * dropped connection failed silently. This banner listens to the
 * browser's online/offline events and shows only while offline,
 * with a Retry action that reloads the page. It renders nothing
 * while online (and nothing on the first server render — the
 * online state is only read after mount, so there is no hydration
 * mismatch). There is deliberately no offline queue: the app has
 * none, and this banner does not pretend otherwise.
 */
export function OfflineBanner() {
    const [isOffline, setIsOffline] = useState(false);

    useEffect(() => {
        const update = () => setIsOffline(!window.navigator.onLine);
        update();
        window.addEventListener("online", update);
        window.addEventListener("offline", update);
        return () => {
            window.removeEventListener("online", update);
            window.removeEventListener("offline", update);
        };
    }, []);

    if (!isOffline) return null;

    return (
        <div
            role="status"
            className="relative z-50 flex items-center justify-center gap-3 border-b border-border bg-card px-4 py-2.5 text-[13px] text-foreground"
        >
            <Warning className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
                You&apos;re offline. The console needs a connection to load and save — check yours and try again.
            </span>
            <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] font-medium transition-colors hover:bg-muted"
            >
                <ArrowClockwise className="h-3.5 w-3.5" aria-hidden="true" />
                Retry
            </button>
        </div>
    );
}
