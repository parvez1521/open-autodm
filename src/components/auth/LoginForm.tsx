"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { CircleNotch, SignIn } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";
import { LogoMark } from "@/components/ui/Logo";

/**
 * Sign-in only — in BOTH signup postures. When the owner opens public
 * signup (PUBLIC_SIGNUP_ENABLED, launch preparation 2026-11-07),
 * registration lives on /get-started (components/auth/SignupForm.tsx)
 * and the login page links to it; this form still never creates
 * users. Its footer copy is posture-aware via the signupOpen prop:
 * invite-only wording when signup is closed, an open-signup note when
 * it is not (the S-02 pin keeps the invite-only wording in source).
 */
export function LoginForm({ signupOpen = false }: { signupOpen?: boolean }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
                        Welcome back
                    </h2>
                    <p className="text-[13px] text-muted-foreground">
                        Sign in to your automation console.
                    </p>
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
                        <label htmlFor="login-password" className="micro-label block mb-1">Password</label>
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
