import type { Metadata } from "next";
import { ArrowLeft } from "@/components/phosphor";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { FadeIn } from "@/components/motion/primitives";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";

export const metadata: Metadata = {
    // Bare segment — the root template renders the full title.
    title: "Reset password",
    description: "Choose a new password for your open-autoDM console.",
    // Utility page: out of the index (SEO plan P0-5).
    robots: { index: false },
};

/**
 * Password-recovery landing (functional audit fix, 2026-11-08).
 * The recovery email's link points here (see ForgotPasswordForm);
 * the page chrome mirrors /login, the form itself handles the code
 * exchange and the updateUser completion. This route must be in the
 * Supabase project's Auth redirect allow-list for the deployment's
 * origin, or the emailed link will not land here.
 */
export default function ResetPasswordPage() {
    return (
        <div className="relative flex min-h-screen flex-col bg-background text-foreground">
            {/* Header */}
            <header className="relative z-10">
                <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6 lg:px-10">
                    <a href="/" className="flex items-center gap-3" aria-label="open-autoDM home">
                        <LogoMark className="h-8 w-8" />
                        <LogoWordmark className="text-[15px]" />
                    </a>
                    <a
                        href="/login"
                        className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Back to sign in
                    </a>
                </div>
            </header>

            <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-14">
                <FadeIn className="flex flex-col items-center">
                <h1 className="text-center font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                    Reset your password
                </h1>
                <p className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                    Choose a new password for your automation console.
                </p>
                </FadeIn>

                <FadeIn className="mt-10 w-full max-w-sm bg-card border border-border rounded-xl p-8" delay={0.1}>
                    <ResetPasswordForm />
                </FadeIn>
            </main>

            {/* Footer */}
            <footer className="relative z-10">
                <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-x-5 gap-y-2 px-6 py-8 text-[13px] text-muted-foreground lg:px-10">
                    <span>open-autoDM</span>
                    <a href="/privacy-policy" className="transition-colors hover:text-foreground">
                        Privacy Policy
                    </a>
                    <a href="/terms" className="transition-colors hover:text-foreground">
                        Terms
                    </a>
                </div>
            </footer>
        </div>
    );
}
