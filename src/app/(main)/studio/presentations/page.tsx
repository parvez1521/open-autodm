"use client";

/**
 * Creator Studio — Presentations (Programme S3).
 *
 * Builds a complete slide deck from a topic and audience: the built-in
 * engine composes it instantly and fully offline, in four tones and
 * 5–12 slides. Decks can be reordered, edited, presented fullscreen,
 * exported as a standalone HTML file (which also prints one slide per
 * page for PDF), and saved to Projects. A single slide can optionally
 * be polished by the free AI tier when configured — always labelled,
 * and any degradation leaves the deck untouched.
 */

import { useEffect, useRef, useState } from "react";
import {
  Presentation,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Trash2,
  Plus,
  Sparkles,
  Loader2,
  Download,
  Printer,
  BookmarkPlus,
  Check,
  MonitorPlay,
} from "lucide-react";
import { SCRIPT_TONE_OPTIONS } from "@/lib/studio/scriptEngine";
import {
  DECK_MAX_SLIDES,
  DECK_MIN_SLIDES,
  addContentSlide,
  buildDeck,
  deckToStandaloneHtml,
  moveSlide,
  removeSlide,
  updateSlide,
} from "@/lib/studio/deckEngine";
import { requestAiSlidePolish, type AiSlidePolishOutcome } from "@/lib/studio/aiClient";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import type { Deck, ScriptTone } from "@/lib/studio/types";
import {
  EngineBadge,
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioLabelClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

const POLISH_NOTES: Partial<Record<AiSlidePolishOutcome["status"], string>> = {
  not_configured:
    "Free AI is not configured on this instance, so the built-in text stays — it is complete as written.",
  quota_reached:
    "Today's shared free AI quota is used up. Your slide is unchanged and complete as written.",
  daily_quota_reached:
    "You have reached today's per-user free AI limit. Your slide is unchanged.",
  rate_limited:
    "Too many free AI requests in a minute — wait a moment and try again. Your slide is unchanged.",
  ai_unavailable: "Free AI did not respond just now. Your slide is unchanged.",
  signed_out: "Sign in again to use the free AI polish — your built-in deck works either way.",
};

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50";

const KIND_LABELS: Record<Deck["slides"][number]["kind"], string> = {
  title: "Title",
  agenda: "Agenda",
  section: "Section",
  content: "Content",
  closing: "Closing",
};

export default function PresentationsPage() {
  const [topic, setTopic] = useState("");
  const [audience, setAudience] = useState("");
  const [slideCount, setSlideCount] = useState(8);
  const [tone, setTone] = useState<ScriptTone>("educational");
  const [deck, setDeck] = useState<Deck | null>(null);
  const [current, setCurrent] = useState(0);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBullets, setEditBullets] = useState("");
  const [editing, setEditing] = useState(false);
  const [polishBusy, setPolishBusy] = useState(false);
  const [polishNotes, setPolishNotes] = useState<Record<string, string>>({});
  const stageRef = useRef<HTMLDivElement | null>(null);

  const currentSlide = deck?.slides[current] ?? null;

  // Keep the edit panel in sync with the slide being viewed.
  useEffect(() => {
    if (!currentSlide) return;
    setEditTitle(currentSlide.title);
    setEditBullets(currentSlide.bullets.join("\n"));
    // Only re-sync when a different slide is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlide?.id]);

  // Keyboard navigation for the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (!deck) return;
      if (e.key === "ArrowRight") {
        setCurrent((c) => Math.min(deck.slides.length - 1, c + 1));
      } else if (e.key === "ArrowLeft") {
        setCurrent((c) => Math.max(0, c - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, editing]);

  const build = () => {
    if (!topic.trim() || !audience.trim()) return;
    setDeck(buildDeck({ topic, audience, slideCount, tone }));
    setCurrent(0);
    setSaved(false);
    setPolishNotes({});
    setEditing(false);
  };

  const applyDeckPreserving = (next: Deck, preserveId: string | null) => {
    setDeck(next);
    setSaved(false);
    if (preserveId) {
      const idx = next.slides.findIndex((s) => s.id === preserveId);
      if (idx >= 0) setCurrent(idx);
      else setCurrent((c) => Math.min(c, next.slides.length - 1));
    } else {
      setCurrent((c) => Math.min(c, next.slides.length - 1));
    }
  };

  const handleMove = (id: string, direction: "up" | "down") => {
    if (!deck) return;
    applyDeckPreserving(moveSlide(deck, id, direction), currentSlide?.id ?? null);
  };

  const handleRemove = (id: string) => {
    if (!deck) return;
    const wasCurrent = currentSlide?.id === id;
    const next = removeSlide(deck, id);
    if (next.slides.length === deck.slides.length) return;
    setDeck(next);
    setSaved(false);
    if (wasCurrent) setCurrent((c) => Math.min(c, next.slides.length - 1));
    else applyDeckPreserving(next, currentSlide?.id ?? null);
  };

  const handleAdd = () => {
    if (!deck || !currentSlide) return;
    const beforeIds = new Set(deck.slides.map((s) => s.id));
    const next = addContentSlide(deck, currentSlide.id);
    const added = next.slides.find((s) => !beforeIds.has(s.id));
    setDeck(next);
    setSaved(false);
    if (added) setCurrent(next.slides.findIndex((s) => s.id === added.id));
  };

  const applyEdit = () => {
    if (!deck || !currentSlide) return;
    const bullets = editBullets
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    setDeck(updateSlide(deck, currentSlide.id, { title: editTitle, bullets }));
    setSaved(false);
    setEditing(false);
  };

  const polishSlide = async () => {
    if (!deck || !currentSlide) return;
    if (currentSlide.bullets.length === 0) {
      setPolishNotes((prev) => ({
        ...prev,
        [currentSlide.id]: "Add at least one bullet to this slide before polishing it.",
      }));
      return;
    }
    setPolishBusy(true);
    const outcome = await requestAiSlidePolish({
      topic: deck.topic,
      audience: deck.audience,
      slideTitle: currentSlide.title,
      bullets: currentSlide.bullets,
    });
    setPolishBusy(false);
    if (outcome.status === "ok") {
      const next: Deck = {
        ...deck,
        slides: deck.slides.map((s) =>
          s.id === currentSlide.id
            ? { ...s, bullets: outcome.bullets, engine: "free-ai" as const }
            : s
        ),
      };
      setDeck(next);
      setSaved(false);
      setEditBullets(outcome.bullets.join("\n"));
      setPolishNotes((prev) => ({
        ...prev,
        [currentSlide.id]: `Polished by Free AI (${outcome.model})${outcome.cached ? " · cached" : ""}`,
      }));
    } else {
      const note = POLISH_NOTES[outcome.status];
      if (note) setPolishNotes((prev) => ({ ...prev, [currentSlide.id]: note }));
    }
  };

  const present = () => {
    const el = stageRef.current;
    if (el && typeof el.requestFullscreen === "function") {
      void el.requestFullscreen().catch(() => {
        // Fullscreen can be refused (permissions / gesture); the
        // on-page stage remains usable either way.
      });
    }
  };

  const downloadHtml = () => {
    if (!deck) return;
    const blob = new Blob([deckToStandaloneHtml(deck)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "presentation.html";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openPrintView = () => {
    if (!deck) return;
    const blob = new Blob([deckToStandaloneHtml(deck)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const saveDeck = () => {
    if (!deck) return;
    try {
      getBrowserProjectStore().save({
        kind: "deck",
        title: deck.topic,
        summary: `${deck.slides.length} slides · for ${deck.audience}`,
        payload: { deck },
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
        icon={Presentation}
        title="Presentations"
        purpose="Turn a topic into a slide deck — present in the browser or export it."
        points={[
          "A complete deck from a topic and audience in seconds",
          "Edit, reorder and present fullscreen in the browser",
          "Export a standalone HTML deck, or print one slide per page to PDF",
        ]}
      />
      <div className={studioCardClass}>
        <p className="text-[13px] text-muted-foreground">
          Turn a topic into a complete slide deck you can present, export, and reuse.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className={studioLabelClass} htmlFor="deck-topic">Topic</label>
            <input
              id="deck-topic"
              className={studioInputClass}
              placeholder="e.g. getting started with home workouts"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={160}
            />
          </div>
          <div>
            <label className={studioLabelClass} htmlFor="deck-audience">Audience</label>
            <input
              id="deck-audience"
              className={studioInputClass}
              placeholder="first-time creators"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              maxLength={80}
            />
          </div>
          <div>
            <label className={studioLabelClass} htmlFor="deck-count">Slides</label>
            <select
              id="deck-count"
              className={studioInputClass}
              value={slideCount}
              onChange={(e) => setSlideCount(Number(e.target.value))}
            >
              {Array.from({ length: DECK_MAX_SLIDES - DECK_MIN_SLIDES + 1 }, (_, i) => DECK_MIN_SLIDES + i).map(
                (n) => (
                  <option key={n} value={n}>
                    {n} slides
                  </option>
                )
              )}
            </select>
          </div>
          <div>
            <label className={studioLabelClass} htmlFor="deck-tone">Tone</label>
            <select
              id="deck-tone"
              className={studioInputClass}
              value={tone}
              onChange={(e) => setTone(e.target.value as ScriptTone)}
            >
              {SCRIPT_TONE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-4">
          <button
            type="button"
            className={studioPrimaryButtonClass}
            onClick={build}
            disabled={!topic.trim() || !audience.trim()}
          >
            <Presentation className="w-4 h-4" />
            Build deck
          </button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Decks are built by the built-in engine and work fully offline. A slide can
          optionally be polished with Free AI when it is configured on this instance.
        </p>
      </div>

      {!deck && (
        <div className={studioCardClass}>
          <p className="text-sm text-muted-foreground">
            No deck yet. Add a topic and audience above, choose how many slides you need,
            and build your first deck.
          </p>
        </div>
      )}

      {deck && currentSlide && (
        <>
          <div className={studioCardClass}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{deck.topic}</h3>
              <span className="text-xs text-muted-foreground">for {deck.audience}</span>
              <span className="flex-1" />
              <button type="button" className={secondaryButtonClass} onClick={downloadHtml}>
                <Download className="w-3.5 h-3.5" />
                Download HTML deck
              </button>
              <button type="button" className={secondaryButtonClass} onClick={openPrintView}>
                <Printer className="w-3.5 h-3.5" />
                Print / Save as PDF
              </button>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={saveDeck}
                disabled={saved}
              >
                {saved ? <Check className="w-3.5 h-3.5" /> : <BookmarkPlus className="w-3.5 h-3.5" />}
                {saved ? "Saved" : "Save to Projects"}
              </button>
            </div>
            {saveError && (
              <p role="alert" className="mt-2 text-xs text-red-500">
                {saveError}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              The print view lays one slide per page — use your browser's Print → Save as PDF.
            </p>

            <div
              ref={stageRef}
              className={cn(
                "mt-4 aspect-video w-full rounded-xl border border-border bg-card p-6 sm:p-10 flex flex-col justify-center",
                "[&:fullscreen]:w-full [&:fullscreen]:h-full [&:fullscreen]:flex [&:fullscreen]:items-center [&:fullscreen]:justify-center [&:fullscreen]:rounded-none [&:fullscreen]:aspect-auto"
              )}
            >
              <div className="w-full">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {KIND_LABELS[currentSlide.kind]}
                  </span>
                  <EngineBadge engine={currentSlide.engine} />
                </div>
                <h3 className="mt-3 text-2xl font-semibold leading-tight sm:text-4xl">
                  {currentSlide.title}
                </h3>
                {currentSlide.bullets.length > 0 && (
                  <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-muted-foreground sm:text-base">
                    {currentSlide.bullets.map((bullet, i) => (
                      <li key={i}>{bullet}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                disabled={current === 0}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Prev
              </button>
              <span className="text-xs text-muted-foreground">
                Slide {current + 1} of {deck.slides.length}
              </span>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => setCurrent((c) => Math.min(deck.slides.length - 1, c + 1))}
                disabled={current === deck.slides.length - 1}
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <span className="flex-1" />
              <button type="button" className={studioPrimaryButtonClass} onClick={present}>
                <MonitorPlay className="w-4 h-4" />
                Present
              </button>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className={studioCardClass}>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium">Slides</h4>
                <span className="flex-1" />
                <button type="button" className={secondaryButtonClass} onClick={handleAdd}>
                  <Plus className="w-3.5 h-3.5" />
                  Add slide
                </button>
              </div>
              <ul className="mt-3 space-y-1.5">
                {deck.slides.map((slide, i) => (
                  <li
                    key={slide.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs",
                      i === current
                        ? "border-primary/50 bg-primary/10"
                        : "border-border hover:bg-muted/60"
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setCurrent(i)}
                    >
                      <span className="text-muted-foreground">{i + 1}.</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {slide.kind}
                      </span>
                      <span className="truncate font-medium">{slide.title}</span>
                    </button>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={() => handleMove(slide.id, "up")}
                      aria-label={`Move slide ${i + 1} up`}
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={() => handleMove(slide.id, "down")}
                      aria-label={`Move slide ${i + 1} down`}
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={() => handleRemove(slide.id)}
                      aria-label={`Delete slide ${i + 1}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className={studioCardClass}>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-medium">Edit slide {current + 1}</h4>
                <span className="flex-1" />
                <EngineBadge engine={currentSlide.engine} />
              </div>
              <div className="mt-3">
                <label className={studioLabelClass} htmlFor="slide-title">Title</label>
                <input
                  id="slide-title"
                  className={studioInputClass}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onFocus={() => setEditing(true)}
                  onBlur={() => setEditing(false)}
                />
              </div>
              <div className="mt-3">
                <label className={studioLabelClass} htmlFor="slide-bullets">
                  Bullets (one per line)
                </label>
                <textarea
                  id="slide-bullets"
                  className={studioInputClass}
                  value={editBullets}
                  onChange={(e) => setEditBullets(e.target.value)}
                  onFocus={() => setEditing(true)}
                  onBlur={() => setEditing(false)}
                  rows={6}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" className={studioPrimaryButtonClass} onClick={applyEdit}>
                  Apply
                </button>
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={polishSlide}
                  disabled={polishBusy}
                >
                  {polishBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  Polish slide with Free AI
                </button>
              </div>
              {polishNotes[currentSlide.id] && (
                <p className="mt-2 text-xs text-muted-foreground">{polishNotes[currentSlide.id]}</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
