"use client";

/** Small shared building blocks for Creator Studio pages (Programme S1). */

import { useState } from "react";
import { Check, Copy, Sparkles, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EngineLabel } from "@/lib/studio/types";

export function EngineBadge({ engine }: { engine: EngineLabel }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        engine === "free-ai"
          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : "border-border text-muted-foreground"
      )}
      title={
        engine === "free-ai"
          ? "Produced by a free AI model (Groq free tier)"
          : "Produced by Studio's built-in offline engine"
      }
    >
      {engine === "free-ai" ? <Sparkles className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
      {engine === "free-ai" ? "Free AI" : "Built-in engine"}
    </span>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard can be unavailable (permissions); fail quietly.
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export const studioInputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/40";

export const studioLabelClass = "block text-xs font-medium text-muted-foreground mb-1.5";

export const studioPrimaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50";

export const studioCardClass = "rounded-xl border border-border bg-card p-5";
