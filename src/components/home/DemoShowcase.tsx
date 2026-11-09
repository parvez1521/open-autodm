"use client";

/**
 * DemoShowcase — an interactive comment-to-DM simulation for the
 * landing page (design pass, 2026-11-07).
 *
 * The visitor picks a keyword scenario and runs the flow: a comment
 * lands on a mock Reel, the automation matches the keyword, a public
 * reply is posted and the DM arrives — the product's core loop,
 * simulated entirely in the browser with product-truthful copy (the
 * same caps and shapes the real console uses; no invented data).
 *
 * Motion rules (house pattern, cf. PipelineShowcase): user-driven —
 * it runs on click, auto-runs once when scrolled into view, and
 * honours prefers-reduced-motion by showing the finished state with
 * no staged animation. No hover transforms anywhere.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChatCircle,
  Check,
  PaperPlaneTilt,
  Play,
  ArrowClockwise,
} from "@/components/phosphor";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";

type Stage = 0 | 1 | 2 | 3 | 4; // idle, comment, matched, reply, dm(done)

interface Scenario {
  keyword: string;
  comment: string;
  dmBody: string;
  dmCardTitle: string;
  dmCardMeta: string;
}

const SCENARIOS: Scenario[] = [
  {
    keyword: "PRICE",
    comment: "Price please!",
    dmBody:
      "Hi! Here is the pricing breakdown from the video — every plan, Free included, is listed on the pricing page.",
    dmCardTitle: "Pricing — open-autoDM",
    dmCardMeta: "Plans and what each one includes",
  },
  {
    keyword: "LINK",
    comment: "Send the link",
    dmBody:
      "Here is the link from the video — the free deployment guide, step by step, with every tool it uses.",
    dmCardTitle: "Launch your app for free — the guide",
    dmCardMeta: "Step-by-step, no paid tools",
  },
  {
    keyword: "DEMO",
    comment: "Demo chahiye",
    dmBody:
      "Done — pick a slot that suits you and we will walk through the whole setup live, on your own account.",
    dmCardTitle: "Book a 15-minute demo",
    dmCardMeta: "Live walkthrough, your questions",
  },
];

const STAGE_LABELS = ["Comment lands", "Keyword matched", "Reply + DM sent"] as const;

function stageLabel(stage: Stage): number {
  if (stage <= 1) return 0;
  if (stage === 2) return 1;
  return 2;
}

export function DemoShowcase() {
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [stage, setStage] = useState<Stage>(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoRan = useRef(false);

  const scenario = SCENARIOS[scenarioIdx]!;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const run = () => {
    clearTimers();
    if (reduced) {
      setStage(4);
      return;
    }
    setStage(1);
    timers.current.push(setTimeout(() => setStage(2), 900));
    timers.current.push(setTimeout(() => setStage(3), 1900));
    timers.current.push(setTimeout(() => setStage(4), 2800));
  };

  const pick = (idx: number) => {
    clearTimers();
    setScenarioIdx(idx);
    setStage(0);
  };

  // Auto-run the first scenario once, when the panel scrolls into view.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || autoRan.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !autoRan.current) {
          autoRan.current = true;
          run();
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => clearTimers, []);

  const activeStep = stageLabel(stage);
  const done = stage === 4;

  return (
    <div ref={rootRef} className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Panel header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <p className="micro-label">Simulation · runs in your browser</p>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Keyword scenarios">
          {SCENARIOS.map((s, i) => (
            <button
              key={s.keyword}
              type="button"
              onClick={() => pick(i)}
              aria-pressed={i === scenarioIdx}
              className={cn(
                "rounded-full border px-3 py-1 font-mono text-[11px] tracking-wide transition-colors",
                i === scenarioIdx
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {s.keyword}
            </button>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* Comment side */}
        <div className="border-b border-border px-5 py-5 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground font-heading text-[13px] font-semibold text-background">
              C
            </span>
            <div>
              <p className="text-sm font-semibold leading-tight">@creator</p>
              <p className="text-xs text-muted-foreground">Reel · 3 free AI websites for students</p>
            </div>
          </div>

          <div className="mt-5 space-y-3" aria-live="polite">
            <div className="flex items-start gap-2.5 text-sm">
              <ChatCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">@earlier_fan</span> Second one is
                exactly what I needed
              </p>
            </div>

            <AnimatePresence>
            {stage >= 1 && (
              <motion.div
                key={`comment-${scenarioIdx}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 320, damping: 26 }}
                className="flex items-start gap-2.5 text-sm"
              >
                <ChatCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="leading-relaxed">
                  <span className="font-medium">@visitor</span> {scenario.comment}{" "}
                  <motion.span
                    animate={stage === 2 ? { scale: [1, 1.22, 1] } : { scale: 1 }}
                    transition={{ duration: 0.55, ease: "easeInOut" }}
                    className="ml-1 inline-block rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary"
                  >
                    {scenario.keyword}
                  </motion.span>
                </p>
              </motion.div>
            )}
            </AnimatePresence>

            <AnimatePresence>
            {stage >= 3 && (
              <motion.div
                key={`reply-${scenarioIdx}`}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="ml-6 flex items-start gap-2.5 border-l-2 border-primary/40 pl-3 text-sm"
              >
                <p className="leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">@creator</span> Sent you the
                  details in DM — check your inbox
                </p>
              </motion.div>
            )}
            </AnimatePresence>

            {stage === 0 && (
              <p className="text-sm text-muted-foreground">
                Press run — a visitor comments the keyword{" "}
                <span className="font-mono text-[12px] text-foreground">{scenario.keyword}</span>{" "}
                on the Reel.
              </p>
            )}
          </div>

          {/* Stage rail */}
          <ol className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4">
            {STAGE_LABELS.map((label, i) => {
              const reached = stage >= 1 && i <= activeStep;
              const complete = done || (stage >= 1 && i < activeStep);
              return (
                <li
                  key={label}
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    reached ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {complete ? (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <span className="font-mono text-[11px]">{String(i + 1).padStart(2, "0")}</span>
                  )}
                  {label}
                </li>
              );
            })}
          </ol>

          {/* Round 5: the run's progress, as a filling thread under the rail. */}
          <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-border" aria-hidden="true">
            <motion.span
              className="block h-full rounded-full bg-primary"
              initial={false}
              animate={{ width: `${(stage / 4) * 100}%` }}
              transition={{ duration: 0.6, ease: "easeInOut" }}
            />
          </div>
        </div>

        {/* DM side */}
        <div className="flex flex-col px-5 py-5">
          <p className="micro-label">Direct message</p>
          {stage >= 4 ? (
            <div className="mt-4 space-y-3">
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 26 }}
                className="max-w-[92%] rounded-xl rounded-tl-sm border border-border bg-background px-3.5 py-3 text-sm leading-relaxed"
              >
                {scenario.dmBody}
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 26, delay: 0.18 }}
                className="max-w-[92%] rounded-xl rounded-tl-sm border border-border bg-background px-3.5 py-3"
              >
                <p className="text-sm font-medium">{scenario.dmCardTitle}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{scenario.dmCardMeta}</p>
              </motion.div>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.38 }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <PaperPlaneTilt className="h-3.5 w-3.5" /> Sent automatically, inside the
                24-hour window
              </motion.p>
            </div>
          ) : (
            <div className="mt-4 flex flex-1 items-center">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {stage === 0
                  ? "The DM panel is empty. Run the flow and watch what the visitor receives."
                  : "Matching the keyword and preparing the message…"}
              </p>
            </div>
          )}

          <div className="mt-6 border-t border-border pt-4">
            <button
              type="button"
              onClick={run}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
            >
              {done || stage > 0 ? (
                <ArrowClockwise className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {done ? "Run it again" : stage > 0 ? "Restart the flow" : "Run the flow"}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
