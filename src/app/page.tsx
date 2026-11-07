"use client";

import {
    ArrowRight,
    BarChart3,
    Clock3,
    MessagesSquare,
    PenLine,
    Timer,
    UserCheck,
    Webhook,
    Zap,
} from "lucide-react";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";
import { NodeEditor } from "@/components/ui/NodeEditor";
import { LoginForm } from "@/components/auth/LoginForm";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ScrollMorph } from "@/components/ui/ScrollMorph";
import { PipelineShowcase } from "@/components/home/PipelineShowcase";
import { ScriptSampleShowcase } from "@/components/home/ScriptSampleShowcase";

const FEATURES = [
    {
        icon: MessagesSquare,
        title: "Comment to DM",
        body: "A keyword in a post or Reel comment triggers a Private Reply with your link, PDF, or offer. Instagram allows one within 7 days of the comment, and the engine checks before it sends.",
    },
    {
        icon: Zap,
        title: "DM and story replies",
        body: "Keyword replies inside DMs and story mentions, plus an away mode that answers while you are offline, in the same conversation thread.",
    },
    {
        icon: BarChart3,
        title: "Analytics and live debug",
        body: "A comment-to-DM funnel, your top automations, and a debug stream that shows every webhook as it is verified, matched, queued, and sent.",
    },
    {
        icon: PenLine,
        title: "Viral Script Writer",
        note: "New",
        body: "Writes the Reel before the automation exists: three hook options, a timestamped script paced for speaking, caption and hashtags. It ends on your comment keyword, so the script and the automation use the same word.",
        href: "#script-writer",
        linkLabel: "See an example",
    },
] as const;

const SAFETY = [
    { icon: Timer, label: "180 DMs per hour, hard cap" },
    { icon: Clock3, label: "24-hour window checked before every send" },
    { icon: UserCheck, label: "One DM per person, per automation, per day" },
    { icon: Webhook, label: "Webhooks verified with HMAC-SHA256" },
] as const;

