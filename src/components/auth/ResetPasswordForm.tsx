"use client";

import { useEffect, useState } from "react";
import { CheckCircle, CircleNotch, Lock, XCircle } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";

/**
 * Reset-password — the completion half of the recovery flow
 * (functional audit fix, 2026-11-08). The emailed link lands here
 * with a PKCE `?code=`; the code is exchanged for a (recovery)
 * session and the new password is set via updateUser. The code can
 * only have been emailed to an address that already has an account,
 * so this page never provisions identities — it is not a signup
 * path. If the link is missing/expired/already used, the page says
 * so plainly and points back at /login instead of failing silently.
 */
export function ResetPasswordForm() {
    const [phase, setPhase] = useState<"checking" | "ready" | "invalid" | "done">("checking");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const prepare = async () => {
            const supabase = createBrowserClient();
            const params = new URLSearchParams(window.location.search);
            const code = params.get("code");
            if (code) {
                const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
                if (cancelled) return;
                if (exchangeError) {
                    setPhase("invalid");
                    return;
                }
                // Scrub the one-time code from the address bar.
                window.history.replaceState({}, "", "/reset-password");
                setPhase("ready");
                return;
            }
            // No code: a session may already exist (e.g. the exchange
            // happened in a prior visit in this tab).
            const { data } = await supabase.auth.getSession();
            if (cancelled) return;
            setPhase(data.session ? "ready" : "invalid");
        };
        void prepare();
        return () => {
            cancelled = true;
        };
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (password.length < 8) {
            setError("Use at least 8 characters.");
            return;
        }
        if (password !== confirm) {
            setError("The two passwords don't match.");
            return;
        }
        setIsLoading(true);
        const supabase = createBrowserClient();
        try {
            const { error: updateError } = await supabase.auth.updateUser({ password });
            if (updateError) {
                setError(updateError.message);
                return;
            }
            setPhase("done");
        } catch {
            setError("Something went wrong. Try again.");
        } finally {
            setIsLoading(false);
        }
    };

    if (phase === "checking") {
        return (
            <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
                <CircleNotch className="w-4 h-4 animate-spin" />
                Checking your reset link…
            </div>
        );
    }

    if (phase === "invalid") {
        return (
            <div className="flex flex-col items-start gap-3">
                <XCircle className="w-6 h-6 text-destructive" />
                <p className="text-[13.5px] leading-relaxed text-foreground">
                    This reset link is invalid or has expired.
                </p>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Reset links work once and expire quickly. Request a fresh one from the
                    sign-in page — use the “Forgot password?” link there.
                </p>
                <a
                    href="/login"
                    className="mt-1 text-[13px] font-medium text-foreground underline underline-offset-4"
                >
                    Go to sign in
                </a>
            </div>
        );
    }

    if (phase === "done") {
        return (
            <div className="flex flex-col items-start gap-3">
                <CheckCircle className="w-6 h-6 text-secondary" />
                <p className="text-[13.5px] leading-relaxed text-foreground">
                    Your password has been updated.
                </p>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                    You are signed in with the recovery session. Head to your console, or
                    sign in again anywhere else with the new password.
                </p>
                <a
                    href="/dashboard"
                    className="mt-1 inline-flex items-center justify-center h-10 px-4 text-[13.5px] font-semibold bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity"
                >
                    Go to your console
                </a>
            </div>
        );
    }

    return (
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col space-y-3">
            {error && (
                <p role="alert" className="text-[12.5px] text-destructive font-medium">
                    {error}
                </p>
            )}

            <div>
                <label htmlFor="reset-password-new" className="micro-label block mb-1">New password</label>
                <input
                    id="reset-password-new"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full h-10 px-3 text-[13.5px] bg-background border border-border rounded-lg outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors"
                />
            </div>
            <div>
                <label htmlFor="reset-password-confirm" className="micro-label block mb-1">Confirm new password</label>
                <input
                    id="reset-password-confirm"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full h-10 px-3 text-[13.5px] bg-background border border-border rounded-lg outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors"
                />
            </div>

            <button
                type="submit"
                disabled={isLoading}
                className="flex items-center justify-center gap-2 w-full h-10 mt-1 text-[13.5px] font-semibold bg-foreground text-background rounded-lg hover:opacity-90 disabled:opacity-60 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
                {isLoading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                {isLoading ? "Updating…" : "Set new password"}
            </button>
        </form>
    );
}
