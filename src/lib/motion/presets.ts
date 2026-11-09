/**
 * Shared motion system (motion pass, owner instruction
 * 2026-11-08 ~17:59 IST).
 *
 * The owner found the site's UI/motion unsatisfying and ordered
 * motion.dev-style animation (the `motion` package, imported as
 * "motion/react") across the WHOLE site, not one-off effects per
 * page. Every animated surface now draws from these presets so the
 * site moves with one language:
 *
 *  - one editorial ease (EASE_OUT) for entrances and reveals,
 *  - three springs: SOFT for panels and large elements, SNAPPY for
 *    cards and indicators, PRESS for buttons and controls,
 *  - shared variants for fade-up entrances, stagger groups and
 *    route transitions.
 *
 * Law: transform/opacity only, nothing blocks interaction, and
 * every consumer collapses to a static render under
 * prefers-reduced-motion (MotionConfig reducedMotion="user" is
 * mounted in the root providers, plus per-component checks where a
 * component renders outside it).
 *
 * Pure data module (no JSX, no client directive) so pages that are
 * rendered by the no-JSX-transform test harness (e.g. /pricing) can
 * import it safely.
 */

import type { Transition, Variants } from "motion/react";

/** The site's entrance ease — fast start, long settle. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Symmetric ease for exit/enter pairs (accordions, price flips). */
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

/** Large panels and page-scale elements: slow, weighty, no bounce. */
export const SPRING_SOFT: Transition = { type: "spring", stiffness: 90, damping: 20, mass: 0.9 };

/** Cards, pills and indicators: quick with a clean settle. */
export const SPRING_SNAPPY: Transition = { type: "spring", stiffness: 320, damping: 28 };

/** Buttons and controls under the finger: near-instant response. */
export const SPRING_PRESS: Transition = { type: "spring", stiffness: 480, damping: 30, mass: 0.7 };

/** Button press feedback — pair with `transition={SPRING_PRESS}`. */
export const PRESS_HOVER = { scale: 1.02 } as const;
export const PRESS_TAP = { scale: 0.96 } as const;

/** Card hover lift — pair with `transition={SPRING_SNAPPY}`. */
export const LIFT_HOVER = { y: -3 } as const;

/**
 * Standard entrance: rise and settle.
 *
 * Fail-visible tuning (2026-11-09, live-QA fix): entrances used to
 * start at opacity 0 with a 24px offset over 0.65s (+ stagger
 * delays), so a slow hydration or a delayed scroll-trigger left
 * pages blank/ghosted for seconds. Entrances now start NEAR-visible
 * (opacity 0.3, 10px) and settle in 0.45s: even if an animation is
 * interrupted, delayed, or never runs, the content stays readable
 * the whole time. The motion language is unchanged — same ease,
 * same rise — just never at the cost of visibility.
 */
export const fadeUp: Variants = {
  hidden: { opacity: 0.3, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
};

/** Crossfade-only entrance (skeleton-to-content swaps). */
export const fadeIn: Variants = {
  hidden: { opacity: 0.25 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE_OUT } },
};

/** Parent for staggered groups; children use `staggerChild`. */
export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0 } },
};

/** Child of a `staggerParent` group. */
export const staggerChild: Variants = fadeUp;

/** Route-content transition for the app shells: a short fade-slide.
 *  Fast and shallow on purpose — it must never feel like a wait.
 *  Starts near-visible (2026-11-09 fail-visible tuning, see fadeUp). */
export const pageVariants: Variants = {
  hidden: { opacity: 0.35, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } },
};