export default function LandingPage() {
    return (
        <div className="relative min-h-screen bg-background text-foreground overflow-x-clip">
            <ScrollMorph />

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
            <header className="relative z-10 border-b border-border">
                <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
                    <div className="flex items-center gap-3">
                        <LogoMark className="h-8 w-8" />
                        <LogoWordmark className="text-[15px]" />
                    </div>
                    <div className="flex items-center gap-2">
                        <a
                            href="https://github.com/parvez1521/open-autodm"
                            target="_blank"
                            rel="noreferrer"
                            className="hidden h-9 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
                        >
                            GitHub
                        </a>
                        <ThemeToggle />
                    </div>
                </div>
            </header>

            <main className="relative z-10">
                {/* ── Hero ─────────────────────────────────────────── */}
                <section className="mx-auto max-w-7xl px-6 pb-20 pt-14 lg:px-10 lg:pb-28 lg:pt-20">
                    <div className="grid items-start gap-14 lg:grid-cols-[1.15fr_1fr] lg:gap-10">
                        <div>
                            <h1 className="font-heading text-[40px] font-semibold leading-[1.08] tracking-tight text-foreground sm:text-5xl lg:text-[56px]">
                                Turn comments into customers on autopilot
                            </h1>
                            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground lg:text-lg lg:leading-relaxed">
                                open-autoDM is open-source, self-hosted Instagram automation
                                software. It runs on your own Meta app, database, and domain —
                                no per-seat pricing, and no third party holding your tokens.
                            </p>
                            <div className="mt-8 flex flex-wrap items-center gap-3">
                                <a
                                    href="#signin"
                                    className="group inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                                >
                                    Sign in to your console
                                    <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
                                </a>
                                <a
                                    href="#how"
                                    className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                                >
                                    How it works
                                </a>
                            </div>
                            <p className="mt-6 text-[13px] text-muted-foreground">
                                MIT licensed · Self-hosted · Your data stays on your instance
                            </p>

                            {/* The product, doing its thing — drag the hub */}
                            <div className="mt-12 hidden lg:block">
                                <NodeEditor />
                            </div>
                        </div>

                        <div id="signin" className="scroll-mt-24 lg:sticky lg:top-10">
                            <LoginForm />
                        </div>
                    </div>
                </section>

                {/* ── Features ─────────────────────────────────────── */}
                <section className="border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            What it does
                        </h2>
                        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                            One console for the whole loop: the Reel that brings the comment,
                            the automation that answers it, and the numbers that prove it
                            worked.
                        </p>

                        <div className="mt-10 grid gap-4 sm:grid-cols-2">
                            {FEATURES.map((f) => (
                                <div key={f.title} className="rounded-xl border border-border bg-card p-6">
                                    <f.icon className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
                                    <h3 className="mt-4 flex items-baseline gap-2 text-[15px] font-semibold text-foreground">
                                        {f.title}
                                        {"note" in f && f.note ? (
                                            <span className="text-xs font-medium text-primary">{f.note}</span>
                                        ) : null}
                                    </h3>
                                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                                    {"href" in f && f.href ? (
                                        <a
                                            href={f.href}
                                            className="group mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
                                        >
                                            {f.linkLabel}
                                            <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
                                        </a>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ── Script Writer spotlight ──────────────────────── */}
                <section id="script-writer" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
                            <div>
                                <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                                    The script comes first
                                </h2>
                                <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                                    The Viral Script Writer lives inside the console. Give it a
                                    topic and it writes for the first three seconds first —
                                    because that is where a Reel is won.
                                </p>
                                <ul className="mt-6 space-y-3 text-sm leading-relaxed text-muted-foreground">
                                    <li className="flex gap-3">
                                        <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                                        Three hook options, then a timestamped script paced at
                                        speaking speed for 15 to 90 second Reels
                                    </li>
                                    <li className="flex gap-3">
                                        <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                                        English, Hindi, or Hinglish, in the tone you pick
                                    </li>
                                    <li className="flex gap-3">
                                        <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                                        Runs on a free model — Llama 3.3 70B on Cloudflare Workers
                                        AI, with Groq as a fallback. No extra Meta permission, no
                                        new data stored
                                    </li>
                                    <li className="flex gap-3">
                                        <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                                        The script ends on your keyword, and one click turns that
                                        keyword into the automation that answers it
                                    </li>
                                </ul>
                            </div>

                            {/* Example output, built in code like the real result.
                                P27: the sample now plays back at its own
                                timestamps (ScriptSampleShowcase) instead of
                                sitting static — same content, same card. */}
                            <ScriptSampleShowcase />
                        </div>
                    </div>
                </section>

                {/* ── How it works ─────────────────────────────────── */}
                <section id="how" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            How it works
                        </h2>
                        <div className="mt-10">
                            <PipelineShowcase />
                        </div>

                        <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
                            {SAFETY.map((s) => (
                                <div key={s.label} className="flex items-center gap-3 bg-card px-5 py-4">
                                    <s.icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                    <span className="text-[13px] leading-snug text-foreground">{s.label}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ── Footer ───────────────────────────────────────── */}
                <footer className="border-t border-border">
                    <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8 lg:px-10">
                        <div className="flex items-center gap-2.5">
                            <LogoMark className="h-6 w-6" />
                            <span className="text-[13px] text-muted-foreground">
                                open-autoDM · MIT licensed · Self-hosted
                            </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-5 text-[13px] text-muted-foreground">
                            <a
                                href="https://github.com/parvez1521/open-autodm"
                                target="_blank"
                                rel="noreferrer"
                                className="transition-colors hover:text-foreground"
                            >
                                GitHub
                            </a>
                            {/* P27: the legal pages exist as routes but were
                                not reachable from the landing page at all. */}
                            <a href="/privacy-policy" className="transition-colors hover:text-foreground">
                                Privacy Policy
                            </a>
                            <a href="/terms" className="transition-colors hover:text-foreground">
                                Terms
                            </a>
                            <a href="/data-deletion" className="transition-colors hover:text-foreground">
                                Data Deletion
                            </a>
                            <a href="#signin" className="transition-colors hover:text-foreground">
                                Sign in
                            </a>
                        </div>
                    </div>
                </footer>
            </main>
        </div>
    );
}
