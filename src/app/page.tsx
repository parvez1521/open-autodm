"use client";

import {
    ArrowRight,
    Books,
    ChartBar,
    ChatsCircle,
    Clock,
    Crosshair,
    FileText,
    FilmStrip,
    FolderOpen,
    Images,
    Lightbulb,
    Lightning,
    MagnifyingGlassPlus,
    PencilLine,
    PaperPlaneTilt,
    PlugsConnected,
    PresentationChart,
    Timer,
    TrendUp,
    UserCheck,
    Waveform,
} from "@/components/phosphor";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";
import { NodeEditor } from "@/components/ui/NodeEditor";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ScrollMorph } from "@/components/ui/ScrollMorph";
import { PipelineShowcase } from "@/components/home/PipelineShowcase";
import { DemoShowcase } from "@/components/home/DemoShowcase";
import { FlowBuilder } from "@/components/home/FlowBuilder";
import { CountUp } from "@/components/home/CountUp";
import { useEffect, useState, type ComponentType } from "react";
import { AnimatePresence, MotionConfig, motion, type Variants } from "framer-motion";
import { FaqSection } from "@/components/home/FaqSection";
import { KeywordTicker } from "@/components/home/KeywordTicker";
import { Reveal, RevealRule, Parallax } from "@/components/home/Reveal";
import { HERO_CREATOR_IMG, STUDIO_DESK_IMG, INK_TEXTURE_IMG } from "@/lib/landing-images";
import { PLANS, TRIAL_DAYS } from "@/lib/billing/catalogue";
import { ScriptSampleShowcase } from "@/components/home/ScriptSampleShowcase";
import { WaitlistForm } from "@/components/home/WaitlistForm";

const FEATURES = [
    {
        icon: ChatsCircle,
        title: "Comment to DM",
        body: "A keyword in a post or Reel comment triggers a Private Reply with your link, PDF, or offer. Instagram allows one within 7 days of the comment, and the engine checks before it sends.",
    },
    {
        icon: Lightning,
        title: "DM and story replies",
        body: "Keyword replies inside DMs and story mentions, plus an away mode that answers while you are offline, in the same conversation thread.",
    },
    {
        icon: ChartBar,
        title: "Analytics and live debug",
        body: "A comment-to-DM funnel, your top automations, and a debug stream that shows every webhook as it is verified, matched, queued, and sent.",
    },
    {
        icon: PencilLine,
        title: "Viral Script Writer",
        note: "New",
        body: "Writes the Reel before the automation exists: three hook options, a timestamped script paced for speaking, caption and hashtags. It ends on your comment keyword, so the script and the automation use the same word.",
        href: "#script-writer",
        linkLabel: "See an example",
    },
] as const;

const SAFETY: {
    icon: ComponentType<{ className?: string }>;
    label: string;
    value?: string;
    count?: number;
    suffix?: string;
}[] = [
    { icon: Timer, count: 180, label: "DMs per hour, hard cap" },
    { icon: Clock, count: 24, suffix: "h", label: "window checked before every send" },
    { icon: UserCheck, count: 1, label: "DM per person, per automation, per day" },
    { icon: PlugsConnected, value: "HMAC", label: "SHA-256 signed webhook verification" },
];

const PILLARS = [
    {
        icon: Lightning,
        title: "Automate",
        href: "#automation",
        body: "Instagram comment-to-DM automation, DM and story replies, and hard safety caps on every send.",
    },
    {
        icon: FilmStrip,
        title: "Create",
        href: "#creator-studio",
        body: "Creator Studio covers the whole production line: niche, ideas, scripts, voiceover and SEO.",
    },
    {
        icon: TrendUp,
        title: "Grow",
        href: "#automation",
        body: "Analytics and a live debug stream show what is working, and the SEO workspace packages every video for discovery.",
    },
] as const;

