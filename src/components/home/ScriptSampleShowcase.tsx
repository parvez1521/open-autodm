"use client";

/**
 * ScriptSampleShowcase — the homepage's Script Writer example output,
 * played back at its own timestamps (Programme 27).
 *
 * The static card it replaces showed three timestamped sections of a
 * sample script. This version makes the sample demonstrate the thing
 * the copy claims — timestamped pacing: while the card is on screen,
 * the sections light up in order, each held for a duration scaled
 * from its own timestamp span, with a segmented progress rail under
 * the card (the PipelineShowcase pattern). Every control is real:
 * click any section to jump to that beat (which pauses, so the beat
 * can actually be read), hover pauses, keyboard focus within the
 * card pauses too (Programme 28), and an explicit Pause/Play
 * button stops the loop persistently. Progress is state-driven
 * (Programme 28): a single requestAnimationFrame clock drives both
 * the beat timer and the pacing rail, so on any pause the rail
 * freezes at its elapsed fraction and playback resumes from that
 * held fraction rather than restarting the beat or racing the
 * segment to full. With prefers-reduced-motion
 * nothing auto-plays — the sections stay fully visible and only
 * respond to clicks.
 *
 * The sample content is the same illustrative example the static card
 * carried (labelled "Example output"); no claim, statistic, or
 * testimonial is added.
 */

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

const SAMPLE_SECTIONS = [
    {
        time: "0–3s",
        label: "Hook",
        spoken: "Paid tools pe paise waste karna band karo — ye 3 websites bilkul free hain.",
        // Scaled from the section's own 3-second span.
        holdMs: 3000,
    },
    {
        time: "8–15s",
        label: "Value",
        spoken: "Pehli website tumhare notes ko flashcards aur quiz me badal deti hai. Revision 10x fast, bina extra app ke.",
        // The section spans 7 seconds of speech; the playback caps the
        // hold at 4.2s so the sample stays a sample.
        holdMs: 4200,
    },
    {
        time: "27–30s",
        label: "CTA",
        spoken: "Teeno ke links chahiye to comment me LINK likho, DM me bhej dunga.",
        holdMs: 3000,
    },
] as const;

export function ScriptSampleShowcase() {
    const [active, setActive] = useState(0);
    const [hovering, setHovering] = useState(false);
    const [focusWithin, setFocusWithin] = useState(false);
    const [inView, setInView] = useState(false);
    const [reduced, setReduced] = useState(false);
    const [userPaused, setUserPaused] = useState(false);
    const [progress, setProgress] = useState(0);
    const progressRef = useRef(0);
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
            threshold: 0.3,
        });
        io.observe(el);
        return () => io.disconnect();
    }, []);

    const playing = inView && !hovering && !focusWithin && !reduced && !userPaused;
    useEffect(() => {
        if (!playing) return;
        const hold = SAMPLE_SECTIONS[active]!.holdMs;
        const start = performance.now() - progressRef.current * hold;
        let raf = 0;
        const tick = (t: number) => {
            const f = (t - start) / hold;
            if (f >= 1) {
                progressRef.current = 0;
                setProgress(0);
                setActive((a) => (a + 1) % SAMPLE_SECTIONS.length);
                return;
            }
            progressRef.current = f;
            setProgress(f);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [playing, active]);

    return (
        <div
            ref={rootRef}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
            onFocus={() => setFocusWithin(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false); }}
            className="rounded-xl border border-border bg-card p-6"
        >
            <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-foreground">
                    3 free AI websites — student edition
                </h3>
                <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">Example output</span>
                    {!reduced && (
                        <button
                            type="button"
                            onClick={() => setUserPaused((p) => !p)}
                            aria-pressed={userPaused}
                            aria-label={userPaused ? "Play the script pacing demo" : "Pause the script pacing demo"}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        >
                            {userPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                            {userPaused ? "Play" : "Pause"}
                        </button>
                    )}
                </span>
            </div>

            <div className="mt-5 space-y-1.5">
                {SAMPLE_SECTIONS.map((s, i) => {
                    const isActive = i === active;
                    return (
                        <button
                            key={s.time}
                            type="button"
                            onClick={() => {
                                setActive(i);
                                progressRef.current = 0;
                                setProgress(0);
                                setUserPaused(true);
                            }}
                            aria-current={isActive ? "true" : undefined}
                            className={`flex w-full gap-3.5 rounded-lg px-2 py-2 text-left transition-colors duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                                isActive ? "bg-primary/5" : "hover:bg-muted/50"
                            }`}
                        >
                            <span
                                className={`h-fit shrink-0 rounded-md px-2 py-1 font-mono text-[11px] font-medium transition-colors duration-300 ${
                                    isActive
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-muted text-foreground"
                                }`}
                            >
                                {s.time}
                            </span>
                            <span className="min-w-0">
                                <span
                                    className={`block text-xs font-medium transition-colors duration-300 ${
                                        isActive ? "text-primary" : "text-muted-foreground"
                                    }`}
                                >
                                    {s.label}
                                </span>
                                <span className="mt-0.5 block text-sm leading-relaxed text-foreground">
                                    {s.spoken}
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Pacing rail: one segment per beat; the active segment's
                fill is the state-driven progress fraction, so it holds
                its position whenever playback pauses. */}
            <div className="mt-5 flex gap-1.5" aria-hidden="true">
                {SAMPLE_SECTIONS.map((s, i) => (
                    <span key={s.time} className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        {i <= active && (
                            <span
                                style={{ transform: `scaleX(${i < active ? 1 : reduced ? 1 : progress})` }}
                                className="absolute inset-0 origin-left bg-primary"
                            />
                        )}
                    </span>
                ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
                <span className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground">
                    Comment &quot;LINK&quot;
                </span>
                <span className="text-xs text-muted-foreground">
                    The keyword becomes the automation trigger
                </span>
            </div>
        </div>
    );
}
