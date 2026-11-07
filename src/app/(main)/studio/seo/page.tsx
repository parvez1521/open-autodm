"use client";

/**
 * Creator Studio — SEO Workspace (Programme S1).
 *
 * Builds a publish-ready pack from the offline SEO engine: title
 * options with character counts, a structured description, and a tag
 * list sized to YouTube's ~500-character budget. Copy buttons
 * everywhere; the whole pack saves to Projects.
 */

import { useMemo, useState } from "react";
import { SearchCheck, Save, Check } from "lucide-react";
import { buildSeoPack } from "@/lib/studio/seoEngine";
import { STUDIO_CATEGORIES, type StudioCategory } from "@/lib/studio/types";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import {
  CopyButton,
  EngineBadge,
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioLabelClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

export default function SeoWorkspacePage() {
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState<StudioCategory>("Tech & AI Tools");
  const [keywords, setKeywords] = useState("");
  const [built, setBuilt] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pack = useMemo(
    () => (built && topic.trim() ? buildSeoPack({ topic, category, keywords }) : null),
    [built, topic, category, keywords]
  );

  const save = () => {
    if (!pack) return;
    try {
      getBrowserProjectStore().save({
        kind: "seo",
        title: `SEO pack: ${pack.topic}`,
        summary: `${pack.titles.length} titles · ${pack.tags.length} tags (${pack.tagsCharCount} chars)`,
        payload: pack,
      });
      setSaved(true);
      setSaveError(null);
    } catch {
      setSaved(false);
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={SearchCheck}
        title="SEO Workspace"
        purpose="Titles, a structured description and a right-sized tag list, ready to paste."
        points={[
          "Title options with character counts",
          "A structured description, ready to paste",
          "Tags sized to YouTube's ~500-character budget",
        ]}
      />
      <div className={studioCardClass}>
        <p className="text-[13px] text-muted-foreground">
          Turn a topic into a publish-ready pack: titles, a description and tags sized to
          platform limits. Works fully offline.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className={studioLabelClass} htmlFor="seo-topic">Video topic or working title</label>
            <input
              id="seo-topic"
              className={studioInputClass}
              placeholder="e.g. best free AI video tools"
              value={topic}
              onChange={(e) => {
                setTopic(e.target.value);
                setBuilt(false);
                setSaved(false);
              }}
              maxLength={120}
            />
          </div>
          <div>
            <label className={studioLabelClass} htmlFor="seo-category">Category</label>
            <select
              id="seo-category"
              className={studioInputClass}
              value={category}
              onChange={(e) => {
                setCategory(e.target.value as StudioCategory);
                setBuilt(false);
                setSaved(false);
              }}
            >
              {STUDIO_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={studioLabelClass} htmlFor="seo-keywords">Extra keywords (comma-separated, optional)</label>
            <input
              id="seo-keywords"
              className={studioInputClass}
              placeholder="e.g. no watermark, beginner friendly"
              value={keywords}
              onChange={(e) => {
                setKeywords(e.target.value);
                setBuilt(false);
                setSaved(false);
              }}
              maxLength={200}
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            className={studioPrimaryButtonClass}
            onClick={() => setBuilt(true)}
            disabled={!topic.trim()}
          >
            Build the pack
          </button>
          <EngineBadge engine="built-in" />
        </div>
      </div>

      {pack && (
        <>
          <div className={studioCardClass}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-medium">Title options</h3>
              <button
                type="button"
                onClick={save}
                disabled={saved}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors disabled:opacity-60"
              >
                {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                {saved ? "Saved to Projects" : "Save pack to Projects"}
              </button>
            </div>
            {saveError && (
              <p role="alert" className="mb-3 text-xs text-red-500">
                {saveError}
              </p>
            )}
            <ul className="divide-y divide-border">
              {pack.titles.map((t) => (
                <li key={t.title} className="py-2.5 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug">{t.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t.note}</p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums",
                      t.charCount > 100 ? "bg-rose-500/10 text-rose-500" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {t.charCount}/100
                  </span>
                  <CopyButton text={t.title} />
                </li>
              ))}
            </ul>
          </div>

          <div className={studioCardClass}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-medium">Description</h3>
              <CopyButton text={pack.description} label="Copy description" />
            </div>
            <pre className="whitespace-pre-wrap rounded-lg bg-muted/50 p-4 text-[13px] leading-relaxed font-sans">
              {pack.description}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              Replace the bracketed parts and timestamps with your real ones before publishing.
            </p>
          </div>

          <div className={studioCardClass}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-medium">
                Tags <span className="text-muted-foreground font-normal">— {pack.tags.length} tags, {pack.tagsCharCount}/500 characters</span>
              </h3>
              <CopyButton text={pack.tags.join(", ")} label="Copy tags" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pack.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