const STUDIO_GROUPS = [
    {
        label: "Plan",
        tools: [
            {
                icon: Crosshair,
                name: "Niche Finder",
                does: "Score a topic before you commit to making the video.",
                get: "demand, competition, ease and earning-potential scores for the topic.",
            },
            {
                icon: Lightbulb,
                name: "Next Video Ideas",
                does: "Generate your next videos from formats that already work.",
                get: "proven formats, real audience questions and trending angles.",
            },
        ],
    },
    {
        label: "Create",
        tools: [
            {
                icon: PencilLine,
                name: "Script Builder",
                does: "Build a video script section by section.",
                get: "a structured script with a hook, sections and a closing CTA.",
            },
            {
                icon: Waveform,
                name: "Voiceover Studio",
                does: "Generate narration right in your browser, nothing is uploaded.",
                get: "a voiceover you can preview and use in your video.",
            },
            {
                icon: FileText,
                name: "Transcript Tools",
                does: "Paste or upload a transcript you already have.",
                get: "a cleaned, formatted transcript you can reuse anywhere.",
            },
        ],
    },
    {
        label: "Package",
        tools: [
            {
                icon: PresentationChart,
                name: "Presentations",
                does: "Turn a topic into a slide deck.",
                get: "a deck you can present in the browser or export as a file.",
            },
            {
                icon: MagnifyingGlassPlus,
                name: "SEO Workspace",
                does: "Package every video for search and discovery.",
                get: "titles, a structured description and right-sized tags.",
            },
        ],
    },
    {
        label: "Reuse",
        tools: [
            {
                icon: Books,
                name: "Prompt Library",
                does: "Start from prompts that are ready to use.",
                get: "prompts for hooks, scripts, thumbnails, SEO and outreach.",
            },
            {
                icon: Images,
                name: "Stock Libraries",
                does: "Find free stock without leaving the studio.",
                get: "images, video and audio with credits attached.",
            },
            {
                icon: FolderOpen,
                name: "Projects",
                does: "Everything you save, kept in one place.",
                get: "your work stored on your device, ready to reopen anytime.",
            },
        ],
    },
] as const;

const NAV_LINKS = [
    { label: "Automation", href: "#automation" },
    { label: "How it works", href: "#how" },
    { label: "Demo", href: "#demo" },
    { label: "Script Writer", href: "#script-writer" },
    { label: "Creator Studio", href: "#creator-studio" },
    { label: "FAQ", href: "#faq" },
    { label: "Pricing", href: "/pricing" },
] as const;

const HERO_LOOP_LINES = [
    "comment 'PRICE' → DM with the pricing sent",
    "comment 'LINK' → DM with the guide sent",
    "comment 'DEMO' → DM with the booking sent",
] as const;

/** A small living line under the hero CTAs: the loop, cycling.
 *  Static under prefers-reduced-motion. */
function HeroLoopChip() {
    const [idx, setIdx] = useState(0);
    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const t = setInterval(() => setIdx((i) => (i + 1) % HERO_LOOP_LINES.length), 2600);
        return () => clearInterval(t);
    }, []);
    return (
        <p className="mt-4 flex items-center gap-2 font-mono text-[12px] text-muted-foreground" aria-live="off">
            <Lightning className="h-3.5 w-3.5 shrink-0 text-primary" />
            <AnimatePresence mode="wait">
                <motion.span
                    key={idx}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.3 }}
                >
                    {HERO_LOOP_LINES[idx]}
                </motion.span>
            </AnimatePresence>
        </p>
    );
}

/** Hosted-plan prices for the landing band (INR, from the billing
 *  catalogue — the single source for these figures; owner-approved
 *  2026-11-08). */
function inrPrice(minor: number): string {
    if (minor === 0) return "₹0";
    return `₹${(minor / 100).toLocaleString("en-IN")}`;
}

/** The contact address the legal pages already publish — the
 *  Enterprise tier's Contact Us target. */
