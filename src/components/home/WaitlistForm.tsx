"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle, CircleNotch } from "@/components/phosphor";

/**
 * Landing-page waitlist form. Posts to /api/waitlist, which is the
 * single write path into waitlist_entries (service role only — see
 * migration 20260730000034). States are honest: a duplicate address
 * says so, an error says the list did not respond.
 */
export function WaitlistForm() {
    const [email, setEmail] = useState("");
    const [state, setState] = useState<"idle" | "sending" | "joined" | "already" | "error">("idle");
    const [message, setMessage] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setState("sending");
        setMessage(null);
        try {
            const res = await fetch("/api/waitlist", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, source: "landing-final-cta" }),
            });
            const data = (await res.json().catch(() => null)) as
                | { ok?: boolean; alreadyOnList?: boolean; message?: string }
                | null;
            if (res.ok && data?.ok) {
                setState(data.alreadyOnList ? "already" : "joined");
                return;
            }
            setState("error");
            setMessage(data?.message ?? "The waitlist did not respond just now. Try again in a moment.");
        } catch {
            setState("error");
            setMessage("The waitlist did not respond just now. Try again in a moment.");
        }
    };

    if (state === "joined" || state === "already") {
        return (
            <p className="animate-caption-pop mt-5 flex items-center justify-center gap-2 text-[13.5px] font-medium text-foreground" role="status">
                <CheckCircle className="h-4.5 w-4.5 shrink-0" />
                {state === "joined"
                    ? "You are on the list. We will write to this address when a slot opens."
                    : "This email is already on the list. We will write when a slot opens."}
            </p>
        );
    }

    return (
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5">
            <div className="flex flex-col gap-2.5 sm:flex-row">
                <label htmlFor="waitlist-email" className="sr-only">
                    Email address
                </label>
                <input
                    id="waitlist-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="h-11 flex-1 rounded-lg border border-border bg-background px-3.5 text-[13.5px] text-foreground outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors"
                />
                <button
                    type="submit"
                    disabled={state === "sending"}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                    {state === "sending" ? (
                        <CircleNotch className="h-4 w-4 animate-spin" />
                    ) : (
                        <ArrowRight className="h-4 w-4" />
                    )}
                    {state === "sending" ? "Joining…" : "Join the waitlist"}
                </button>
            </div>
            {state === "error" && message && (
                <p role="alert" className="mt-2.5 text-[12.5px] font-medium text-destructive">
                    {message}
                </p>
            )}
        </form>
    );
}
