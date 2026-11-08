"use client";

import { useState } from "react";
import { ArrowLeft, CircleNotch, EnvelopeSimple } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";

/**
 * Forgot-password — the request half of the owner-approved recovery
 * flow (functional audit fix, 2026-11-08). Lives in its own file so
 * LoginForm stays a sign-in-only call site: this is the tree's only
 * resetPasswordForEmail call. The method cannot create or provision
 * an account — Supabase only emails a recovery link to an address
 * that already has one — and the link lands on /reset-password,
 * which completes the reset via updateUser under the recovery
 * session the code exchange mints there.
 *
 * The redirect target is this deployment's own origin (same pattern
 * as SignupForm's /auth/callback): the Supabase project's Auth
 * redirect allow-list must contain <origin>/reset-password for the
 * emailed link to land here.
 */
export function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
    const [email, setEmail] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        const supabase = createBrowserClient();

        try {
            const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
                redirectTo: `${window.location.origin}/reset-password`,
            });
            if (resetError) {
                setError(resetError.message);
                return;
            }
            setSentTo(email);
        } catch {
            setError("Something went wrong. Try again.");
        } finally {
            setIsLoading(false);
        }
    };

    if (sentTo) {
        return (
            <div className="flex flex-col items-start gap-3">
                <EnvelopeSimple className="w-6 h-6 text-foreground" />
                <p className="text-[13.5px] leading-relaxed text-foreground">
                    Check your email to reset your password.
                </p>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                    If an account exists for{" "}
                    <span className="text-foreground font-medium">{sentTo}</span>, we sent it a
                    reset link. Open it and you can choose a new password.
                </p>
                <button
                    type="button"
                    onClick={onBack}
                    className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground underline underline-offset-4"
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back to sign in
                </button>
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
                <label htmlFor="forgot-email" className="micro-label block mb-1">Email</label>
                <input
                    id="forgot-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full h-10 px-3 text-[13.5px] bg-background border border-border rounded-lg outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors"
                />
            </div>

            <button
                type="submit"
                disabled={isLoading}
                className="flex items-center justify-center gap-2 w-full h-10 mt-1 text-[13.5px] font-semibold bg-foreground text-background rounded-lg hover:opacity-90 disabled:opacity-60 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
                {isLoading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <EnvelopeSimple className="w-4 h-4" />}
                {isLoading ? "Sending link…" : "Send reset link"}
            </button>

            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center justify-center gap-1.5 h-8 text-[12.5px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to sign in
            </button>
        </form>
    );
}
