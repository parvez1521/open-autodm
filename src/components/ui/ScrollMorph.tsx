"use client";

/**
 * ScrollMorph - site-wide scroll reveals, ported from SwitchRoute.
 *
 * The style is SwitchRoute's live V2 "Scale-Up Rotate" (PR #64, merge
 * 021fb11): a block starts smaller, lower and tilted and settles to
 * full size and level as it enters the viewport. Since 2026-11-09
 * the start state is the fail-visible tuning in globals.css
 * (opacity 0.3, translateY(12px) scale(0.94) rotate(-1.5deg)) — same
 * morph read, but content is never unreadable while waiting.
 *
 * Adaptation for open-autoDM: the dashboard does not scroll the window.
 * <main> is the scroll container (overflow-y-auto inside a 100vh flex
 * shell), so the IntersectionObserver is rooted on <main>, not the
 * viewport. The login page (src/app/page.tsx) is outside this layout
 * and keeps its own motion-package entrance - it is never touched.
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

    // The dashboard scrolls inside <main>; the homepage scrolls the window.
    // Observe against <main> only when it is the actual scroll container,
    // otherwise the viewport is the root.
    const mainStyle = window.getComputedStyle(main);
    const mainScrolls =
      (mainStyle.overflowY === "auto" || mainStyle.overflowY === "scroll") &&
      main.scrollHeight > main.clientHeight;
    const root: Element | null = mainScrolls ? main : null;

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
          window.setTimeout(() => el.classList.add("is-settled"), 550 + delay);
        }
      },
      // Fire on first contact (2026-11-09 fail-visible tuning): no
      // threshold/rootMargin holding below-fold blocks back.
      { root, threshold: 0, rootMargin: "0px" },
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
