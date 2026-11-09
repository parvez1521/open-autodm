"use client";

import { useEffect, useState } from "react";
import { LogoMark } from "@/components/ui/Logo";
import { BrandWave } from "@/components/ui/BrandWave";

/**
 * Brand intro — the reference's brand-moment concept, adopted
 * 2026-11-09 and compressed to the owner's ~1.2s cap.
 *
 * A cream sheet carrying the wordmark plays once per session on
 * the landing, then lifts and releases the hero's [data-hero]
 * entrance (globals.css holds it paused until html.ce-out). All
 * timing lives in the pre-paint gate script (components/home/
 * intro.ts) plus the fallback timers below: the sheet is
 * display:none unless the script set data-intro="play", .ce-out
 * is forced on a cap even if hydration never happens, and
 * reduced-motion / coarse-pointer visitors never see it at all.
 * It can never trap the page.
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
    const out = setTimeout(() => html.classList.add("ce-out"), 1100);
    const off = setTimeout(() => setGone(true), 1800);
    return () => {
      clearTimeout(out);
      clearTimeout(off);
    };
  }, []);

  if (gone) return null;
  return (
    <div className="oadm-intro" aria-hidden>
      <div data-sheet>
        <div data-inner className="grid h-full place-items-center px-6">
          <div className="flex flex-col items-center gap-4">
            <span className="flex items-center gap-3">
              <LogoMark className="h-11 w-11" />
              <span className="font-heading text-4xl font-extrabold leading-none tracking-tight text-foreground">
                open-<span className="font-accent font-normal italic">autoDM</span>
              </span>
            </span>
            <BrandWave className="h-4" />
          </div>
        </div>
      </div>
    </div>
  );
}
