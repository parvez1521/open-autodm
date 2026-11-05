"use client";

/**
 * ScrollMorph - site-wide scroll reveals, ported from SwitchRoute.
 *
 * The style is SwitchRoute's live V2 "Scale-Up Rotate" (PR #64, merge
 * 021fb11): a block starts smaller, lower and tilted - translateY(30px)
 * scale(0.78) rotate(-5deg), opacity 0 - and settles to full size and
 * level as it enters the viewport.
 *
 * Adaptation for open-autoDM: the dashboard does not scroll the window.
 * <main> is the scroll container (overflow-y-auto inside a 100vh flex
 * shell), so the IntersectionObserver is rooted on <main>, not the
 * viewport. The login page (src/app/page.tsx) is outside this layout
 * and keeps its own Framer Motion entrance - it is never touched.
 *
 * Safety rails (same as SwitchRoute):
 * - The hidden state only exists on elements this component tags from
 *   JS, so no-JS rendering and prerendered snapshots always show content.
 * - prefers-reduced-motion disables the system entirely (checked here
 *   and again in CSS).
 * - Only the outermost block of a nested group is tagged, so nothing
 *   double-animates.
 * - After a block's reveal finishes it gets .is-settled, which swaps
 *   the morph transition for the short hover transition, so card hovers
 *   stay responsive instead of replaying the 0.65s morph curve.
 * - Anything marked data-no-reveal is never touched.
 */

import { useEffect } from "react";

const TARGET_SELECTOR = '[data-reveal], .bg-card, article, section';

export function ScrollMorph() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!("IntersectionObserver" in window)) return;

    const main = document.querySelector("main");
    if (!main) return;

    const tagged = new Set<Element>();
    const groupCounts = new Map<Element, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          observer.unobserve(el);
          el.classList.add("is-revealed");
          const delay = Number(el.dataset.revealDelay || 0);
          window.setTimeout(() => el.classList.add("is-settled"), 800 + delay);
        }
      },
      { root: main, threshold: 0.08, rootMargin: "0px 0px -4% 0px" },
    );

    const tag = (root: ParentNode) => {
      const candidates = root.querySelectorAll(TARGET_SELECTOR);
      candidates.forEach((el) => {
        if (tagged.has(el)) return;
        if (el.closest("[data-no-reveal]")) return;

        // Outermost only: skip anything inside an already-tagged block.
        let ancestor = el.parentElement;
        let nested = false;
        while (ancestor && ancestor !== main) {
          if (tagged.has(ancestor)) {
            nested = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        if (nested) return;

        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetHeight === 0) return;
        // Skip tiny inline blocks (chips, legend rows) - morphing them
        // looks jittery. Cards and sections are comfortably above this.
        if (htmlEl.offsetHeight < 40) return;

        const parent = el.parentElement;
        const index = parent ? groupCounts.get(parent) || 0 : 0;
        if (parent) groupCounts.set(parent, index + 1);
        const delay = Math.min(index, 6) * 60;
        htmlEl.dataset.revealDelay = String(delay);
        htmlEl.style.setProperty("--reveal-delay", `${delay}ms`);

        htmlEl.classList.add("morph-reveal");
        tagged.add(el);
        observer.observe(el);
      });
    };

    tag(main);

    // The router swaps page content inside <main> without remounting
    // this layout; watch for that and tag whatever arrives.
    let debounce = 0;
    const mutation = new MutationObserver(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => tag(main), 120);
    });
    mutation.observe(main, { childList: true, subtree: true });

    return () => {
      mutation.disconnect();
      observer.disconnect();
      window.clearTimeout(debounce);
    };
  }, []);

  return null;
}