const CONTACT_HREF = "mailto:work.techhacksai@gmail.com";

/**
 * Round 5 (2026-11-08) — hero entrance choreography. The owner
 * asked for a proper motion-graphics feel: the hero now arrives as
 * a staged sequence (headline, sub, actions, loop line) instead of
 * a static block. Transform/opacity only; MotionConfig
 * reducedMotion="user" collapses it for reduced-motion visitors.
 */
const heroContainer: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.12, delayChildren: 0.05 } },
};
const heroItem: Variants = {
    hidden: { opacity: 0, y: 26 },
    show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } },
};

export default function LandingPage() {
    // Continuous numbering for the Creator Studio index (01-10 across groups).
    let toolNumber = 0;

    return (
        <MotionConfig reducedMotion="user">
        <div className="relative min-h-screen bg-background text-foreground overflow-x-clip">
            <ScrollMorph />

            {/* Header */}
            <header className="relative z-10 border-b border-border">
                <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">
                    <div className="flex items-center gap-3">
                        <LogoMark className="h-8 w-8" />
                        <LogoWordmark className="text-[15px]" />
                    </div>
                    <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
                        {NAV_LINKS.map((link) => (
                            <a
                                key={link.label}
                                href={link.href}
                                className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                            >
                                {link.label}
                            </a>
                        ))}
                    </nav>
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
                        <a
                            href="/login"
                            className="hidden h-9 items-center rounded-md px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:inline-flex"
                        >
                            Sign in
                        </a>
                        <a
                            href="/login"
                            className="inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                        >
                            Get started
                        </a>
                    </div>
                </div>
            </header>

            <main className="relative z-10">
                {/* ── Hero ─────────────────────────────────────────── */}
                <section className="mx-auto max-w-7xl px-6 pb-20 pt-14 lg:px-10 lg:pb-28 lg:pt-20">
                    <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-16">
                        <motion.div
                            className="max-w-3xl"
                            variants={heroContainer}
                            initial="hidden"
                            animate="show"
                        >
                        <motion.h1
                            variants={heroItem}
                            className="font-heading text-[40px] font-semibold leading-[1.08] tracking-tight text-foreground sm:text-5xl lg:text-[56px]"
                        >
                            Turn comments into customers on autopilot
                        </motion.h1>
                        <motion.p
                            variants={heroItem}
                            className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground lg:text-lg lg:leading-relaxed"
                        >
                            open-autoDM is open-source, self-hosted Instagram automation
                            software. It runs on your own Meta app, database, and domain,
                            no per-seat pricing, and no third party holding your tokens.
                        </motion.p>
                        <motion.div variants={heroItem} className="mt-8 flex flex-wrap items-center gap-3">
                            <a
                                href="/login"
                                className="inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                            >
                                Sign in to your console
                                <ArrowRight className="h-4 w-4" />
                            </a>
                            <a
                                href="#platform"
                                className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                            >
                                Explore the platform
                            </a>
                        </motion.div>
                        <motion.p variants={heroItem} className="mt-6 text-[13px] text-muted-foreground">
                            MIT licensed · Self-hosted · Your data stays on your instance
                        </motion.p>
                        <motion.div variants={heroItem}>
                            <HeroLoopChip />
                        </motion.div>
                        </motion.div>

                        {/* Round 4 (2026-11-08): the human side of the loop —
                            a generated editorial photograph, no text in frame.
                            Round 5: it now arrives with the hero sequence —
                            a slow settle from a slight scale, no hover motion. */}
                        <motion.figure
                            className="hidden lg:block"
                            initial={{ opacity: 0, scale: 1.04 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.9, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
                        >
                            <img
                                src={HERO_CREATOR_IMG}
                                alt="A creator recording a short video on a phone mounted on a tripod"
                                className="aspect-[4/5] w-full rounded-xl border border-border object-cover"
                                loading="lazy"
                            />
                            <figcaption className="mt-3 flex items-baseline justify-between gap-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                                <span>Fig. 01 — The creator</span>
                                <span>Filmed on a phone</span>
                            </figcaption>
                        </motion.figure>
                    </div>

                    {/* The product, doing its thing: drag the hub */}
                    <div className="mt-14 hidden lg:block">
                        <NodeEditor />
                    </div>

                    {/* Mobile hero visual: the loop in three rows (the
                        full NodeEditor above is desktop-only). */}
                    <div className="mt-12 lg:hidden">
                        <ol className="overflow-hidden rounded-xl border border-border">
                            <li className="flex items-center gap-3.5 border-b border-border bg-card px-4 py-3.5">
                                <ChatsCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
                                <span className="text-sm">
                                    <span className="font-medium">A visitor comments your keyword</span>
                                    <span className="block text-[13px] text-muted-foreground">
                                        PRICE, LINK, DEMO — you choose the trigger
                                    </span>
                                </span>
                            </li>
                            <li className="flex items-center gap-3.5 border-b border-border bg-card px-4 py-3.5">
                                <Lightning className="h-5 w-5 shrink-0 text-muted-foreground" />
                                <span className="text-sm">
                                    <span className="font-medium">The automation matches it</span>
                                    <span className="block text-[13px] text-muted-foreground">
                                        A public reply goes out under the comment
                                    </span>
                                </span>
                            </li>
                            <li className="flex items-center gap-3.5 bg-card px-4 py-3.5">
                                <PaperPlaneTilt className="h-5 w-5 shrink-0 text-muted-foreground" />
                                <span className="text-sm">
                                    <span className="font-medium">The DM lands in their inbox</span>
                                    <span className="block text-[13px] text-muted-foreground">
                                        Links, pricing or a booking — inside the 24-hour window
                                    </span>
                                </span>
                            </li>
                        </ol>
                    </div>
                </section>

                {/* Round 4 (2026-11-08): continuous, product-truthful
                    motion — the loop, running as a ticker under the hero. */}
                <KeywordTicker />

                {/* Round 4 (2026-11-08, competitor memo pattern #3 — the
                    before/after chapter ManyChat uses): the same launch
                    evening run by hand versus on autopilot. Two flat
                    panels on a hairline seam — no cards, no glow. The
                    figures are ONE illustrative evening, labelled as
                    such in the copy; the mechanics (instant match,
                    180/hour cap) are the shipped ones. */}
                <section className="border-t border-border">
                    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24 lg:px-8">
                        <Reveal className="max-w-2xl">
                            <p className="micro-label">Before / after</p>
                            <h2 className="mt-4 font-heading text-3xl font-semibold leading-[1.05] sm:text-4xl">
                                The same launch evening, twice
                            </h2>
                            <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
                                A reel takes off at 7 pm and the comments fill with one
                                word: link. On the left, the evening when every reply is
                                typed by hand. On the right, the same evening with the
                                keyword live. One illustrative evening — the mechanics
                                are the shipped ones.
                            </p>
                            <RevealRule className="mt-6 max-w-24" />
                        </Reveal>
                        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-2">
                            <motion.div
                                className="bg-card p-6 sm:p-8"
                                initial={{ opacity: 0, x: -36 }}
                                whileInView={{ opacity: 1, x: 0 }}
                                viewport={{ once: true, margin: "-10% 0px -10% 0px" }}
                                transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
                            >
                                <p className="micro-label">By hand</p>
                                <dl className="mt-6 divide-y divide-border text-sm">
                                    {[
                                        ["“link?” comments by midnight", "47"],
                                        ["Replies typed out, one by one", "47"],
                                        ["First reply sent", "3 h 40 min after the comment"],
                                        ["Links actually delivered", "19 of 47"],
                                        ["Evening spent inside the inbox", "All of it"],
                                    ].map(([k, v]) => (
                                        <div key={k} className="flex items-baseline justify-between gap-6 py-3">
                                            <dt className="text-muted-foreground">{k}</dt>
                                            <dd className="text-right font-medium">{v}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </motion.div>
                            <motion.div
                                className="bg-card p-6 sm:p-8"
                                initial={{ opacity: 0, x: 36 }}
                                whileInView={{ opacity: 1, x: 0 }}
                                viewport={{ once: true, margin: "-10% 0px -10% 0px" }}
                                transition={{ duration: 0.75, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
                            >
                                <p className="micro-label text-primary">On autopilot</p>
                                <dl className="mt-6 divide-y divide-border text-sm">
                                    {[
                                        ["“link?” comments by midnight", "47"],
                                        ["Replies typed out, one by one", "0"],
                                        ["First reply sent", "Under a minute"],
                                        ["Links actually delivered", "47 of 47"],
                                        ["Evening spent inside the inbox", "None — the 180 / hour cap held"],
                                    ].map(([k, v]) => (
                                        <div key={k} className="flex items-baseline justify-between gap-6 py-3">
                                            <dt className="text-muted-foreground">{k}</dt>
                                            <dd className="text-right font-medium">{v}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </motion.div>
                        </div>
                    </div>
                </section>

                {/* ── Platform overview ────────────────────────────── */}
                <section id="platform" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-20">
                            <Reveal>
                                <p className="micro-label">The platform</p>
                                <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                                    One platform, three jobs
                                </h2>
                                <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                                    One console for the whole creator loop: the automation
                                    that brings the audience in, the studio that makes the
                                    next video, and the analytics that show what worked.
                                </p>
                                <RevealRule className="mt-6 max-w-24" />
                            </Reveal>
                            <div>
                                {PILLARS.map((p) => (
                                    <a
                                        key={p.title}
                                        href={p.href}
                                        className="-mx-3 flex items-start gap-4 border-b border-border px-3 py-6 transition-colors last:border-b-0 hover:bg-muted/40"
                                    >
                                        <p.icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
                                                {p.title}
                                                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                                            </span>
                                            <span className="mt-1.5 block text-sm leading-relaxed text-muted-foreground">
                                                {p.body}
                                            </span>
                                        </span>
                                    </a>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                {/* ── Automation ───────────────────────────────────── */}
                <section id="automation" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <Reveal>
                        <p className="micro-label">Automation</p>
                        <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            What it does
                        </h2>
                        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                            One console for the whole loop: the Reel that brings the comment,
                            the automation that answers it, and the numbers that prove it
                            worked.
                        </p>
                        <RevealRule className="mt-6 max-w-24" />
                        </Reveal>

                        <div className="mt-10 border-t border-border">
                            {FEATURES.map((f, i) => (
                                <Reveal key={f.title} delay={i * 0.07}>
                                <div
                                    className="grid gap-3 border-b border-border py-7 lg:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-8"
                                >
                                    <span className="font-mono text-[13px] text-muted-foreground lg:pt-1">
                                        {String(i + 1).padStart(2, "0")}
                                    </span>
                                    <h3 className="flex items-center gap-2.5 font-heading text-base font-semibold text-foreground">
                                        <f.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                                        {f.title}
                                        {"note" in f && f.note ? (
                                            <span className="text-xs font-medium text-primary">{f.note}</span>
                                        ) : null}
                                    </h3>
                                    <div>
                                        <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                                        {"href" in f && f.href ? (
                                            <a
                                                href={f.href}
                                                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
                                            >
                                                {f.linkLabel}
                                                <ArrowRight className="h-3.5 w-3.5" />
                                            </a>
                                        ) : null}
                                    </div>
                                </div>
                                </Reveal>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ── Live demo ────────────────────────────────────── */}
                <section id="demo" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <Reveal>
                        <p className="micro-label">Live demo</p>
                        <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            Watch a comment become a customer
                        </h2>
                        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                            This is the whole product in ten seconds. Pick a keyword,
                            run the flow, and see exactly what your visitor receives —
                            simulated here, automatic on your own instance.
                        </p>
                        <RevealRule className="mt-6 max-w-24" />
                        </Reveal>
                        <div className="mt-10">
                            <DemoShowcase />
                        </div>
                    </div>
                </section>

                {/* ── Flow builder ─────────────────────────────────── */}
                <section id="builder" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <Reveal>
                        <p className="micro-label">Try it yourself</p>
                        <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            Now build your own
                        </h2>
                        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                            Type a keyword, pick a reply style and choose what the DM
                            carries — the preview updates live, with the exact texts
                            your automation would send.
                        </p>
                        <RevealRule className="mt-6 max-w-24" />
                        </Reveal>
                        <div className="mt-10">
                            <FlowBuilder />
                        </div>
                    </div>
                </section>

                {/* ── How it works ─────────────────────────────────── */}
                <section id="how" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <Reveal>
                        <p className="micro-label">The pipeline</p>
                        <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            How it works
                        </h2>
                        <RevealRule className="mt-6 max-w-24" />
                        </Reveal>
                        <div className="mt-10">
                            <PipelineShowcase />
                        </div>

                        <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
                            {SAFETY.map((s, i) => (
                                <Reveal key={s.label} delay={i * 0.07} className="h-full">
                                <div className="h-full bg-card px-5 py-4">
                                    <p className="flex items-center gap-2 font-heading text-xl font-semibold text-foreground">
                                        <s.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        {s.count !== undefined ? (
                                            <CountUp end={s.count} suffix={s.suffix ?? ""} />
                                        ) : (
                                            s.value
                                        )}
                                    </p>
                                    <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
                                        {s.label}
                                    </p>
                                </div>
                                </Reveal>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ── Script Writer spotlight ──────────────────────── */}
                <section id="script-writer" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
                            <div>
                                <Reveal>
                                <p className="micro-label">Spotlight</p>
                                <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                                    The script comes first
                                </h2>
                                <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                                    The Viral Script Writer lives inside the console. Give it a
                                    topic and it writes for the first three seconds first,
                                    because that is where a Reel is won.
                                </p>
                                <RevealRule className="mt-6 max-w-24" />
                                </Reveal>
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
                                        Runs on a free model, Llama 3.3 70B on Cloudflare Workers
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

                {/* ── Creator Studio ───────────────────────────────── */}
                <section id="creator-studio" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <Reveal>
                        <p className="micro-label">The studio</p>
                        <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            Creator Studio
                        </h2>
                        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                            One console to plan, create and package every video, from
                            niche research to publish-ready SEO.
                        </p>
                        <RevealRule className="mt-6 max-w-24" />
                        </Reveal>

                        {/* Round 4 (2026-11-08): where the work happens —
                            a generated editorial photograph of a creator's desk.
                            Round 5: the figure drifts gently against the
                            scroll (Parallax) while its section arrives. */}
                        <Parallax amount={10}>
                        <figure className="mt-10">
                            <img
                                src={STUDIO_DESK_IMG}
                                alt="A creator's desk with a laptop, a studio microphone on a boom arm, and a notebook, ready to record"
                                className="aspect-[16/8] w-full rounded-xl border border-border object-cover"
                                loading="lazy"
                            />
                            <figcaption className="mt-3 flex items-baseline justify-between gap-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                                <span>Fig. 02 — The desk</span>
                                <span>Planned, scripted and packaged in the Studio</span>
                            </figcaption>
                        </figure>
                        </Parallax>

                        <div className="mt-12 space-y-12">
                            {STUDIO_GROUPS.map((group) => (
                                <Reveal key={group.label}>
                                <div>
                                    <h3 className="micro-label">{group.label}</h3>
                                    <div className="mt-4 border-t border-border">
                                        {group.tools.map((tool) => {
                                            toolNumber += 1;
                                            const n = String(toolNumber).padStart(2, "0");
                                            return (
                                                <a
                                                    key={tool.name}
                                                    href="/studio"
                                                    className="-mx-3 flex flex-col gap-1.5 border-b border-border px-3 py-5 transition-colors hover:bg-muted/40 sm:grid sm:grid-cols-[3.25rem_minmax(0,1fr)_minmax(0,1.35fr)_auto] sm:items-start sm:gap-6"
                                                >
                                                    <span className="font-mono text-[13px] text-muted-foreground sm:pt-0.5">
                                                        {n}
                                                    </span>
                                                    <span className="flex items-center gap-2.5 font-heading text-[15px] font-semibold text-foreground">
                                                        <tool.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                                                        {tool.name}
                                                    </span>
                                                    <span>
                                                        <span className="block text-sm leading-relaxed text-muted-foreground">
                                                            {tool.does}
                                                        </span>
                                                        <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">
                                                            <span className="font-medium text-foreground">
                                                                You get:
                                                            </span>{" "}
                                                            {tool.get}
                                                        </span>
                                                    </span>
                                                    <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:mt-1 sm:block" />
                                                </a>
                                            );
                                        })}
                                    </div>
                                </div>
                                </Reveal>
                            ))}
                        </div>

                        <div className="mt-12 flex flex-wrap items-center gap-4">
                            <a
                                href="/studio"
                                className="inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                            >
                                Open Creator Studio
                                <ArrowRight className="h-4 w-4" />
                            </a>
                            <p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">
                                The Studio tools run on built-in engines that work offline.
                                Where a free AI tier is configured, they can enhance the
                                output, and it is always labelled when they do.
                            </p>
                        </div>
                    </div>
                </section>

                {/* ── Pricing ──────────────────────────────────────── */}
                <section id="pricing" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <Reveal className="flex flex-wrap items-end justify-between gap-6">
                            <div className="max-w-2xl">
                                <p className="micro-label">Pricing</p>
                                <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                                    Simple, honest pricing
                                </h2>
                                <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                                    Self-host open-autoDM free on your own infrastructure — the
                                    code is MIT licensed. The hosted plans below open soon:
                                    checkout is being switched on, so nothing can be bought
                                    yet. No per-seat pricing and no per-message charges,
                                    either way.
                                </p>
                                <RevealRule className="mt-6 max-w-24" />
                            </div>
                            <a
                                href="/pricing"
                                className="inline-flex h-11 items-center gap-2 rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                            >
                                Compare plans in full
                                <ArrowRight className="h-4 w-4" />
                            </a>
                        </Reveal>

                        <div className="mt-10 border-t border-border">
                            {PLANS.map((plan, i) =>
                                plan.customPricing ? (
                                    // Enterprise (owner instruction, 2026-11-08):
                                    // "For Business / Agency", Contact Us instead
                                    // of a price — no figure anywhere.
                                    <Reveal key={plan.id} delay={i * 0.05}>
                                        <div className="grid gap-2 border-b border-border px-1 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 lg:grid-cols-[14rem_10rem_minmax(0,1fr)_auto]">
                                            <span className="font-heading text-[15px] font-semibold text-foreground">
                                                {plan.name}
                                                <span className="block font-sans text-[12px] font-normal text-muted-foreground">
                                                    For Business / Agency
                                                </span>
                                            </span>
                                            <span className="font-heading text-xl font-semibold text-foreground">
                                                Custom
                                            </span>
                                            <span className="text-sm leading-relaxed text-muted-foreground">
                                                More accounts, custom limits and priority
                                                support — tell us what you run and we will
                                                put a number on it. Creator Studio included.
                                            </span>
                                            <a
                                                href={CONTACT_HREF}
                                                className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
                                            >
                                                Contact us
                                                <ArrowRight className="h-3.5 w-3.5" />
                                            </a>
                                        </div>
                                    </Reveal>
                                ) : (
                                    <Reveal key={plan.id} delay={i * 0.05}>
                                        <a
                                            href="/pricing"
                                            className="grid gap-2 border-b border-border px-1 py-5 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 lg:grid-cols-[14rem_10rem_minmax(0,1fr)_auto]"
                                        >
                                            <span className="flex items-center gap-2.5 font-heading text-[15px] font-semibold text-foreground">
                                                {plan.name}
                                            </span>
                                            <span className="font-heading text-xl font-semibold text-foreground">
                                                {inrPrice(plan.prices.INR.monthlyMinor)}
                                                <span className="text-[13px] font-normal text-muted-foreground"> / mo</span>
                                            </span>
                                            <span className="text-sm leading-relaxed text-muted-foreground">
                                                {plan.limits.instagramAccounts} Instagram account
                                                {plan.limits.instagramAccounts === 1 ? "" : "s"} ·{" "}
                                                {plan.limits.activeAutomations} active automations ·{" "}
                                                {plan.limits.dmsPerMonth.toLocaleString("en-IN")} DMs / month ·{" "}
                                                Creator Studio included
                                            </span>
                                            <ArrowRight className="hidden h-4 w-4 text-muted-foreground lg:block" />
                                        </a>
                                    </Reveal>
                                ),
                            )}
                        </div>
                        <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
                            Annual billing runs about 20% lower on every paid tier. Every
                            paid plan starts with a {TRIAL_DAYS}-day free trial — no card
                            needed. Safety and compliance features are included on every
                            plan, Free included, and are never metered.
                        </p>
                    </div>
                </section>

                {/* ── FAQ ──────────────────────────────────────────── */}
                <section id="faq" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <Reveal>
                        <p className="micro-label">Questions</p>
                        <h2 className="mt-4 font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            Frequently asked questions
                        </h2>
                        <RevealRule className="mt-6 max-w-24" />
                        </Reveal>
                        <div className="mt-10">
                            <FaqSection />
                        </div>
                    </div>
                </section>

                {/* Round 4 (2026-11-08): a quiet print moment between the
                    questions and the ask — generated ink-and-orange texture,
                    decorative only. */}
                <div className="border-t border-border" aria-hidden="true">
                    <img
                        src={INK_TEXTURE_IMG}
                        alt=""
                        className="h-28 w-full object-cover sm:h-36"
                        loading="lazy"
                    />
                </div>

                {/* ── Final CTA ────────────────────────────────────── */}
                <section className="border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <div className="mx-auto max-w-2xl text-center">
                            <h2 className="font-heading text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">
                                Ready to turn comments into customers?
                            </h2>
                            <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
                                Sign in to your console, or run your own instance. The
                                code is open-source and MIT licensed.
                            </p>
                            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                                <a
                                    href="/login"
                                    className="inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                                >
                                    Get started
                                    <ArrowRight className="h-4 w-4" />
                                </a>
                                <a
                                    href="/login"
                                    className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                                >
                                    Sign in
                                </a>
                            </div>
                            <div className="mx-auto mt-12 max-w-md border-t border-border pt-8 text-center">
                                <p className="micro-label">Waitlist</p>
                                <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                                    Not ready to self-host? Public access opens in
                                    stages. Join the waitlist and we will write to you
                                    when a slot opens. One email, when it matters.
                                </p>
                                <WaitlistForm />
                            </div>
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
                            <a href="#demo" className="transition-colors hover:text-foreground">
                                Live demo
                            </a>
                            <a href="#faq" className="transition-colors hover:text-foreground">
                                FAQ
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
                            <a href="/login" className="transition-colors hover:text-foreground">
                                Sign in
                            </a>
                        </div>
                    </div>
                </footer>
            </main>
        </div>
        </MotionConfig>
    );
}
