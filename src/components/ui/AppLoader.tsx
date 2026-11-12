/**
 * AppLoader - the only loading screen in open-autoDM.
 *
 * Full-screen dark console, the old solid-orange logo, the open-autoDM
 * wordmark, and a sliding orange bar. There is no percentage, no
 * third-party name, and no EasyCaption/CaptionsEasy styling anywhere
 * in this repo - if a loader with another product's name ever shows
 * up in production, it is not coming from this codebase.
 */

import { cn } from "@/lib/utils";
import { LogoMark, LogoWordmark } from "./Logo";

export function AppLoader({
  compact = false,
  label = "Loading your console…",
}: {
  compact?: boolean;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "flex flex-col items-center justify-center gap-5 bg-background text-foreground",
        compact ? "w-full py-20" : "fixed inset-0 z-[300]"
      )}
    >
      <LogoMark className="h-11 w-11" />
      <LogoWordmark className="text-[15px]" />
      {/* Indeterminate orange bar - .loader-bar is defined in globals.css */}
      <div className="h-[3px] w-44 overflow-hidden rounded-full bg-muted">
        <div className="loader-bar h-full w-1/3 rounded-full bg-[#F97316]" />
      </div>
      <p className="text-[13px] text-muted-foreground">{label}</p>
    </div>
  );
}
