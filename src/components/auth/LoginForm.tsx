"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { SPRING_SOFT } from "@/lib/motion/presets";
import { CircleNotch, SignIn } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";
import { LogoMark } from "@/components/ui/Logo";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { fetchPostAuthDestination } from "@/lib/billing/postAuthDestination";

/**
 * The Google "G" mark, drawn inline (owner directive, 2026-11-10:
 * no external image, no emoji). Standard four-colour paths.
 */
function GoogleMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
            <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.58v2.97h3.88c2.27-2.09 3.57-5.17 3.57-8.74z" />
            <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-2.97c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.07A11.99 11.99 0 0 0 12 24z" />
            <path fill="#FBBC05" d="M5.29 14.32A7.2 7.2 0 0 1 4.91 12c0-.81.14-1.59.38-2.32V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.07z" />
            <path fill="#EA4335" d="M12 4.73c1.76 0 3.34.61 4.58 1.8l3.44-3.44A11.99 11.99 0 0 0 1.28 6.61l4.01 3.07C6.23 6.84 8.88 4.73 12 4.73z" />
        </svg>
    );
}

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
        return "This account is not provisioned for open-autoDM. Ask an admin to add your login first.";
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
 * in that file), and ?auth_error= values forwarded by
 * /auth/callback are surfaced as human messages instead of being
 * swallowed.
 *
 * Entry flow (owner directive, 2026-11-10, Task F): the form also
 * offers "Continue with Google" (signInWithOAuth → /auth/callback,
 * which runs the same identity gate + post-auth routing as email
 * links). After ANY successful sign-in the browser does not guess
 * the landing page: it asks GET /api/billing/plan-choice via
 * fetchPostAuthDestination — the plan picker for a customer who
 * has never chosen a plan, the dashboard otherwise.
 */
export function LoginForm({ signupOpen = false }: { signupOpen?: boolean }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [googleLoading, setGoogleLoading] = useState(false);
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
            // Post-auth routing (2026-11-10): plan picker for a
            // customer who still owes the choice, dashboard
            // otherwise — resolved server-side, fail-open.
            window.location.href = await fetchPostAuthDestination();
        } catch {
            setError("Something went wrong. Try again.");
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Google sign-in (owner directive, 2026-11-10): OAuth through
     * Supabase, returning to /auth/callback — the same session
     * gate + post-auth routing as email links. If the Google
     * provider is not enabled in Supabase yet, the error comes
     * back as a normal form error (either directly here or via
     * the callback's ?auth_error= surfacing above); we never fake
     * a success.
     */
    const handleGoogle = async () => {
        setGoogleLoading(true);
        setError(null);
        const supabase = createBrowserClient();
        try {
            const { error: oauthError } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: { redirectTo: `${window.location.origin}/auth/callback` },
            });
            if (oauthError) {
                setError(oauthError.message);
                setGoogleLoading(false);
            }
            // On success the browser navigates away to Google.
        } catch {
            setError("Something went wrong. Try again.");
            setGoogleLoading(false);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...SPRING_SOFT, delay: 0.1 }}
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
                <>
                <button
                    type="button"
                    onClick={() => void handleGoogle()}
                    disabled={googleLoading || isLoading}
                    className="flex items-center justify-center gap-2.5 w-full h-10 text-[13.5px] font-medium bg-background border border-border rounded-lg hover:bg-muted disabled:opacity-60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                    {googleLoading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <GoogleMark className="w-4 h-4" />}
                    Continue with Google
                </button>

                <div className="flex items-center gap-3 my-4" aria-hidden="true">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">or</span>
                    <span className="h-px flex-1 bg-border" />
                </div>

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
                </>
                )}

                <div className="mt-6 pt-5 border-t border-border">
                    {signupOpen ? (
                        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                            No account? Sign-up is open — create one with the link below.
                        </p>
                    ) : (
                        <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                            No account? Access is invite-only — an admin creates users in the
                            Supabase dashboard <span className="text-foreground/70 font-medium">(Authentication → Users → Add user)</span>.
                        </p>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
