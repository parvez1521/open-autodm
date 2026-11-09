"use client";

/**
 * FaqSection — landing-page FAQ accordion (design pass, 2026-11-07).
 *
 * Real buttons with aria-expanded; the answer panel animates its
 * height with the shared motion system (motion pass, 2026-11-08 —
 * previously the grid-rows trick). Answers stay strictly
 * product-truthful: the Free plan needs no card, the Meta
 * app is the user's own with exactly three permissions, data lives
 * encrypted at rest in the hosted database, and sending caps are
 * the shipped ones. (Reworded 2026-11-10 by owner directive:
 * hosted-service framing only — the banned terms are pinned in
 * tests/owner-directive-2026-11-10.test.ts.)
 */

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown } from "@/components/phosphor";
import { EASE_OUT, SPRING_SNAPPY } from "@/lib/motion/presets";

/**
 * Exported (SEO pass, 2026-11-10): the landing page builds its
 * FAQPage JSON-LD from this exact list, so the schema always
 * mirrors the visible answers word for word.
 */
export const FAQS = [
  {
    q: "Is open-autoDM really free?",
    a: "Yes — the Free plan costs nothing and needs no card, with comment-to-DM automations and the limited Creator Studio. Paid plans add more Instagram accounts and higher allowances, and every paid plan starts with a 15-day free trial, no card upfront.",
  },
  {
    q: "Do I need my own Meta app?",
    a: "Yes. The automation runs on your own Meta app, with exactly three Instagram permissions: basic profile access, managing messages and managing comments. Nothing runs on someone else's app, and no extra permissions are requested.",
  },
  {
    q: "Where does my audience data live?",
    a: "Inside open-autoDM's hosted database, encrypted at rest. Instagram access tokens are encrypted with AES-256-GCM before they are stored, and your audience data is never sold or shared with third parties.",
  },
  {
    q: "What stops an account from being flagged for spam?",
    a: "Hard caps are built into the sender, not left to discipline: at most 180 DMs per hour, the 24-hour messaging window is checked before every send, and each person gets at most one DM per automation per day. A traffic guard pauses sending automatically when volume spikes.",
  },
  {
    q: "Can I use just the Creator Studio?",
    a: "Yes. The Studio's ten tools — niche research, ideas, scripts, voiceover, transcripts, presentations, SEO, prompts, stock and projects — run on built-in engines in your browser and work offline. Where a free AI tier is configured, a tool can enhance its output, and the result is always labelled when it does.",
  },
] as const;

export function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="border-t border-border">
      {FAQS.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q} className="border-b border-border">
            <h3>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
                aria-controls={`faq-panel-${i}`}
                className="flex w-full items-center justify-between gap-4 py-5 text-left"
              >
                <span className="font-heading text-[15px] font-semibold text-foreground">
                  {item.q}
                </span>
                <motion.span
                  aria-hidden
                  className="inline-flex shrink-0"
                  animate={{ rotate: isOpen ? 180 : 0 }}
                  transition={SPRING_SNAPPY}
                >
                  <CaretDown className="h-4 w-4 text-muted-foreground" />
                </motion.span>
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  key="panel"
                  id={`faq-panel-${i}`}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.34, ease: EASE_OUT }}
                  className="overflow-hidden"
                >
                  <p className="max-w-3xl pb-5 text-sm leading-relaxed text-muted-foreground">
                    {item.a}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
