"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { SPRING_SOFT } from "@/lib/motion/presets";
import { ArrowRight, CircleNotch, EnvelopeSimple } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";
import { LogoMark } from "@/components/ui/Logo";

/**
 * Self-service signup — the ONLY call site of supabase.auth.signUp in
 * this codebase (pinned by tests/signup-protection.test.ts, which
 * source-scans the whole tree for user-creation calls and exempts
 * exactly this file for exactly this one method).
 *
 * This component is rendered exclusively by
 * src/app/(saas)/get-started/page.tsx, and only when the owner has set
 * PUBLIC_SIGNUP_ENABLED=true. With the flag off (the default) that page
 * renders the invite-only state and this component never ships.
 *
 * Flow: signUp with emailRedirectTo pointing at /auth/callback. When
 * the Supabase project requires email confirmation, signUp returns no
 * session and the user confirms through the emailed link — the
 * callback route still runs the instance access gate
 * (src/lib/signupProtection.ts) before any session is minted. When
 * confirmation is off, a session comes back and we go straight to the
 * dashboard.
 */
export function SignupForm() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [checkEmail, setCheckEmail] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        const supabase = createBrowserClient();

        try {
            const { data, error: signUpError } = await supabase.auth.signUp({
                email,
                password,
                options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
            });
            if (signUpError) {
                setError(signUpError.message);
                return;
            }
            // With confirmation ON, an already-registered address comes
            // back as a user with no identities instead of an error —
            // say the honest thing rather than "check your email".
            if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                setError("This email already has an account. Sign in instead.");
                return;
            }
            if (data.session) {
                window.location.href = "/dashboard";
                return;
            }
            setCheckEmail(email);
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
            transition={{ ...SPRING_SOFT, delay: 0.1 }}
            className="w-full max-w-sm bg-card border border-border rounded-xl overflow-hidden"
        >
            <div className="p-8">
                <div className="flex flex-col mb-7">
                    <LogoMark className="w-9 h-9 mb-5" />
                    <h2 className="text-lg font-heading font-semibold tracking-tight text-foreground mb-1">
                        Create your account
                    </h2>
                    <p className="text-[13px] text-muted-foreground">
                        Your automation console and Creator Studio.
                    </p>
                </div>

                {checkEmail ? (
                    <div className="flex flex-col items-start gap-3">
                        <EnvelopeSimple className="w-6 h-6 text-foreground" />
                        <p className="text-[13.5px] leading-relaxed text-foreground">
                            Check your email to confirm your account.
                        </p>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            We sent a confirmation link to{" "}
                            <span className="text-foreground font-medium">{checkEmail}</span>. Open it
                            and you will land in your console, signed in.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                setCheckEmail(null);
                                setPassword("");
                            }}
                            className="mt-1 text-[13px] font-medium text-foreground underline underline-offset-4"
                        >
                            Use a different email
                        </button>
                    </div>
                ) : (
                    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col space-y-3">
                        {error && (
                            <p role="alert" className="text-[12.5px] text-destructive font-medium">
                                {error}
                            </p>
                        )}

                        <div>
                            <label htmlFor="signup-email" className="micro-label block mb-1">Email</label>
                            <input
                                id="signup-email"
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
                            <label htmlFor="signup-password" className="micro-label block mb-1">Password</label>
                            <input
                                id="signup-password"
                                type="password"
                                required
                                autoComplete="new-password"
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
                            {isLoading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                            {isLoading ? "Creating account…" : "Create account"}
                        </button>
                    </form>
                )}

                <div className="mt-6 pt-5 border-t border-border">
                    <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                        Already have an account?{" "}
                        <a href="/login" className="text-foreground/70 font-medium underline underline-offset-4">
                            Sign in
                        </a>
                        .
                    </p>
                </div>
            </div>
        </motion.div>
    );
}
