"use client";

/**
 * FlowBuilder — "build your first automation" (design pass round 3,
 * 2026-11-07).
 *
 * Where DemoShowcase plays the loop back, this one hands over the
 * controls: the visitor types a trigger keyword, picks a public-reply
 * style and a DM payload, and the thread preview on the right updates
 * live — the exact texts their automation would send, generated from
 * their choices. Every string is a template the real product could
 * send; nothing is personalised with invented data.
 *
 * Motion: motion-package bubble entrances keyed by the current choice
 * (the house animation library, cf. PipelineShowcase). No hover
 * transforms.
 */

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChatCircle, Heart, Lightning, PaperPlaneTilt } from "@/components/phosphor";
import { cn } from "@/lib/utils";

type ReplyStyle = "friendly" | "short" | "hinglish";
type Payload = "link" | "pricing" | "demo";

const REPLIES: Record<ReplyStyle, { label: string; text: string }> = {
  friendly: {
    label: "Friendly",
    text: "Thanks for asking! Sent you the details in DM — check your inbox",
  },
  short: { label: "Short", text: "Check your DM" },
  hinglish: {
    label: "Hinglish",
    text: "Details DM kar diye hain — inbox check karlo",
  },
};

const PAYLOADS: Record<Payload, { label: string; comment: string; dm: string; card: string }> = {
  link: {
    label: "Send a link",
    comment: "Send the link please",
    dm: "Here is the link from the video — the full guide, step by step, with every tool it uses.",
    card: "The free guide — from the video",
  },
  pricing: {
    label: "Send pricing",
    comment: "Price please!",
    dm: "Here is the pricing breakdown from the video — every plan and what each one includes.",
    card: "Pricing — open-autoDM",
  },
  demo: {
    label: "Book a demo",
    comment: "Demo chahiye",
    dm: "Done — pick a slot that suits you and we will walk through the whole setup live, on your own account.",
    card: "Book a 15-minute demo",
  },
};

function sanitizeKeyword(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 14);
}

export function FlowBuilder() {
  const [keyword, setKeyword] = useState("PRICE");
  const [style, setStyle] = useState<ReplyStyle>("friendly");
  const [payload, setPayload] = useState<Payload>("link");
  const [like, setLike] = useState(true);

  const reply = REPLIES[style];
  const pack = PAYLOADS[payload];
  const shownKeyword = keyword || "KEYWORD";

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3.5">
        <p className="micro-label">Interactive · your choices, live preview</p>
      </div>

      <div className="grid lg:grid-cols-2">
        {/* Controls */}
        <div className="space-y-6 border-b border-border px-5 py-5 lg:border-b-0 lg:border-r">
          <div>
            <label htmlFor="fb-keyword" className="text-sm font-medium">
              1 · Trigger keyword
            </label>
            <input
              id="fb-keyword"
              value={keyword}
              onChange={(e) => setKeyword(sanitizeKeyword(e.target.value))}
              placeholder="PRICE"
              autoComplete="off"
              spellCheck={false}
              className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm uppercase tracking-widest outline-none focus:border-foreground/40"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              When a comment contains this word, the automation fires.
            </p>
          </div>

          <div>
            <p className="text-sm font-medium">2 · Public reply style</p>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Public reply style">
              {(Object.keys(REPLIES) as ReplyStyle[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStyle(key)}
                  aria-pressed={style === key}
                  className={cn(
                    "rounded-full border px-3.5 py-1.5 text-xs transition-colors",
                    style === key
                      ? "border-foreground bg-foreground font-medium text-background"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {REPLIES[key].label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-medium">3 · What the DM carries</p>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="DM payload">
              {(Object.keys(PAYLOADS) as Payload[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPayload(key)}
                  aria-pressed={payload === key}
                  className={cn(
                    "rounded-full border px-3.5 py-1.5 text-xs transition-colors",
                    payload === key
                      ? "border-foreground bg-foreground font-medium text-background"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {PAYLOADS[key].label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <p className="text-sm">
              <span className="font-medium">Also like the comment</span>
              <span className="block text-xs text-muted-foreground">
                A small thank-you before the reply lands.
              </span>
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={like}
              onClick={() => setLike((v) => !v)}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                like ? "bg-foreground" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-5 w-5 rounded-full bg-background transition-all",
                  like ? "left-[22px]" : "left-0.5",
                )}
              />
            </button>
          </div>
        </div>

        {/* Live preview */}
        <div className="flex flex-col px-5 py-5" aria-live="polite">
          <p className="micro-label">Live preview</p>

          <div className="mt-4 space-y-3">
            <div className="flex items-start gap-2.5 text-sm">
              <ChatCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="leading-relaxed">
                <span className="font-medium">@visitor</span> {pack.comment}{" "}
                <AnimatePresence mode="popLayout">
                  <motion.span
                    key={shownKeyword}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                    className="ml-1 inline-block rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary"
                  >
                    {shownKeyword}
                  </motion.span>
                </AnimatePresence>
              </p>
              {like && <Heart className="ml-auto h-4 w-4 shrink-0 text-primary" weight="fill" />}
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={style}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22 }}
                className="ml-6 border-l-2 border-primary/40 pl-3 text-sm"
              >
                <p className="leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">@creator</span> {reply.text}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <PaperPlaneTilt className="h-3.5 w-3.5" /> Direct message
            </p>
            <AnimatePresence mode="wait">
              <motion.div
                key={payload}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
                className="mt-3 space-y-3"
              >
                <div className="max-w-[92%] rounded-xl rounded-tl-sm border border-border bg-background px-3.5 py-3 text-sm leading-relaxed">
                  {pack.dm}
                </div>
                <div className="max-w-[92%] rounded-xl rounded-tl-sm border border-border bg-background px-3.5 py-3">
                  <p className="text-sm font-medium">{pack.card}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Attached to the DM</p>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          <p className="mt-auto flex items-center gap-1.5 pt-5 text-xs text-muted-foreground">
            <Lightning className="h-3.5 w-3.5" />
            Exactly what your automation sends — inside the caps: 180 DMs/hour, 24-hour window.
          </p>
        </div>
      </div>
    </div>
  );
}
