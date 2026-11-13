"use client";

import { useState } from "react";
import { CheckCircle, CircleNotch } from "@/components/phosphor";
import { createBrowserClient } from "@/lib/supabase";

/**
 * Change password for the signed-in user (functional audit fix,
 * 2026-11-08) — rendered inside Settings. updateUser under the
 * current session; no current-password re-entry (the session itself
 * is the proof, matching Supabase's model). The tree's only
 * settings-side updateUser call site.
 */
export function ChangePasswordForm() {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setDone(false);
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
            setPassword("");
            setConfirm("");
            setDone(true);
        } catch {
            setError("Something went wrong. Try again.");
        } finally {
            setIsLoading(false);
        }
    };

    const inputCls =
        "w-full h-9 px-3 text-[13px] bg-background border border-border rounded-lg outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors";

    return (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
                <div>
                    <label htmlFor="change-password-new" className="micro-label block mb-1">New password</label>
                    <input
                        id="change-password-new"
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••••••"
                        className={inputCls}
                    />
                </div>
                <div>
                    <label htmlFor="change-password-confirm" className="micro-label block mb-1">Confirm new password</label>
                    <input
                        id="change-password-confirm"
                        type="password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="••••••••••••"
                        className={inputCls}
                    />
                </div>
            </div>

            {error && (
                <p role="alert" className="text-[12.5px] text-destructive font-medium">
                    {error}
                </p>
            )}
            {done && (
                <p className="flex items-center gap-1.5 text-[12.5px] text-secondary font-medium">
                    <CheckCircle className="w-3.5 h-3.5" />
                    Password updated. Use it the next time you sign in.
                </p>
            )}

            <button
                type="submit"
                disabled={isLoading || !password || !confirm}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-foreground text-background text-[13px] font-semibold hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
                {isLoading ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : null}
                {isLoading ? "Updating…" : "Update password"}
            </button>
        </form>
    );
}
