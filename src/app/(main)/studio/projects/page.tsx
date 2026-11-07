"use client";

/**
 * Creator Studio — Projects (Programme S1, "Projects-lite").
 *
 * Saved Studio outputs, stored in this browser's local storage on this
 * device only — the page says so plainly. Open a project to view its
 * contents again; delete removes it from this device.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderOpen,
  Trash,
  CaretDown,
  CaretRight,
  Info,
  Tag,
  X,
  Image as ImageIcon,
  DownloadSimple,
} from "@/components/phosphor";
import {
  getBrowserProjectStore,
  normalizeTags,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import { getBrowserHandoffStore } from "@/lib/studio/handoff";
import { deckToStandaloneHtml } from "@/lib/studio/deckEngine";
import type {
  DeckProjectPayload,
  NicheReport,
  ScriptDraft,
  SeoPack,
  StockReferencePayload,
  StudioProject,
  ThumbnailProjectPayload,
  TranscriptProjectPayload,
  VoiceoverProjectPayload,
} from "@/lib/studio/types";
import { StudioToolHeader, studioCardClass } from "@/components/studio/ui";
import { cn } from "@/lib/utils";

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

function formatClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ProjectDetail({ project }: { project: StudioProject }) {
  if (project.kind === "niche") {
    const r = project.payload as NicheReport;
    return (
      <div className="text-[13px] text-muted-foreground space-y-1">
        <p>
          Overall <span className="text-foreground font-medium">{r.overall}/100</span>, {r.verdict}
        </p>
        <p>
          Demand {r.subScores.demand} · Competition {r.subScores.competition} · Ease{" "}
          {r.subScores.easeOfStarting} · Earning {r.subScores.earningPotential}
        </p>
        <p>Audience: {r.audienceBand} · Indicative CPM: {r.cpmBandInr}</p>
      </div>
    );
  }
  if (project.kind === "ideas") {
    const p = project.payload as { topic?: string; ideas?: { title: string; format: string }[] };
    return (
      <ul className="list-disc pl-5 space-y-1 text-[13px] text-muted-foreground">
        {(p.ideas ?? []).map((idea, i) => (
          <li key={i}>
            <span className="text-foreground">{idea.title}</span>, {idea.format}
          </li>
        ))}
      </ul>
    );
  }
  if (project.kind === "seo") {
    const pack = project.payload as SeoPack;
    return (
      <div className="text-[13px] text-muted-foreground space-y-1.5">
        <p>
          <span className="text-foreground font-medium">{pack.titles?.[0]?.title ?? pack.topic}</span>
        </p>
        <p>
          {pack.titles?.length ?? 0} titles · {pack.tags?.length ?? 0} tags ({pack.tagsCharCount} chars)
        </p>
        <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3">{pack.tags?.join(", ")}</p>
      </div>
    );
  }
  if (project.kind === "script") {
    const draft = project.payload as ScriptDraft;
    return (
      <div className="text-[13px] text-muted-foreground space-y-1.5">
        <p>
          {draft.sections?.length ?? 0} sections · {draft.wordCount} words · ≈
          {formatClock(draft.estDurationSec)} · {draft.format} · {draft.tone}
          {draft.usedSourceMaterial ? " · built from source material" : ""}
        </p>
        <ul className="list-disc pl-5 space-y-1">
          {(draft.sections ?? []).map((s) => (
            <li key={s.id}>
              <span className="text-foreground">{s.heading}</span> (~{s.seconds}s),{" "}
              {s.text.split("\n")[0]?.slice(0, 110)}
              {(s.text.split("\n")[0]?.length ?? 0) > 110 ? "…" : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (project.kind === "transcript") {
    const t = project.payload as TranscriptProjectPayload;
    return (
      <div className="text-[13px] text-muted-foreground space-y-1.5">
        <p>
          {t.stats?.words ?? 0} words · {t.stats?.segmentCount ?? t.segments?.length ?? 0}{" "}
          segments ·{" "}
          {t.stats?.durationSec != null
            ? `${formatClock(t.stats.durationSec)} of audio`
            : "no timings"}{" "}
          · {t.format.toUpperCase()} import
          {t.skipped ? ` · ${t.skipped} skipped cue${t.skipped === 1 ? "" : "s"}` : ""}
        </p>
        <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3 max-h-56 overflow-y-auto">
          {t.cleanText}
        </p>
      </div>
    );
  }
  if (project.kind === "thumbnail") {
    const t = project.payload as ThumbnailProjectPayload;
    return <ThumbnailDetail project={project} payload={t} />;
  }
  if (project.kind === "deck") {
    const d = project.payload as DeckProjectPayload;
    return (
      <div className="text-[13px] text-muted-foreground space-y-1.5">
        <p>
          <span className="text-foreground font-medium">{d.deck?.topic}</span>, for{" "}
          {d.deck?.audience} · {d.deck?.slides?.length ?? 0} slides
        </p>
        <ol className="list-decimal pl-5 space-y-0.5">
          {(d.deck?.slides ?? []).map((s) => (
            <li key={s.id}>
              <span className="text-foreground">{s.title}</span>{" "}
              <span className="text-xs">({s.kind})</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={() => {
            const blob = new Blob([deckToStandaloneHtml(d.deck)], { type: "text/html" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "presentation.html";
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <DownloadSimple className="w-3.5 h-3.5" /> Download HTML deck
        </button>
      </div>
    );
  }
  if (project.kind === "stock") {
    const s = project.payload as StockReferencePayload;
    return <StockDetail payload={s} />;
  }
  const v = project.payload as VoiceoverProjectPayload;
  return (
    <div className="text-[13px] text-muted-foreground space-y-1.5">
      <p>
        Voice <span className="text-foreground font-medium">{v.voiceName}</span> · {v.language} ·{" "}
        {v.charCount} characters
      </p>
      <p>
        Audio files are not stored at this tier, reopen the Voiceover Studio with this
        text to regenerate the WAV.
      </p>
      <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3 max-h-56 overflow-y-auto">
        {v.text}
      </p>
    </div>
  );
}

function ThumbnailDetail({
  project,
  payload,
}: {
  project: StudioProject;
  payload: ThumbnailProjectPayload;
}) {
  const router = useRouter();
  const doc = payload.doc;
  return (
    <div className="text-[13px] text-muted-foreground space-y-2">
      {payload.previewDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={payload.previewDataUrl}
          alt={`Preview of ${project.title}`}
          className="w-full max-w-md rounded-lg border border-border"
        />
      ) : null}
      <p>
        {doc?.width ?? 1280}×{doc?.height ?? 720} · {doc?.layers?.length ?? 0} layers ·{" "}
        {doc?.background?.type ?? "solid"} background
      </p>
      <button
        type="button"
        onClick={() => {
          if (doc) {
            getBrowserHandoffStore().setThumbnail({ doc, from: "Projects" });
            router.push("/studio/thumbnail");
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
      >
        <ImageIcon className="w-3.5 h-3.5" /> Open in Thumbnail Editor
      </button>
    </div>
  );
}

function StockDetail({ payload: s }: { payload: StockReferencePayload }) {
  const router = useRouter();
  return (
    <div className="text-[13px] text-muted-foreground space-y-1.5">
      <p>
        <span className="text-foreground font-medium">{s.title}</span>, {s.media} from{" "}
        {s.source === "pexels" ? "Pexels" : "Openverse"}
      </p>
      <p>
        By{" "}
        {s.creatorUrl ? (
          <a className="text-primary hover:underline" href={s.creatorUrl} target="_blank" rel="noreferrer">
            {s.creator}
          </a>
        ) : (
          s.creator
        )}
        {s.licenseName ? (
          <>
            {" "}· Licence:{" "}
            {s.licenseUrl ? (
              <a className="text-primary hover:underline" href={s.licenseUrl} target="_blank" rel="noreferrer">
                {s.licenseName}
              </a>
            ) : (
              s.licenseName
            )}
          </>
        ) : null}
      </p>
      <p className="flex flex-wrap gap-2">
        <a
          className="text-primary hover:underline"
          href={s.pageUrl}
          target="_blank"
          rel="noreferrer"
        >
          View on {s.source === "pexels" ? "Pexels" : "Openverse"}
        </a>
        {s.media === "image" && (
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => {
              getBrowserHandoffStore().setThumbnail({
                imageUrl: s.assetUrl,
                imageCredit:
                  s.source === "pexels"
                    ? `Photo by ${s.creator} on Pexels`
                    : `${s.title} by ${s.creator} (${s.licenseName ?? "CC"})`,
                from: "Projects, stock reference",
              });
              router.push("/studio/thumbnail");
            }}
          >
            Use in Thumbnail Editor
          </button>
        )}
      </p>
      <p className="text-xs">
        This is a saved reference, the file stays on the provider&apos;s site; the Studio
        does not host a copy.
      </p>
    </div>
  );
}

function TagEditor({
  project,
  onChange,
}: {
  project: StudioProject;
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const tags = project.tags ?? [];
  const add = (raw: string) => {
    const next = normalizeTags([...tags, raw]);
    if (next.length !== tags.length) onChange(next);
    setDraft("");
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
      <Tag className="w-3.5 h-3.5 text-muted-foreground" />
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            className="hover:text-foreground"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        placeholder="Add a tag…"
        aria-label="Add a tag"
        className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      {!tags.includes("meme") && (
        <button
          type="button"
          onClick={() => add("meme")}
          className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title="Show this item in the Meme Library tab"
        >
          + meme
        </button>
      )}
    </div>
  );
}

export default function StudioProjectsPage() {
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    setProjects(getBrowserProjectStore().list());
  }, []);

  const remove = (id: string) => {
    const store = getBrowserProjectStore();
    try {
      store.remove(id);
      setStorageError(null);
    } catch {
      // The delete did not persist: the list below re-reads storage
      // truth, so the project correctly remains visible.
      setStorageError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
    setProjects(store.list());
    if (openId === id) setOpenId(null);
  };

  const updateTags = (id: string, tags: string[]) => {
    const store = getBrowserProjectStore();
    try {
      store.setTags(id, tags);
      setStorageError(null);
    } catch {
      setStorageError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
    setProjects(store.list());
  };

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={FolderOpen}
        title="Projects"
        purpose="Everything you save from the Studio tools, kept on this device."
        points={[
          "Saved niche reports, ideas, scripts, decks and more in one list",
          "Tag items, tag “meme” to collect them in the Meme Library",
          "Stored only in this browser, on this device",
        ]}
      />
      <div className={studioCardClass}>
        <p className="flex gap-1.5 text-[13px] text-muted-foreground">
          <Info className="w-4 h-4 shrink-0 mt-px" />
          At this tier, saved Studio work is stored in this browser on this device only,
          it is not synced to your account or backed up. Clearing browser data removes it.
        </p>
        {storageError && (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {storageError}
          </p>
        )}
      </div>

      {projects.length === 0 ? (
        <div className={cn(studioCardClass, "text-center")}>
          <p className="text-sm font-medium">Nothing saved yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Use any Studio tool, Niche Finder, Ideas, Script Builder, Transcript
            Tools, Voiceover Studio, Thumbnail Editor, Presentations, the Stock
            Libraries or SEO Workspace, then choose “Save to Projects”; it will
            appear here. Tag anything “meme” and it also shows in the Meme Library.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => {
            const open = openId === project.id;
            return (
              <li key={project.id} className={studioCardClass}>
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    className="flex flex-1 items-start gap-2 text-left min-w-0"
                    onClick={() => setOpenId(open ? null : project.id)}
                    aria-expanded={open}
                  >
                    {open ? (
                      <CaretDown className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <CaretRight className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm font-medium truncate">{project.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {KIND_LABELS[project.kind]} ·{" "}
                        {new Date(project.createdAt).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                      <span className="mt-0.5 block text-[13px] text-muted-foreground truncate">
                        {project.summary}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(project.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                    title="Delete from this device"
                  >
                    <Trash className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>
                {open && (
                  <>
                    <div className="mt-3 border-t border-border pt-3">
                      <ProjectDetail project={project} />
                    </div>
                    <TagEditor
                      project={project}
                      onChange={(tags) => updateTags(project.id, tags)}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
