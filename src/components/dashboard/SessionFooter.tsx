"use client";

/**
 * Session footer for the app shell (functional audit fix,
 * 2026-11-08): the signed-in email, in-app support + legal links,
 * and — most importantly — a sign-out that lives in the shell
 * itself, not buried in Settings. The email arrives server-side
 * from the (main) layout's getUser(); this component only renders
 * and signs out. Rendered under the account switcher in both the
 * desktop sidebar and the mobile drawer.
 */

import { useState } from "react";
import Link from "next/link";
import { CircleNotch, SignOut } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";

export const SUPPORT_EMAIL = "work.techhacksai@gmail.com";

export function SessionFooter({
    email,
    collapsed = false,
    onNavigate,
}: {
    email: string | null;
    collapsed?: boolean;
    onNavigate?: () => void;
}) {
    const [signingOut, setSigningOut] = useState(false);

    const handleSignOut = async () => {
        setSigningOut(true);
        const supabase = createBrowserClient();
        await supabase.auth.signOut();
        window.location.href = "/login";
    };

    if (collapsed) {
        return (
            <div className="flex justify-center pt-2.5">
                <button
                    onClick={() => void handleSignOut()}
                    disabled={signingOut}
                    title={email ? `Sign out (${email})` : "Sign out"}
                    aria-label="Sign out"
                    className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-muted/60 disabled:opacity-60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                    {signingOut ? <CircleNotch className="w-4 h-4 animate-spin" /> : <SignOut className="w-4 h-4" />}
                </button>
            </div>
        );
    }

    return (
        <div className="pt-2.5 px-1">
            {email && (
                <p className="px-2 text-[11px] text-muted-foreground truncate" title={email}>
                    Signed in as <span className="text-foreground/80 font-medium">{email}</span>
                </p>
            )}
            <div className="mt-1 flex items-center gap-1 px-2 text-[11px] text-muted-foreground">
                <a
                    href={`mailto:${SUPPORT_EMAIL}`}
                    className="hover:text-foreground transition-colors"
                    onClick={onNavigate}
                >
                    Support
                </a>
                <span aria-hidden="true">·</span>
                <Link href="/privacy-policy" className="hover:text-foreground transition-colors" onClick={onNavigate}>
                    Privacy
                </Link>
                <span aria-hidden="true">·</span>
                <Link href="/terms" className="hover:text-foreground transition-colors" onClick={onNavigate}>
                    Terms
                </Link>
            </div>
            <button
                onClick={() => void handleSignOut()}
                disabled={signingOut}
                className={cn(
                    "mt-1.5 w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12.5px] font-medium",
                    "text-muted-foreground hover:text-destructive hover:bg-muted/60 disabled:opacity-60 transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                )}
            >
                {signingOut ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <SignOut className="w-3.5 h-3.5" />}
                {signingOut ? "Signing out…" : "Sign out"}
            </button>
        </div>
    );
}
