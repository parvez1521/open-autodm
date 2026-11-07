"use client";

/**
 * FaqSection — landing-page FAQ accordion (design pass, 2026-11-07).
 *
 * Real buttons with aria-expanded; the answer panel animates with the
 * grid-rows trick (no JS height measuring). Answers stay strictly
 * product-truthful: self-hosting is free and MIT-licensed, the Meta
 * app is the user's own with exactly three permissions, data lives in
 * the user's own database, sending caps are the shipped ones, and the
 * hosted plan is described as in preparation (it is DRAFT, unapproved
 * — the waitlist is the honest route to it).
 */

import { useState } from "react";
import { CaretDown } from "@/components/phosphor";
import { cn } from "@/lib/utils";

const FAQS = [
  {
    q: "Is open-autoDM really free?",
    a: "Self-hosting is free. The code is open-source under the MIT licence and runs on infrastructure you control — your own Meta app, database and domain. A hosted plan, for people who would rather have it managed, is in preparation; the waitlist below is how you hear about it first.",
  },
  {
    q: "Do I need my own Meta app?",
    a: "Yes. The automation runs on your own Meta app, with exactly three Instagram permissions: basic profile access, managing messages and managing comments. Nothing runs on someone else's app, and no extra permissions are requested.",
  },
  {
    q: "Where does my audience data live?",
    a: "In your own database, on your instance. Your access tokens are encrypted with a key only your deployment holds, and no third party — including us — holds your tokens or your audience data.",
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
                <CaretDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
            </h3>
            <div
              id={`faq-panel-${i}`}
              className={cn(
                "grid transition-[grid-template-rows] duration-300 ease-out",
                isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className="overflow-hidden">
                <p className="max-w-3xl pb-5 text-sm leading-relaxed text-muted-foreground">
                  {item.a}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
