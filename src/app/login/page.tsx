import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { LoginForm } from "@/components/auth/LoginForm";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";

export const metadata: Metadata = {
    title: "Sign in — open-autoDM",
    description: "Sign in to your open-autoDM console.",
};

/**
 * Dedicated sign-in page. The landing page (/) explains the product;
 * this page is only for getting into the console. The form itself is
 * the shared LoginForm — sign-in only, accounts are invite-only.
 */
export default function LoginPage() {
    return (
        <div className="relative flex min-h-screen flex-col bg-background text-foreground">
            {/* Quiet dot grid, the console's own motif */}
            <div
                className="pointer-events-none fixed inset-0 opacity-[0.07] dark:opacity-[0.16]"
                style={{
                    backgroundImage:
                        "radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)",
                    backgroundSize: "32px 32px",
                }}
            />

            {/* Header */}
            <header className="relative z-10">
                <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6 lg:px-10">
                    <a href="/" className="flex items-center gap-3" aria-label="open-autoDM home">
                        <LogoMark className="h-8 w-8" />
                        <LogoWordmark className="text-[15px]" />
                    </a>
                    <a
                        href="/"
                        className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Back to home
                    </a>
                </div>
            </header>

            {/* Sign-in */}
            <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-14">
                <h1 className="text-center font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                    Sign in to open-autoDM
                </h1>
                <p className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                    Your automation console and Creator Studio, running on your own
                    instance.
                </p>

                <div className="mt-10 flex w-full justify-center">
                    <LoginForm />
                </div>
            </main>

            {/* Footer */}
            <footer className="relative z-10">
                <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-x-5 gap-y-2 px-6 py-8 text-[13px] text-muted-foreground lg:px-10">
                    <span>open-autoDM · MIT licensed · Self-hosted</span>
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
