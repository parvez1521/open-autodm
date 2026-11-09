"use client";

/**
 * Standalone /forgot-password surface (2026-11-09): the route used
 * to 404 — password recovery existed only as the /login card's
 * "Forgot password?" toggle. This panel renders the SAME
 * ForgotPasswordForm (the tree's only resetPasswordForEmail call)
 * inside the same card chrome the login card uses, so links to
 * /forgot-password land somewhere real. "Back" returns to /login.
 */

import { useRouter } from "next/navigation";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { LogoMark } from "@/components/ui/Logo";

export function ForgotPasswordPanel() {
    const router = useRouter();
    return (
        <div className="w-full max-w-sm bg-card border border-border rounded-xl overflow-hidden">
            <div className="p-8">
                <div className="flex flex-col mb-7">
                    <LogoMark className="w-9 h-9 mb-5" />
                    <h1 className="text-lg font-heading font-semibold tracking-tight text-foreground mb-1">
                        Reset your password
                    </h1>
                    <p className="text-[13px] text-muted-foreground">
                        We will email you a link to choose a new one.
                    </p>
                </div>
                <ForgotPasswordForm onBack={() => router.push("/login")} />
            </div>
        </div>
    );
}
