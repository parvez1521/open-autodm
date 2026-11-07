"use client";

/**
 * Creator Studio — Prompt Library (Programme S1).
 *
 * Original prompts authored for this product. Search + category
 * filters, one-click copy, and a "Copy & open" hand-off into the
 * Studio tool a prompt pairs with.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LibraryBig, ArrowUpRight } from "lucide-react";
import { PROMPT_CATEGORIES, searchPrompts } from "@/lib/studio/prompts";
import { getBrowserHandoffStore } from "@/lib/studio/handoff";
import type { PromptCategory } from "@/lib/studio/types";
import { CopyButton, studioCardClass, studioInputClass } from "@/components/studio/ui";
import { cn } from "@/lib/utils";

type Filter = PromptCategory | "All";

export default function PromptLibraryPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const results = useMemo(() => searchPrompts(query, filter), [query, filter]);

  const HANDOFF_TARGETS = {
    ideas: { href: "/studio/ideas", label: "Next Video Ideas" },
    seo: { href: "/studio/seo", label: "SEO Workspace" },
    script: { href: "/studio/script", label: "Script Builder" },
    thumbnail: { href: "/studio/thumbnail", label: "Thumbnail Editor" },
  } as const;

  const copyAndOpen = async (promptText: string, target: keyof typeof HANDOFF_TARGETS) => {
    try {
      await navigator.clipboard.writeText(promptText);
    } catch {
      // Clipboard unavailable — still navigate; the prompt stays visible here.
    }
    if (target === "thumbnail") {
      // The editor prefills its AI-image prompt from the hand-off, so
      // the "image-generation prompt" workflow lands ready to refine.
      getBrowserHandoffStore().setThumbnail({ promptText, from: "Prompt Library" });
    }
    router.push(HANDOFF_TARGETS[target].href);
  };

  return (
    <div className="space-y-5">
      <div className={studioCardClass}>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <LibraryBig className="w-4.5 h-4.5" /> Prompt Library
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Prompts written for creator work. Fill in the [bracketed] parts, then paste into
          any AI chat tool — or use the hand-off to open the matching Studio tool.
        </p>
        <div className="mt-4">
          <input
            className={studioInputClass}
            placeholder="Search prompts — try “hook”, “thumbnail”, “brand”…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search prompts"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["All", ...PROMPT_CATEGORIES] as Filter[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs transition-colors",
                filter === c
                  ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {results.length} prompt{results.length === 1 ? "" : "s"}
        {filter !== "All" ? ` in ${filter}` : ""}
        {query.trim() ? ` matching “${query.trim()}”` : ""}
      </p>

      <ul className="grid gap-3 sm:grid-cols-2">
        {results.map((p) => (
          <li key={p.id} className={cn(studioCardClass, "flex flex-col")}>
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {p.category}
              </span>
              <CopyButton text={p.prompt} />
            </div>
            <p className="mt-2 text-sm font-medium">{p.title}</p>
            <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {p.prompt}
            </p>
            {p.useIn && (
              <button
                type="button"
                onClick={() => copyAndOpen(p.prompt, p.useIn!)}
                className="mt-3 inline-flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
              >
                Copy & open {HANDOFF_TARGETS[p.useIn].label}
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {results.length === 0 && (
        <div className={cn(studioCardClass, "text-center text-sm text-muted-foreground")}>
          No prompts match that search. Try a broader word, or clear the category filter.
        </div>
      )}
    </div>
  );
}
