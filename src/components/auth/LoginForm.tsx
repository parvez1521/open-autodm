"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CircleNotch, SignIn } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";
import { LogoMark } from "@/components/ui/Logo";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

/**
 * Human copy for the auth_error values /auth/callback can forward
 * (functional audit fix, 2026-11-08): a failed confirmation, invite
 * or recovery link used to land here with no message at all.
 */
function humanAuthError(raw: string): string {
    const value = raw.trim();
    if (value === "access_denied") {
        return "That email link was cancelled or denied. Sign in below, or request a fresh link.";
    }
    if (/expired/i.test(value)) {
        return "That email link has expired. Sign in below, or request a fresh one with “Forgot password?” if it was a reset link.";
    }
    if (/not provisioned/i.test(value)) {
        return "This account is not provisioned for this instance. Ask the instance owner to add your login first.";
    }
    if (/invalid|already.*used|not found/i.test(value)) {
        return "That email link is invalid or was already used. Sign in below, or request a fresh link.";
    }
    // Callback messages are already user-facing Supabase sentences;
    // show them as-is (capped) rather than swallowing them.
    return value.length > 220 ? `${value.slice(0, 220)}…` : value;
}

/**
 * Sign-in only — in BOTH signup postures. When the owner opens public
 * signup (PUBLIC_SIGNUP_ENABLED, launch preparation 2026-11-07),
 * registration lives on /get-started (components/auth/SignupForm.tsx)
 * and the login page links to it; this form still never creates
 * users. Its footer copy is posture-aware via the signupOpen prop:
 * invite-only wording when signup is closed, an open-signup note when
 * it is not (the S-02 pin keeps the invite-only wording in source).
 *
 * Audit fix (2026-11-08): a "Forgot password?" affordance swaps the
 * card to ForgotPasswordForm (the resetPasswordForEmail call lives
 * in that file — this form's only auth call remains
 * signInWithPassword), and ?auth_error= values forwarded by
 * /auth/callback are surfaced as human messages instead of being
 * swallowed.
 */
export function LoginForm({ signupOpen = false }: { signupOpen?: boolean }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<"signin" | "forgot">("signin");

    // Surface a forwarded auth failure (audit fix): /auth/callback
    // redirects here with ?auth_error=… when a confirmation/invite
    // code exchange fails or the identity gate refuses the session.
    // Read once on mount (query or hash), show a human message, then
    // scrub the parameter so a refresh doesn't repeat it.
    useEffect(() => {
        const fromQuery = new URLSearchParams(window.location.search);
        const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const raw =
            fromQuery.get("auth_error") ??
            fromQuery.get("error_description") ??
            fromQuery.get("error") ??
            fromHash.get("error_description") ??
            fromHash.get("error");
        if (raw) {
            setError(humanAuthError(raw));
            window.history.replaceState({}, "", "/login");
        }
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        const supabase = createBrowserClient();

        try {
            const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
            if (signInError) {
                setError(signInError.message);
                return;
            }
            window.location.href = "/dashboard";
        } catch {
            setError("Something went wrong. Try again.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut", delay: 0.15 }}
            className="w-full max-w-sm bg-card border border-border rounded-xl overflow-hidden"
        >
            <div className="p-8">
                <div className="flex flex-col mb-7">
                    <LogoMark className="w-9 h-9 mb-5" />
                    {/* h2, not h1 (P27): the page's own h1 sits above
                        this card; the card heading stays an h2. */}
                    <h2 className="text-lg font-heading font-semibold tracking-tight text-foreground mb-1">
                        {mode === "forgot" ? "Reset your password" : "Welcome back"}
                    </h2>
                    <p className="text-[13px] text-muted-foreground">
                        {mode === "forgot"
                            ? "We will email you a link to choose a new one."
                            : "Sign in to your automation console."}
                    </p>
                </div>

                {mode === "forgot" ? (
                    <ForgotPasswordForm onBack={() => setMode("signin")} />
                ) : (
                <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col space-y-3">
                    {error && (
                        <p role="alert" className="text-[12.5px] text-destructive font-medium">
                            {error}
                        </p>
                    )}

                    <div>
                        <label htmlFor="login-email" className="micro-label block mb-1">Email</label>
                        <input
                            id="login-email"
                            type="email"
                            required
                            autoComplete="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@example.com"
                            className="w-full h-10 px-3 text-[13.5px] bg-background border border-border rounded-lg outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors"
                        />
                    </div>
                    <div>
                        <div className="flex items-baseline justify-between mb-1">
                            <label htmlFor="login-password" className="micro-label block">Password</label>
                            <button
                                type="button"
                                onClick={() => {
                                    setError(null);
                                    setMode("forgot");
                                }}
                                className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                            >
                                Forgot password?
                            </button>
                        </div>
                        <input
                            id="login-password"
                            type="password"
                            required
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••••••••"
                            className="w-full h-10 px-3 text-[13.5px] bg-background border border-border rounded-lg outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={isLoading}
                        className="flex items-center justify-center gap-2 w-full h-10 mt-1 text-[13.5px] font-semibold bg-foreground text-background rounded-lg hover:opacity-90 disabled:opacity-60 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                        {isLoading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <SignIn className="w-4 h-4" />}
                        {isLoading ? "Signing in…" : "Sign in"}
                    </button>
                </form>
                )}

                <div className="mt-6 pt-5 border-t border-border">
                    {signupOpen ? (
                        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                            No account? Sign-up is open — create one with the link below.
                        </p>
                    ) : (
                        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                            No account? Access is invite-only, the instance owner creates users in the
                            Supabase dashboard <span className="text-foreground/70 font-medium">(Authentication → Users → Add user)</span>.
                        </p>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
