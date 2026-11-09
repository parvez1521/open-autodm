/**
 * BrandWave — the three-bar wave from the reference logo motif
 * (adopted 2026-11-09), used where a page-level loader already
 * exists (Suspense fallbacks, analytics' loading state) in place
 * of the generic spinner. Bars are the palette: obsidian, orange,
 * emerald. Animation is the .ce-wave CSS in globals.css —
 * transform-only, and the global reduced-motion rule stills it.
 */

import { cn } from "@/lib/utils";

export function BrandWave({ className }: { className?: string }) {
  return (
    <span className={cn("ce-wave h-5 gap-[3px]", className)} role="status" aria-label="Loading">
      <span className="w-[3px] bg-obsidian" style={{ height: "62%" }} />
      <span className="w-[3px] bg-orange-accent" style={{ height: "100%" }} />
      <span className="w-[3px] bg-emerald-accent" style={{ height: "80%" }} />
    </span>
  );
}
