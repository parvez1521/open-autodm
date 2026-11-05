"use client";

/**
 * PipelineShowcase — the homepage "How it works" section as a living
 * motion-graphics panel: a simulated comment runs the real automation
 * pipeline (Trigger → Filter & Guard → Public Reply → Private DM) on a
 * loop. Every label in the simulation maps to behaviour the engine
 * actually implements — Meta webhook trigger, keyword match, HMAC
 * signature check, the 180 DMs/hour traffic guard, one-DM-per-person
 * dedupe, then the two-step public reply + Private Reply flow.
 *
 * Auto-plays only while on screen; pauses on hover; a visitor can click
 * any step to inspect it. With prefers-reduced-motion the panel stays
 * on the first step and only responds to clicks.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
    Check,
    Download,
    Gauge,
    Lock,
    MessageCircle,
    Send,
    ShieldCheck,
    UserCheck,
    Webhook,
} from "lucide-react";

const IG_GRADIENT = "linear-gradient(90deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)";
const STEP_MS = [3400, 4000, 4200, 3800];

const STEPS = [
    {
        label: "Trigger",
        icon: Webhook,
        tag: "Step 01 — Reel or Post comment",
        title: "1. Trigger",
        body: "Monitors comments on your selected Reel or Post in real time via Meta webhooks.",
        chip: "Keyword 'GUIDE' detected via webhook",
    },
    {
        label: "Filter & Guard",
        icon: ShieldCheck,
        tag: "Step 02 — Traffic Guard checks",
        title: "2. Filter & Guard",
        body: "Before anything is sent, the Traffic Guard verifies the webhook and checks the send against Meta's limits and your rate cap.",
        chip: "All guards passed — safe to send",
    },
    {
        label: "Public Reply",
        icon: MessageCircle,
        tag: "Step 03 — Public reply on the comment",
        title: "3. Public Reply",
        body: "A public reply lands under the comment, so every other viewer sees the offer and the thread keeps moving.",
        chip: "Public reply posted",
    },
    {
        label: "Private DM",
        icon: Send,
        tag: "Step 04 — Private Reply in DMs",
        title: "4. Private DM",
        body: "The promised resource arrives as a Private Reply in the commenter's inbox — inside Instagram's 7-day window, checked before sending.",
        chip: "Private DM delivered",
    },
] as const;

const GUARDS = [
    { icon: Lock, text: "Webhook signature verified — HMAC-SHA256" },
    { icon: Gauge, text: "Within the Traffic Guard limit of 180 DMs per hour" },
    { icon: UserCheck, text: "First DM to this person today — no duplicate" },
] as const;

const REPLY_TEXT = "@alex_dev Just sent you the guide in your DMs — check your inbox";

function TypeText({ text, active }: { text: string; active: boolean }) {
    const [count, setCount] = useState(0);
    useEffect(() => {
        if (!active) {
            setCount(0);
            return;
        }
        setCount(0);
        const id = setInterval(() => {
            setCount((c) => {
                if (c >= text.length) {
                    clearInterval(id);
                    return c;
                }
                return c + 1;
            });
        }, 26);
        return () => clearInterval(id);
    }, [active, text]);
    return (
        <span>
            {text.slice(0, count)}
            <span className="ml-0.5 inline-block h-[13px] w-[2px] translate-y-[2px] animate-pulse bg-primary" />
        </span>
    );
}

function Scene({ step }: { step: number }) {
    if (step === 0) {
        return (
            <div className="flex h-full flex-col gap-3">
                <div className="rounded-xl border border-border bg-background p-4">
                    <div className="flex items-center gap-3">
                        <span
                            className="h-9 w-9 shrink-0 rounded-full"
                            style={{ background: IG_GRADIENT }}
                        />
                        <span className="text-sm font-semibold text-foreground">sarah_creator</span>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                        Comment GUIDE below to get my free 2026 growth blueprint!
                    </p>
                </div>
                <motion.div
                    initial={{ opacity: 0, y: 14, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: 0.7, type: "spring", stiffness: 260, damping: 24 }}
                    className="rounded-xl border border-primary/30 bg-primary/5 p-4"
                >
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-foreground">@alex_dev</span>
                        <motion.span
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 1.6 }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500"
                        >
                            <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Trigger Match
                        </motion.span>
                    </div>
                    <p className="mt-1.5 text-sm text-foreground">
                        <span className="rounded bg-primary/15 px-1 font-semibold text-primary">GUIDE</span>{" "}
                        please! Looking forward to this.
                    </p>
                </motion.div>
            </div>
        );
    }
    if (step === 1) {
        return (
            <div className="flex h-full flex-col justify-center gap-3">
                {GUARDS.map((g, i) => (
                    <motion.div
                        key={g.text}
                        initial={{ opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.35 + i * 0.85, duration: 0.35 }}
                        className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3.5"
                    >
                        <g.icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                        <span className="flex-1 text-sm leading-snug text-foreground">{g.text}</span>
                        <motion.span
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ delay: 0.6 + i * 0.85, type: "spring", stiffness: 400, damping: 18 }}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500"
                        >
                            <Check className="h-3 w-3" strokeWidth={3} />
                        </motion.span>
                    </motion.div>
                ))}
            </div>
        );
    }
    if (step === 2) {
        return (
            <div className="flex h-full flex-col gap-3">
                <div className="rounded-xl border border-border bg-background p-4 opacity-70">
                    <span className="text-sm font-semibold text-foreground">@alex_dev</span>
                    <p className="mt-1.5 text-sm text-muted-foreground">GUIDE please! Looking forward to this.</p>
                </div>
                <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4, duration: 0.35 }}
                    className="ml-6 rounded-xl rounded-tl-sm border border-border bg-card p-4 shadow-lg"
                >
                    <div className="flex items-center gap-2.5">
                        <span
                            className="h-6 w-6 shrink-0 rounded-full"
                            style={{ background: IG_GRADIENT }}
                        />
                        <span className="text-[13px] font-semibold text-foreground">sarah_creator</span>
                        <span className="text-[11px] text-muted-foreground">replying publicly</span>
                    </div>
                    <p className="mt-2.5 text-sm leading-relaxed text-foreground">
                        <TypeText text={REPLY_TEXT} active={step === 2} />
                    </p>
                </motion.div>
            </div>
        );
    }
    return (
        <div className="flex h-full flex-col gap-3">
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="self-end rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
            >
                GUIDE please!
            </motion.div>
            <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.9, type: "spring", stiffness: 240, damping: 22 }}
                className="w-[88%] self-start rounded-2xl rounded-bl-sm border border-border bg-background p-4"
            >
                <p className="text-sm leading-relaxed text-foreground">
                    Here is your 2026 Growth Blueprint — the exact system from the Reel.
                </p>
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3">
                    <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white"
                        style={{ background: IG_GRADIENT }}
                    >
                        <Download className="h-4 w-4" strokeWidth={2} />
                    </span>
                    <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-foreground">
                            2026-growth-blueprint.pdf
                        </span>
                        <span className="block text-[11px] text-muted-foreground">Tap to download</span>
                    </span>
                </div>
                <span className="mt-2.5 inline-flex items-center gap-1 text-[11px] text-emerald-500">
                    <Check className="h-3 w-3" strokeWidth={3} /> Delivered
                </span>
            </motion.div>
        </div>
    );
}

export function PipelineShowcase() {
    const [step, setStep] = useState(0);
    const [hovering, setHovering] = useState(false);
    const [inView, setInView] = useState(false);
    const [reduced, setReduced] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
        setReduced(mq.matches);
        const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);

    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const io = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), {
            threshold: 0.25,
        });
        io.observe(el);
        return () => io.disconnect();
    }, []);

    const playing = inView && !hovering && !reduced;
    useEffect(() => {
        if (!playing) return;
        const id = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEP_MS[step]!);
        return () => clearTimeout(id);
    }, [playing, step]);

    const active = STEPS[step]!;

    return (
        <div
            ref={rootRef}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
            className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        >
            {/* Window chrome */}
            <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
                <span className="flex gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                    open-autoDM {"//"} Automation Execution Pipeline
                </span>
                <span className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] font-medium text-emerald-500">
                    <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    </span>
                    Traffic Guard Active
                </span>
            </div>

            {/* Step rail */}
            <div className="grid grid-cols-2 border-b border-border lg:grid-cols-4">
                {STEPS.map((s, i) => {
                    const isActive = i === step;
                    const isDone = i < step;
                    return (
                        <button
                            key={s.label}
                            type="button"
                            onClick={() => setStep(i)}
                            aria-current={isActive ? "step" : undefined}
                            className={`relative px-5 py-4 text-left transition-colors ${
                                i > 0 ? "border-l border-border" : ""
                            } ${isActive ? "bg-background/60" : "hover:bg-background/40"}`}
                        >
                            <span
                                className={`font-mono text-[11px] font-medium uppercase tracking-wider ${
                                    isActive || isDone ? "text-primary" : "text-muted-foreground"
                                }`}
                            >
                                Step {String(i + 1).padStart(2, "0")}
                            </span>
                            <span
                                className={`mt-1 block text-sm font-semibold ${
                                    isActive ? "text-foreground" : "text-muted-foreground"
                                }`}
                            >
                                {i + 1}. {s.label}
                            </span>
                            {(isActive || isDone) && (
                                <motion.span
                                    key={`rail-${step}-${isActive ? "run" : "done"}`}
                                    initial={{ scaleX: isActive ? 0 : 1 }}
                                    animate={{ scaleX: 1 }}
                                    transition={{
                                        duration: isActive && playing ? STEP_MS[step]! / 1000 : 0.3,
                                        ease: "linear",
                                    }}
                                    style={{ background: IG_GRADIENT }}
                                    className="absolute inset-x-0 bottom-0 h-[2.5px] origin-left"
                                />
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Stage */}
            <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_1.15fr] lg:gap-10">
                <div className="flex flex-col justify-center">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={step}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.3 }}
                        >
                            <span className="inline-block rounded-md bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-medium text-primary">
                                {active.tag}
                            </span>
                            <h3 className="mt-4 font-heading text-3xl font-semibold tracking-tight text-foreground">
                                {active.title}
                            </h3>
                            <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                                {active.body}
                            </p>
                            <motion.span
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.55 }}
                                className="mt-6 inline-flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 font-mono text-xs text-emerald-500"
                            >
                                <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                                {active.chip}
                            </motion.span>
                        </motion.div>
                    </AnimatePresence>
                    <p className="mt-8 text-[13px] text-muted-foreground">
                        Click steps above to explore the workflow
                    </p>
                </div>

                <div className="relative min-h-[290px] rounded-xl border border-border bg-background/50 p-4 sm:p-5">
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                        Simulated execution
                    </span>
                    <div className="mt-4">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={step}
                                initial={{ opacity: 0, x: 24 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -16 }}
                                transition={{ duration: 0.32 }}
                            >
                                <Scene step={step} />
                            </motion.div>
                        </AnimatePresence>
                    </div>
                    {/* Traveling pulse along the bottom thread */}
                    <span className="absolute inset-x-5 bottom-3 h-px bg-border" />
                    <motion.span
                        key={`pulse-${step}`}
                        initial={{ left: "5%", opacity: 0 }}
                        animate={{ left: "92%", opacity: [0, 1, 1, 0] }}
                        transition={{ duration: 1.6, delay: 0.3, ease: "easeInOut" }}
                        style={{ background: IG_GRADIENT }}
                        className="absolute bottom-[11px] h-[3px] w-10 rounded-full"
                    />
                </div>
            </div>
        </div>
    );
}
