"use client";

/**
 * Shared motion primitives (motion pass, owner instruction
 * 2026-11-08 ~17:59 IST) — the client components of the motion
 * system whose data half lives in src/lib/motion/presets.ts.
 *
 *  - ScrollProgress: the motion.dev signature — a hairline at the
 *    very top of the viewport whose scaleX tracks page scroll,
 *    sprung so it trails the scroll a fraction. Window-scroll
 *    surfaces only (landing, (saas) shell); the (main) console
 *    scrolls inside <main> and does not use it.
 *  - PageTransition: route content arrives with the shared
 *    fade-slide whenever the pathname changes. No exit animation —
 *    the old page leaves instantly, so navigation never waits.
 *  - FadeIn: one-shot entrance for server-rendered pages (auth
 *    screens) that cannot host their own motion components.
 *  - Stagger / StaggerItem: while-in-view stagger groups for app
 *    pages (dashboard, Studio home, billing plans).
 *
 * All of them render statically under prefers-reduced-motion.
 */

import { motion, useReducedMotion, useScroll, useSpring } from "motion/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { EASE_OUT, fadeUp, pageVariants, staggerParent } from "@/lib/motion/presets";

export function ScrollProgress() {
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 26, mass: 0.4 });
  if (reduced) return null;
  return (
    <motion.div
      aria-hidden
      className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left bg-primary"
      style={{ scaleX }}
    />
  );
}

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduced = useReducedMotion();
  if (reduced) return <div className="min-h-full">{children}</div>;
  return (
    <motion.div
      key={pathname}
      className="min-h-full"
      variants={pageVariants}
      initial="hidden"
      animate="show"
    >
      {children}
    </motion.div>
  );
}

export function FadeIn({
  children,
  className,
  delay = 0,
  x = 0,
  y = 18,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  x?: number;
  y?: number;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, x, y }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.6, delay, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

export function Stagger({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={staggerParent}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-6% 0px -6% 0px" }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={fadeUp}>
      {children}
    </motion.div>
  );
}
