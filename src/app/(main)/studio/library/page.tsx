"use client";

/**
 * Creator Studio — Stock Libraries + Meme Library (Programme S3).
 *
 * Four tabs, driven by ?tab= (images | videos | audio | memes):
 *  - Stock Images / Stock Videos search Pexels through the app's own
 *    route. Results are REFERENCES — "search → use in this project" —
 *    because the Pexels terms require a prominent Pexels link +
 *    photographer credit and prohibit standalone redistribution. The
 *    Studio never hosts copies of stock files.
 *  - Stock Audio searches Openverse (keyless, commercially-usable
 *    licences only, per-item credit + licence kept on every row).
 *  - Meme Library is a view over the user's own Projects tagged
 *    "meme" — the Studio does not scrape meme libraries.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BookmarkSimple,
  Check,
  CaretLeft,
  CaretRight,
  ArrowSquareOut,
  Smiley,
  Images,
  CircleNotch,
  MusicNote,
  MagnifyingGlass,
  Play,
  Waveform,
} from "@/components/phosphor";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import { filterMemeProjects } from "@/lib/studio/memes";
import { PEXELS_LICENSE_URL, PEXELS_PROVIDER_URL, type StockSearchItem } from "@/lib/studio/pexels";
import type { StockAudioItem } from "@/lib/studio/openverse";
import {
  searchOpenverseAudio,
  searchPexels,
  type StockDegradation,
} from "@/lib/studio/stockClient";
import {
  SOUND_EFFECT_CATEGORIES,
  filterSoundEffects,
  myinstantsSearchUrl,
} from "@/lib/studio/soundEffects";
import type {
  StockReferencePayload,
  StudioProject,
  ThumbnailProjectPayload,
} from "@/lib/studio/types";
import {
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

type LibraryTab = "images" | "videos" | "audio" | "sounds" | "memes";

const TABS: { id: LibraryTab; label: string }[] = [
  { id: "images", label: "Stock Images" },
  { id: "videos", label: "Stock Videos" },
  { id: "audio", label: "Stock Audio" },
  { id: "sounds", label: "Sound Effects" },
  { id: "memes", label: "Meme Library" },
];

function parseTab(raw: string | null): LibraryTab {
  if (raw === "videos" || raw === "audio" || raw === "sounds" || raw === "memes") return raw;
  return "images";
}

function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const PEXELS_NOTES: Partial<Record<StockDegradation, string>> = {
  quota_reached:
    "Pexels has reached its free quota for now, so search is paused. The quota is shared across the whole app, try again later.",
  rate_limited: "Too many searches in a minute, wait a moment and try again.",
  daily_quota_reached: "You have reached today's per-user search limit. Try again tomorrow.",
  provider_unavailable: "Pexels did not respond just now. Try again in a moment.",
  signed_out: "Sign in again to search stock, anything you saved to Projects on this device is unaffected.",
};

const AUDIO_NOTES: Partial<Record<StockDegradation, string>> = {
  quota_reached:
    "The free stock-audio quota is used up for today. The free tier is one small shared pool (about 200 requests a day), so search pauses until it resets. Try again tomorrow.",
  rate_limited: "Too many searches in a minute, wait a moment and try again.",
  daily_quota_reached: "You have reached today's per-user search limit. Try again tomorrow.",
  provider_unavailable: "Openverse did not respond just now. Try again in a moment.",
  signed_out: "Sign in again to search stock audio, anything you saved to Projects on this device is unaffected.",
};

const NOT_CONFIGURED_TEXT =
  "This tab searches Pexels. It needs a free Pexels API key, which the workspace owner adds as PEXELS_API_KEY. Until then the tab can't search, and no placeholder photos are shown, because presenting other images as stock results would be misleading.";

// ── Pexels (images / videos) ───────────────────────────────────────

function PexelsPanel({ media }: { media: "image" | "video" }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"initial" | "ok" | StockDegradation>("initial");
  const [items, setItems] = useState<StockSearchItem[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  const runSearch = async (q: string, p: number) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setQuery(trimmed);
    setPage(p);
    const outcome = await searchPexels({ media, query: trimmed, page: p });
    setLoading(false);
    if (outcome.status === "ok") {
      setStatus("ok");
      setItems(outcome.items);
      setTotalResults(outcome.totalResults);
      setHasNext(outcome.hasNext);
    } else {
      setStatus(outcome.status);
      setItems([]);
      setHasNext(false);
    }
  };

  const submit = () => {
    void runSearch(input, 1);
  };

  const saveReference = (item: StockSearchItem) => {
    try {
      getBrowserProjectStore().save({
        kind: "stock",
        title: item.title,
        summary: `${media} · Pexels · by ${item.creator}`,
        payload: {
          source: "pexels",
          media,
          title: item.title,
          pageUrl: item.pageUrl,
          assetUrl: item.assetUrl,
          creator: item.creator,
          creatorUrl: item.creatorUrl,
          licenseName: "Pexels License",
          licenseUrl: PEXELS_LICENSE_URL,
        } satisfies StockReferencePayload,
      });
      setSavedIds((prev) => new Set(prev).add(item.id));
      setSaveError(null);
    } catch {
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  const creditPrefix = media === "image" ? "Photo by" : "Video by";

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
        Photos and videos provided by{" "}
        <a
          className="font-medium text-primary hover:underline"
          href={PEXELS_PROVIDER_URL}
          target="_blank"
          rel="noreferrer"
        >
          Pexels
        </a>
        {", free to use under the "}
        <a
          className="font-medium text-primary hover:underline"
          href={PEXELS_LICENSE_URL}
          target="_blank"
          rel="noreferrer"
        >
          Pexels licence
        </a>
        .
      </div>

      <div className={studioCardClass}>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <MagnifyingGlass className="w-4.5 h-4.5" /> Stock {media === "image" ? "Images" : "Videos"}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Search Pexels stock {media === "image" ? "photos" : "videos"}. Results are used as
          references in your projects: save a reference to Projects. The Studio does not
          host copies of the files; they stay on Pexels.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            className={studioInputClass}
            placeholder={
              media === "image" ? "e.g. desk setup, coffee, city skyline" : "e.g. ocean waves, typing, drone shot"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={100}
            aria-label={`Search Pexels ${media === "image" ? "images" : "videos"}`}
          />
          <button
            type="submit"
            className={cn(studioPrimaryButtonClass, "shrink-0")}
            disabled={!input.trim() || loading}
          >
            {loading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <MagnifyingGlass className="w-4 h-4" />}
            Search
          </button>
        </form>
      </div>

      {status === "initial" && !loading && (
        <div className={cn(studioCardClass, "text-center")}>
          <p className="text-sm font-medium">Search to see stock {media === "image" ? "photos" : "videos"}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Type a search above. Every result keeps its photographer credit and its link back
            to Pexels, and anything you save is stored as a reference, not as a hosted copy.
          </p>
        </div>
      )}

      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleNotch className="w-4 h-4 animate-spin" /> Searching Pexels…
        </p>
      )}

      {!loading && status === "not_configured" && (
        <div className={studioCardClass}>
          <p className="text-sm font-medium">Stock search is not configured yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">{NOT_CONFIGURED_TEXT}</p>
        </div>
      )}

      {!loading && status !== "initial" && status !== "ok" && status !== "not_configured" && (
        <p className="text-sm text-muted-foreground">{PEXELS_NOTES[status]}</p>
      )}

      {saveError && (
        <p role="alert" className="text-xs text-red-500">
          {saveError}
        </p>
      )}

      {!loading && status === "ok" && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No results for “{query}”, try a different search.
        </p>
      )}

      {!loading && status === "ok" && items.length > 0 && (
        <div>
          <p className="mb-3 text-[13px] text-muted-foreground">
            {totalResults} result{totalResults === 1 ? "" : "s"} for “{query}” · Page {page}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <li key={item.id} className={cn(studioCardClass, "flex flex-col p-3")}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.previewUrl}
                  alt={item.title}
                  className="aspect-video w-full rounded-lg border border-border object-cover"
                  loading="lazy"
                />
                <p className="mt-2.5 text-sm font-medium leading-snug">{item.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {creditPrefix}{" "}
                  {item.creatorUrl ? (
                    <a
                      className="text-primary hover:underline"
                      href={item.creatorUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.creator}
                    </a>
                  ) : (
                    item.creator
                  )}
                  {item.durationSec != null ? ` · ${formatDuration(item.durationSec)}` : ""}
                </p>
                <p className="mt-1">
                  <a
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    href={item.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Pexels <ArrowSquareOut className="w-3 h-3" />
                  </a>
                </p>
                <div className="mt-auto flex flex-wrap gap-2 pt-3">
                  <button
                    type="button"
                    onClick={() => saveReference(item)}
                    disabled={savedIds.has(item.id)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-60"
                  >
                    {savedIds.has(item.id) ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <BookmarkSimple className="w-3.5 h-3.5" />
                    )}
                    {savedIds.has(item.id) ? "Saved" : "Save reference"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => void runSearch(query, page - 1)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
            >
              <CaretLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <span className="text-xs text-muted-foreground">Page {page}</span>
            <button
              type="button"
              disabled={!hasNext || loading}
              onClick={() => void runSearch(query, page + 1)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
            >
              Next <CaretRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Openverse (audio) ──────────────────────────────────────────────

function AudioPanel() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"initial" | "ok" | StockDegradation>("initial");
  const [items, setItems] = useState<StockAudioItem[]>([]);
  const [resultCount, setResultCount] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  const runSearch = async (q: string, p: number) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setQuery(trimmed);
    setPage(p);
    const outcome = await searchOpenverseAudio({ query: trimmed, page: p });
    setLoading(false);
    if (outcome.status === "ok") {
      setStatus("ok");
      setItems(outcome.items);
      setResultCount(outcome.resultCount);
      setPageCount(outcome.pageCount);
    } else {
      setStatus(outcome.status);
      setItems([]);
    }
  };

  const saveReference = (item: StockAudioItem) => {
    try {
      getBrowserProjectStore().save({
        kind: "stock",
        title: item.title,
        summary: `audio · Openverse · by ${item.creator}`,
        payload: {
          source: "openverse",
          media: "audio",
          title: item.title,
          pageUrl: item.pageUrl,
          assetUrl: item.assetUrl,
          creator: item.creator,
          creatorUrl: item.creatorUrl,
          licenseName: item.licenseName,
          licenseUrl: item.licenseUrl,
        } satisfies StockReferencePayload,
      });
      setSavedIds((prev) => new Set(prev).add(item.id));
      setSaveError(null);
    } catch {
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  const hasNext = page < pageCount;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
        Audio from{" "}
        <a
          className="font-medium text-primary hover:underline"
          href="https://openverse.org"
          target="_blank"
          rel="noreferrer"
        >
          Openverse
        </a>
        {", every result is filtered to licences that allow commercial use, and each keeps its "}
        own credit and licence.
      </div>

      <div className={studioCardClass}>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <MusicNote className="w-4.5 h-4.5" /> Stock Audio
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Search openly licensed audio for beds, stingers and background tracks. Openverse
          does not verify the rights on each item, so check the licence on the item's page
          before publishing, the credit and licence shown here travel with anything you
          save.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(input, 1);
          }}
        >
          <input
            className={studioInputClass}
            placeholder="e.g. lo-fi beat, piano loop, rain ambience"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={100}
            aria-label="Search Openverse audio"
          />
          <button
            type="submit"
            className={cn(studioPrimaryButtonClass, "shrink-0")}
            disabled={!input.trim() || loading}
          >
            {loading ? <CircleNotch className="w-4 h-4 animate-spin" /> : <MagnifyingGlass className="w-4 h-4" />}
            Search
          </button>
        </form>
      </div>

      {status === "initial" && !loading && (
        <div className={cn(studioCardClass, "text-center")}>
          <p className="text-sm font-medium">Search to see stock audio</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Type a search above. Only licences that allow commercial use are shown, anything
            with a NonCommercial condition is excluded before it reaches this list.
          </p>
        </div>
      )}

      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleNotch className="w-4 h-4 animate-spin" /> Searching Openverse…
        </p>
      )}

      {!loading && status !== "initial" && status !== "ok" && (
        <p className="text-sm text-muted-foreground">{AUDIO_NOTES[status]}</p>
      )}

      {saveError && (
        <p role="alert" className="text-xs text-red-500">
          {saveError}
        </p>
      )}

      {!loading && status === "ok" && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No commercially usable results for “{query}”, try a different search.
        </p>
      )}

      {!loading && status === "ok" && items.length > 0 && (
        <div>
          <p className="mb-3 text-[13px] text-muted-foreground">
            {resultCount} result{resultCount === 1 ? "" : "s"} for “{query}” · Page {page} of{" "}
            {pageCount}
          </p>
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className={cn(studioCardClass, "p-4")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">{item.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      by{" "}
                      {item.creatorUrl ? (
                        <a
                          className="text-primary hover:underline"
                          href={item.creatorUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {item.creator}
                        </a>
                      ) : (
                        item.creator
                      )}
                      {item.durationSec != null ? ` · ${formatDuration(item.durationSec)}` : ""}
                    </p>
                  </div>
                  {item.licenseUrl ? (
                    <a
                      className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                      href={item.licenseUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.licenseName}
                    </a>
                  ) : (
                    <span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {item.licenseName}
                    </span>
                  )}
                </div>
                <audio controls preload="none" src={item.assetUrl} className="mt-3 w-full" />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    href={item.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Openverse <ArrowSquareOut className="w-3 h-3" />
                  </a>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => saveReference(item)}
                    disabled={savedIds.has(item.id)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-60"
                  >
                    {savedIds.has(item.id) ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <BookmarkSimple className="w-3.5 h-3.5" />
                    )}
                    {savedIds.has(item.id) ? "Saved" : "Save reference"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => void runSearch(query, page - 1)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
            >
              <CaretLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <span className="text-xs text-muted-foreground">
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              disabled={!hasNext || loading}
              onClick={() => void runSearch(query, page + 1)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
            >
              Next <CaretRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Memes ──────────────────────────────────────────────────────────

const KIND_LABELS: Record<StudioProject["kind"], string> = {
  niche: "Niche report",
  ideas: "Video ideas",
  seo: "SEO pack",
  script: "Script",
  transcript: "Transcript",
  voiceover: "Voiceover",
  thumbnail: "Thumbnail",
  deck: "Presentation",
  stock: "Stock reference",
};

function MemesPanel() {
  const [projects, setProjects] = useState<StudioProject[]>([]);

  useEffect(() => {
    setProjects(getBrowserProjectStore().list());
  }, []);

  const memes = filterMemeProjects(projects);

  return (
    <div className="space-y-5">
      <div className={studioCardClass}>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Smiley className="w-4.5 h-4.5" /> Your meme collection, add items from your projects
          and uploads.
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">
          The Studio doesn&apos;t scrape meme libraries. Anything you save in Projects and tag
          &lsquo;meme&rsquo; collects here.
        </p>
        <p className="mt-2">
          <Link href="/studio/projects" className="text-xs font-medium text-primary hover:underline">
            Open Projects to tag items
          </Link>
        </p>
      </div>

      {memes.length === 0 ? (
        <div className={cn(studioCardClass, "text-center")}>
          <p className="text-sm font-medium">No memes collected yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Open any project in Projects, expand it, and add the tag &lsquo;meme&rsquo;, or use
            its &lsquo;+ meme&rsquo; shortcut. Tagged items will collect here automatically.
          </p>
          <p className="mt-2">
            <Link href="/studio/projects" className="text-xs font-medium text-primary hover:underline">
              Open Projects to tag items
            </Link>
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {memes.map((project) => {
            const thumbPayload =
              project.kind === "thumbnail"
                ? (project.payload as ThumbnailProjectPayload)
                : null;
            const stockPayload =
              project.kind === "stock" ? (project.payload as StockReferencePayload) : null;
            return (
              <li key={project.id} className={cn(studioCardClass, "flex flex-col p-4")}>
                <span className="self-start rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {KIND_LABELS[project.kind]}
                </span>
                {thumbPayload?.previewDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbPayload.previewDataUrl}
                    alt={`Preview of ${project.title}`}
                    className="mt-3 aspect-video w-full rounded-lg border border-border object-cover"
                  />
                ) : null}
                <p className="mt-2.5 text-sm font-medium leading-snug">{project.title}</p>
                <p className="mt-1 flex-1 text-[13px] text-muted-foreground leading-relaxed">
                  {project.summary}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {new Date(project.createdAt).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Sound effects (MyInstants, linked — nothing hosted here) ──────
//
// Owner's chosen route (2026-11-07): the sounds stay on MyInstants.
// Cards link out to each sound's MyInstants page, and Play loads the
// official embed player MyInstants offers for every sound — no audio
// file is copied, proxied or hotlinked by this app.

function SoundEffectsPanel() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [playing, setPlaying] = useState<string | null>(null);
  const results = filterSoundEffects(query, category);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
        Hosted by{" "}
        <a
          href="https://www.myinstants.com"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-primary hover:underline"
        >
          MyInstants
        </a>{" "}
        — sounds play through their official embed player and are never copied or
        re-hosted here. To download a sound, open its MyInstants page.
      </div>

      <div className={studioCardClass}>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Waveform className="w-4.5 h-4.5" /> Sound Effects
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          The meme sounds every editor reaches for — vine boom, bruh, sad violin —
          linked from MyInstants and playable right here.
        </p>
        <div className="mt-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the board — try 'boom'"
            aria-label="Search sound effects"
            className={studioInputClass}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Sound effect categories">
          {SOUND_EFFECT_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                category === c
                  ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <div className={cn(studioCardClass, "text-center")}>
          <p className="text-sm font-medium">No sound on this board matches</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Try a shorter word, or search all of MyInstants instead.
          </p>
          <a
            href={myinstantsSearchUrl(query || "meme")}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            Search MyInstants <ArrowSquareOut className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((s) => (
            <li key={s.pageUrl} className={cn(studioCardClass, "flex flex-col p-4")}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold leading-snug">{s.name}</p>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {s.category}
                </span>
              </div>
              <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted-foreground">
                {s.use}
              </p>
              {playing === s.pageUrl ? (
                <div className="mt-3 flex justify-center rounded-lg border border-border bg-muted/40 py-2">
                  <iframe
                    src={s.embedUrl}
                    width={110}
                    height={200}
                    title={`${s.name} — MyInstants player`}
                    loading="lazy"
                    className="h-[200px] w-[110px] border-0"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setPlaying(s.pageUrl)}
                  className={cn(studioPrimaryButtonClass, "mt-3 inline-flex items-center justify-center gap-2")}
                >
                  <Play className="h-4 w-4" /> Play
                </button>
              )}
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                <span>{s.favorites.toLocaleString("en-IN")} favorites on MyInstants</span>
                <a
                  href={s.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 font-medium text-primary hover:underline"
                >
                  Open <ArrowSquareOut className="h-3.5 w-3.5" />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-center text-[13px] text-muted-foreground">
        Need something else?{" "}
        <a
          href={myinstantsSearchUrl(query || "meme")}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-primary hover:underline"
        >
          Search all of MyInstants
        </a>{" "}
        — thousands more sounds, on their site.
      </p>
    </div>
  );
}

// ── Page shell (tabs driven by ?tab=) ──────────────────────────────

function LibraryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<LibraryTab>(() => parseTab(searchParams.get("tab")));

  useEffect(() => {
    setTab(parseTab(searchParams.get("tab")));
  }, [searchParams]);

  const selectTab = (next: LibraryTab) => {
    setTab(next);
    router.replace(`/studio/library?tab=${next}`, { scroll: false });
  };

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={Images}
        title="Stock Libraries"
        purpose="Free stock images, videos and audio with their credits attached, meme sound effects, plus your own meme collection."
        points={[
          "Pexels images and videos, photographer credit on every result",
          "Commercial-use audio from Openverse, licence kept on every item",
          "Save references to Projects, the files stay with the provider",
        ]}
      />
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Stock libraries">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => selectTab(t.id)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-xs transition-colors",
              tab === t.id
                ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "images" && <PexelsPanel key="images" media="image" />}
      {tab === "videos" && <PexelsPanel key="videos" media="video" />}
      {tab === "audio" && <AudioPanel />}
      {tab === "sounds" && <SoundEffectsPanel key="sounds" />}
      {tab === "memes" && <MemesPanel />}
    </div>
  );
}

export default function StudioLibraryPage() {
  return (
    <Suspense
      fallback={
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleNotch className="w-4 h-4 animate-spin" /> Loading the library…
        </p>
      }
    >
      <LibraryContent />
    </Suspense>
  );
}
