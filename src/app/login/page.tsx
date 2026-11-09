import type { Metadata } from "next";
import { ArrowLeft, FilmStrip, Lightning, Timer } from "@/components/phosphor";
import { LoginForm } from "@/components/auth/LoginForm";
import { FadeIn } from "@/components/motion/primitives";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";
import { readSaasFlags } from "@/lib/billing/flags";

export const metadata: Metadata = {
    title: "Sign in | open-autoDM",
    description: "Sign in to your open-autoDM console.",
};

/**
 * Dedicated sign-in page. The landing page (/) explains the product;
 * this page is only for getting into the console. The form itself is
 * the shared LoginForm — sign-in only. When the owner has enabled
 * PUBLIC_SIGNUP_ENABLED, a create-account entry appears under the
 * form and points at the flag-gated /get-started page; with the flag
 * off (default) the page is exactly the invite-only sign-in.
 */
export default function LoginPage() {
    const signupEnabled = readSaasFlags(process.env).publicSignupEnabled;
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
                        href="/"
                        className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Back to home
                    </a>
                </div>
            </header>

            {/* Sign-in: on large screens a split layout — an ink panel
                carrying the product facts beside the form column. The
                form column's content is unchanged. */}
            <main className="relative z-10 grid flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                <aside className="relative hidden flex-col justify-between bg-foreground px-10 py-12 text-background lg:flex xl:px-14">
                    <FadeIn x={-24} y={0}>
                    <div>
                        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-background/60">
                            The console
                        </p>
                        <h2 className="mt-5 font-heading text-3xl font-semibold leading-tight tracking-tight">
                            Every comment answered. Every DM on time.
                        </h2>
                        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-background/70">
                            Comment-to-DM automation that runs on your own Meta app,
                            with the Creator Studio that makes the next video.
                        </p>
                    </div>
                    </FadeIn>
                    <FadeIn x={-24} y={0} delay={0.14}>
                    <ul className="space-y-3.5 text-sm text-background/85">
                        <li className="flex items-center gap-3">
                            <Lightning className="h-4 w-4 shrink-0" />
                            Automation on your own Meta app — exactly three permissions
                        </li>
                        <li className="flex items-center gap-3">
                            <FilmStrip className="h-4 w-4 shrink-0" />
                            Creator Studio — ten tools that run in your browser
                        </li>
                        <li className="flex items-center gap-3">
                            <Timer className="h-4 w-4 shrink-0" />
                            Hard caps built in — 180 DMs/hour, 24-hour window
                        </li>
                    </ul>
                    </FadeIn>
                </aside>

                <div className="flex flex-col items-center justify-center px-6 py-14">
                    <FadeIn className="flex flex-col items-center">
                    <h1 className="text-center font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                        Sign in to open-autoDM
                    </h1>
                    <p className="mt-3 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
                        Your automation console and Creator Studio, in one place.
                    </p>
                    </FadeIn>

                    <FadeIn className="mt-10 flex w-full justify-center" delay={0.1}>
                        <LoginForm signupOpen={signupEnabled} />
                    </FadeIn>

                    {signupEnabled && (
                        <FadeIn delay={0.18}>
                        <p className="mt-6 text-center text-[13px] text-muted-foreground">
                            New to open-autoDM?{" "}
                            <a
                                href="/get-started"
                                className="font-medium text-foreground underline underline-offset-4"
                            >
                                Create an account
                            </a>
                        </p>
                        </FadeIn>
                    )}
                </div>
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
