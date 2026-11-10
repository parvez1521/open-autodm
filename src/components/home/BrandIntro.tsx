"use client";

import { useEffect, useState } from "react";
import { LogoMark } from "@/components/ui/Logo";
import { IntroWorkflow } from "@/components/home/IntroWorkflow";

/**
 * Brand intro — the reference's brand-moment concept, adopted
 * 2026-11-09. Content changed 2026-11-10 (owner directive
 * ~02:19 IST): the three-bar wave under the wordmark read as
 * "music lines" and was rejected for a workflow animation;
 * reshaped again the same night (owner feedback ~02:44 IST —
 * the compact centered card read as too basic) into a wide
 * horizontal strip (components/home/IntroWorkflow.tsx: Comment
 * → AutoDM → DM panels entering one by one, left to right) and
 * the moment runs ~2.1s to fit the sequence.
 *
 * A dark sheet carrying the wordmark + the workflow strip plays
 * once per session on the landing, then lifts and releases the
 * hero's [data-hero] entrance (globals.css holds it paused until
 * html.ce-out). All timing lives in the pre-paint gate script
 * (components/home/intro.ts) plus the fallback timers below: the
 * sheet is display:none unless the script set data-intro="play",
 * .ce-out is forced on a cap even if hydration never happens,
 * and reduced-motion / coarse-pointer visitors never see it at
 * all. Clicking the sheet skips straight to the exit. It can
 * never trap the page.
 */
export function BrandIntro() {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    if (html.dataset.intro !== "play") {
      setGone(true);
      return;
    }
    // Fallbacks only — the gate script normally drives .ce-out.
    const out = setTimeout(() => html.classList.add("ce-out"), 2500);
    const off = setTimeout(() => setGone(true), 3400);
    return () => {
      clearTimeout(out);
      clearTimeout(off);
    };
  }, []);

  if (gone) return null;

  const skip = () => {
    document.documentElement.classList.add("ce-out");
    setTimeout(() => setGone(true), 700);
  };

  return (
    <div className="oadm-intro" aria-hidden>
      <div data-sheet onClick={skip} className="cursor-pointer">
        <div data-inner className="grid h-full place-items-center px-6">
          <div className="flex w-full flex-col items-center gap-6">
            <span className="flex items-center gap-3">
              <LogoMark className="h-11 w-11" />
              <span className="font-heading text-4xl font-extrabold leading-none tracking-tight text-foreground">
                open-<span className="font-accent font-normal italic">autoDM</span>
              </span>
            </span>
            <IntroWorkflow />
          </div>
        </div>
      </div>
    </div>
  );
}
