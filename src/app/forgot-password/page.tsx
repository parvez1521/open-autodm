import type { Metadata } from "next";
import { ForgotPasswordPanel } from "@/components/auth/ForgotPasswordPanel";

export const metadata: Metadata = {
    // Bare segment — the root template renders the full title.
    title: "Reset your password",
    description: "Request a password reset link for your open-autoDM account.",
    // Utility page: out of the index (SEO plan P0-5).
    robots: { index: false },
};

/**
 * /forgot-password (2026-11-09): previously a 404 — recovery lived
 * only behind the /login card's toggle. This page renders the same
 * reset-request form (components/auth/ForgotPasswordPanel →
 * ForgotPasswordForm); the emailed link still lands on
 * /reset-password to complete the flow.
 */
export default function ForgotPasswordPage() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-14 text-foreground">
            <ForgotPasswordPanel />
        </div>
    );
}
