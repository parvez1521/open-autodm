"use client";

/**
 * Reveal / RevealRule / Parallax — the landing's scroll-motion kit
 * (design pass round 5, 2026-11-08).
 *
 * The owner asked for a proper motion-graphics feel on the landing:
 * sections should arrive choreographed, not just fade. These helpers
 * give every section the same entrance language — content rises and
 * settles on an editorial ease, header rules grow from the left,
 * photographs drift a few pixels against the scroll (parallax).
 *
 * Motion law still applies: no glass, no glow. Transform/opacity
 * only, runs once per element, and collapses to a static render
 * under prefers-reduced-motion (the root providers also mount
 * MotionConfig reducedMotion="user" as a second layer).
 *
 * Motion pass (owner instruction 2026-11-08 ~17:59 IST): the kit
 * now draws its ease from the shared motion system
 * (src/lib/motion/presets.ts) on the `motion` package, and card
 * hover lift / button press springs are permitted via that system —
 * the old no-hover-transform rule was superseded by the owner.
 */

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef, type ReactNode } from "react";
import { EASE_OUT } from "@/lib/motion/presets";

const EASE = EASE_OUT;

export function Reveal({
  children,
  className,
  delay = 0,
  y = 12,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      // Fail-visible (2026-11-09, live-QA fix): sections used to sit
      // at opacity 0 until a -8% viewport threshold fired, leaving
      // blank gaps at the page bottom and a ghosted first paint.
      // Reveals now start near-visible (0.3), rise only 12px, fire
      // on first contact with the viewport, and settle in 0.45s —
      // readable at every instant, animated or not.
      initial={{ opacity: 0.3, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px" }}
      transition={{ duration: 0.45, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** A hairline that grows from the left as its section arrives. */
export function RevealRule({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return <span aria-hidden className={`block h-px bg-foreground/60 ${className ?? ""}`} />;
  return (
    <motion.span
      aria-hidden
      className={`block h-px origin-left bg-foreground/60 ${className ?? ""}`}
      initial={{ scaleX: 0 }}
      whileInView={{ scaleX: 1 }}
      viewport={{ once: true, margin: "0px" }}
      transition={{ duration: 0.5, ease: EASE }}
    />
  );
}

/** A gentle counter-scroll drift for editorial figures (±amount px). */
export function Parallax({
  children,
  className,
  amount = 14,
}: {
  children: ReactNode;
  className?: string;
  amount?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [amount, -amount]);
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div ref={ref} style={{ y }} className={className}>
      {children}
    </motion.div>
  );
}
