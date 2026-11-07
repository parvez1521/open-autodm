"use client";

import {
    ArrowRight,
    AudioLines,
    BarChart3,
    Clapperboard,
    Clock3,
    Crosshair,
    FileText,
    FolderOpen,
    Image as ImageIcon,
    LibraryBig,
    Lightbulb,
    Images,
    MessagesSquare,
    PenLine,
    Presentation,
    SearchCheck,
    Timer,
    TrendingUp,
    UserCheck,
    Webhook,
    Zap,
} from "lucide-react";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";
import { NodeEditor } from "@/components/ui/NodeEditor";
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

const PILLARS = [
    {
        icon: Zap,
        title: "Automate",
        href: "#automation",
        body: "Instagram comment-to-DM automation, DM and story replies, and hard safety caps on every send.",
    },
    {
        icon: Clapperboard,
        title: "Create",
        href: "#creator-studio",
        body: "Creator Studio covers the whole production line: niche, ideas, scripts, voiceover, thumbnails and SEO.",
    },
    {
        icon: TrendingUp,
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
                icon: PenLine,
                name: "Script Builder",
                does: "Build a video script section by section.",
                get: "a structured script with a hook, sections and a closing CTA.",
            },
            {
                icon: AudioLines,
                name: "Voiceover Studio",
                does: "Generate narration right in your browser — nothing is uploaded.",
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
                icon: ImageIcon,
                name: "Thumbnail Editor",
                does: "Design thumbnails on a proper 1280×720 canvas.",
                get: "templates, layers and your own images in one editor.",
            },
            {
                icon: Presentation,
                name: "Presentations",
                does: "Turn a topic into a slide deck.",
                get: "a deck you can present in the browser or export as a file.",
            },
            {
                icon: SearchCheck,
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
                icon: LibraryBig,
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
    { label: "Script Writer", href: "#script-writer" },
    { label: "Creator Studio", href: "#creator-studio" },
    { label: "Pricing", href: "/pricing" },
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
                    <div className="max-w-3xl">
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
                                href="/login"
                                className="group inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                            >
                                Sign in to your console
                                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
                            </a>
                            <a
                                href="#platform"
                                className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                            >
                                Explore the platform
                            </a>
                        </div>
                        <p className="mt-6 text-[13px] text-muted-foreground">
                            MIT licensed · Self-hosted · Your data stays on your instance
                        </p>
                    </div>

                    {/* The product, doing its thing — drag the hub */}
                    <div className="mt-14 hidden lg:block">
                        <NodeEditor />
                    </div>
                </section>

                {/* ── Platform overview ────────────────────────────── */}
                <section id="platform" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <p className="micro-label text-muted-foreground">The platform</p>
                        <div className="mt-6 grid gap-4 sm:grid-cols-3">
                            {PILLARS.map((p) => (
                                <a
                                    key={p.title}
                                    href={p.href}
                                    className="group rounded-xl border border-border bg-card p-6 transition-colors hover:bg-muted/40"
                                >
                                    <p.icon className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
                                    <h3 className="mt-4 flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
                                        {p.title}
                                        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
                                    </h3>
                                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                                </a>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ── Automation ───────────────────────────────────── */}
                <section id="automation" className="scroll-mt-16 border-t border-border">
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

                {/* ── Creator Studio ───────────────────────────────── */}
                <section id="creator-studio" className="scroll-mt-16 border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                            Creator Studio
                        </h2>
                        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                            One console to plan, create and package every video — from
                            niche research to publish-ready SEO.
                        </p>

                        <div className="mt-12 space-y-12">
                            {STUDIO_GROUPS.map((group) => (
                                <div key={group.label}>
                                    <h3 className="micro-label text-muted-foreground">{group.label}</h3>
                                    <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                        {group.tools.map((tool) => (
                                            <div
                                                key={tool.name}
                                                className="rounded-xl border border-border bg-card p-6"
                                            >
                                                <tool.icon
                                                    className="h-5 w-5 text-muted-foreground"
                                                    strokeWidth={1.5}
                                                />
                                                <h4 className="mt-4 text-[15px] font-semibold text-foreground">
                                                    {tool.name}
                                                </h4>
                                                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                                    {tool.does}
                                                </p>
                                                <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
                                                    <span className="font-medium text-foreground">
                                                        You get:
                                                    </span>{" "}
                                                    {tool.get}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="mt-12 flex flex-wrap items-center gap-4">
                            <a
                                href="/studio"
                                className="group inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                            >
                                Open Creator Studio
                                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
                            </a>
                            <p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">
                                The Studio tools run on built-in engines that work offline.
                                Where a free AI tier is configured, they can enhance the
                                output — and it is always labelled when they do.
                            </p>
                        </div>
                    </div>
                </section>

                {/* ── Pricing teaser ───────────────────────────────── */}
                <section className="border-t border-border">
                    <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-6 px-6 py-16 lg:px-10 lg:py-24">
                        <div className="max-w-2xl">
                            <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                                Simple, honest pricing
                            </h2>
                            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                                Self-host open-autoDM free on your own infrastructure — or
                                take a hosted plan when you would rather have it managed for
                                you. No per-seat pricing either way.
                            </p>
                        </div>
                        <a
                            href="/pricing"
                            className="group inline-flex h-11 items-center gap-2 rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                        >
                            See pricing
                            <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
                        </a>
                    </div>
                </section>

                {/* ── Final CTA ────────────────────────────────────── */}
                <section className="border-t border-border">
                    <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10 lg:py-24">
                        <div className="mx-auto max-w-2xl text-center">
                            <h2 className="font-heading text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">
                                Ready to turn comments into customers?
                            </h2>
                            <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
                                Sign in to your console, or run your own instance — the
                                code is open-source and MIT licensed.
                            </p>
                            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                                <a
                                    href="/login"
                                    className="group inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                                >
                                    Get started
                                    <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
                                </a>
                                <a
                                    href="/login"
                                    className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                                >
                                    Sign in
                                </a>
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
    );
}
