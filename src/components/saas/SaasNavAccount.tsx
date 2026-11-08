"use client";

/**
 * Session-aware account slot for the (saas) prototype shell nav
 * (QA fix, 2026-11-08).
 *
 * The shell's header used to render the same signed-out links for
 * everyone: a signed-in user on /pricing or /billing still saw
 * "Get started" and no sign of their session. This slot keeps the
 * signed-out rendering BYTE-IDENTICAL to the old static link
 * (initial render and no-session resolution render exactly the
 * previous <Link>), and swaps in the signed-in affordance only
 * after a session is confirmed client-side — the same probe
 * discipline the pricing page uses for its plan actions, so the
 * static prerender of the (saas) pages is untouched.
 *
 * Identity comes from auth.getUser() (verified with the Auth
 * server), never from a local token decode — the same rule the
 * Settings Session section follows.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { createBrowserClient } from "@/lib/supabase";

export function SaasNavAccount() {
    const [email, setEmail] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const supabase = createBrowserClient();
        void supabase.auth
            .getUser()
            .then(({ data }) => {
                if (!cancelled) setEmail(data.user?.email ?? null);
            })
            .catch(() => {
                /* probe failed: keep the signed-out rendering */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!email) {
        return (
            <Link href="/get-started" className="hover:text-foreground">
                Get started
            </Link>
        );
    }

    return (
        <>
            <span className="hidden max-w-[180px] truncate sm:inline" title={email}>
                {email}
            </span>
            <Link href="/dashboard" className="font-medium text-foreground hover:text-foreground">
                Open app
            </Link>
        </>
    );
}
