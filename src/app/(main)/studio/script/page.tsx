"use client";

/**
 * Creator Studio — Script Builder (Programme S2).
 *
 * Builds a complete, editable script draft from a topic: the built-in
 * engine composes it instantly and fully offline, in three formats and
 * four tones, optionally weaving the strongest sentences of supplied
 * source material into the main points. Each section can be polished by
 * the free AI tier when configured — always labelled by engine, and any
 * degradation leaves the current text untouched. Finished drafts can be
 * copied, downloaded, saved to Projects, or handed to Voiceover Studio.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PencilLine,
  DownloadSimple,
  BookmarkSimple,
  Check,
  Lightning,
  CircleNotch,
  Microphone,
} from "@/components/phosphor";
import {
  SCRIPT_FORMAT_OPTIONS,
  SCRIPT_TONE_OPTIONS,
  buildScript,
  countWords,
  formatDuration,
  refreshDraft,
  retimeSection,
  scriptToMarkdown,
  scriptToPlainText,
  scriptToSpokenText,
} from "@/lib/studio/scriptEngine";
import { requestAiScriptPolish, type AiPolishOutcome } from "@/lib/studio/aiClient";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import { getBrowserHandoffStore } from "@/lib/studio/handoff";
import type { ScriptDraft, ScriptFormat, ScriptTone } from "@/lib/studio/types";
import {
  EngineBadge,
  CopyButton,
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioLabelClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

const POLISH_NOTES: Partial<Record<AiPolishOutcome["status"], string>> = {
  not_configured:
    "Free AI is not configured here, so the built-in text stays, it is complete as written.",
  quota_reached:
    "Today's shared free AI quota is used up. Your text is unchanged and complete as written.",
  daily_quota_reached:
    "You have reached today's per-user free AI limit. Your text is unchanged.",
  rate_limited:
    "Too many free AI requests in a minute, wait a moment and try again. Your text is unchanged.",
  ai_unavailable: "Free AI did not respond just now. Your text is unchanged.",
  signed_out: "Sign in again to use the free AI polish, your built-in text works either way.",
};

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50";

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatLabel(format: ScriptFormat): string {
  return SCRIPT_FORMAT_OPTIONS.find((o) => o.id === format)?.label ?? format;
}

function toneLabel(tone: ScriptTone): string {
  return SCRIPT_TONE_OPTIONS.find((o) => o.id === tone)?.label ?? tone;
}

export default function ScriptBuilderPage() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [format, setFormat] = useState<ScriptFormat>("reel30");
  const [tone, setTone] = useState<ScriptTone>("energetic");
  const [sourceText, setSourceText] = useState("");
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [polishBusyId, setPolishBusyId] = useState<string | null>(null);
  const [polishNotes, setPolishNotes] = useState<Record<string, string>>({});

  // A hand-off from another Studio tool (an idea, a cleaned transcript)
  // is delivered exactly once, on first mount.
  useEffect(() => {
    const handoff = getBrowserHandoffStore().takeScript();
    if (!handoff) return;
    if (handoff.topic) setTopic(handoff.topic);
    if (handoff.sourceText) setSourceText(handoff.sourceText);
    if (handoff.topic || handoff.sourceText) {
      setHandoffNote(`Carried over from ${handoff.from ?? "another Studio tool"}.`);
    }
  }, []);

  const activeFormat = SCRIPT_FORMAT_OPTIONS.find((o) => o.id === format);

  const build = () => {
    if (!topic.trim()) return;
    setDraft(
      buildScript({
        topic,
        format,
        tone,
        sourceText: sourceText.trim() ? sourceText : undefined,
      })
    );
    setSaved(false);
    setPolishNotes({});
  };

  const updateSectionText = (sectionId: string, text: string) => {
    if (!draft) return;
    const sections = draft.sections.map((section) => {
      if (section.id !== sectionId) return section;
      // A human edit makes the section built-in output again.
      const edited = {
        ...section,
        text,
        engine: section.engine === "free-ai" ? ("built-in" as const) : section.engine,
      };
      return retimeSection(edited, draft.format);
    });
    setDraft(refreshDraft({ ...draft, sections }));
    setSaved(false);
    setPolishNotes((prev) => {
      if (!(sectionId in prev)) return prev;
      const next = { ...prev };
      delete next[sectionId];
      return next;
    });
  };

  const polishSection = async (sectionId: string) => {
    if (!draft) return;
    const section = draft.sections.find((s) => s.id === sectionId);
    if (!section) return;
    setPolishBusyId(sectionId);
    const outcome = await requestAiScriptPolish({
      topic: draft.topic,
      format: draft.format,
      tone: draft.tone,
      sectionKind: section.kind,
      sectionHeading: section.heading,
      sectionText: section.text,
    });
    setPolishBusyId(null);
    if (outcome.status === "ok") {
      const sections = draft.sections.map((s) => {
        if (s.id !== sectionId) return s;
        return retimeSection({ ...s, text: outcome.text, engine: "free-ai" as const }, draft.format);
      });
      setDraft(refreshDraft({ ...draft, sections }));
      setSaved(false);
      setPolishNotes((prev) => ({
        ...prev,
        [sectionId]: `Polished by Free AI (${outcome.model})${outcome.cached ? " · cached" : ""}`,
      }));
    } else {
      // Degradation never touches the text — only a note is shown.
      const note = POLISH_NOTES[outcome.status];
      if (note) setPolishNotes((prev) => ({ ...prev, [sectionId]: note }));
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    try {
      getBrowserProjectStore().save({
        kind: "script",
        title: `Script: ${draft.topic}`,
        summary: `${formatLabel(draft.format)} · ${toneLabel(draft.tone)} · ≈${formatDuration(draft.estDurationSec)} · ${draft.wordCount} words`,
        payload: draft,
      });
      setSaved(true);
      setSaveError(null);
    } catch {
      setSaved(false);
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  const sendToVoiceover = () => {
    if (!draft) return;
    getBrowserHandoffStore().setVoiceover({
      text: scriptToSpokenText(draft),
      from: "Script Builder",
    });
    router.push("/studio/voiceover");
  };

  const downloadSlug =
    draft?.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={PencilLine}
        title="Script Builder"
        purpose="Build a structured script with a hook, sections and a closing call to action."
        points={[
          "Hook, timed sections and a closing call to action",
          "Three formats and four tones, every section editable",
          "Copy, download, save to Projects, or send to Voiceover Studio",
        ]}
      />
      <div className={studioCardClass}>
        <p className="text-[13px] text-muted-foreground">
          Turn a topic into a complete, ready-to-read script. The built-in engine builds it
          instantly and works fully offline; free AI can polish individual sections afterwards.
        </p>
        {handoffNote && <p className="mt-3 text-xs text-muted-foreground">{handoffNote}</p>}
        <div className="mt-4">
          <label className={studioLabelClass} htmlFor="script-topic">Topic</label>
          <input
            id="script-topic"
            className={studioInputClass}
            placeholder="e.g. home workouts for busy parents"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={120}
          />
        </div>
        <div className="mt-3">
          <div className={studioLabelClass}>Format</div>
          <div className="flex flex-wrap items-center gap-2">
            {SCRIPT_FORMAT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setFormat(option.id)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs transition-colors",
                  format === option.id
                    ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {activeFormat && (
            <p className="mt-2 text-xs text-muted-foreground">{activeFormat.blurb}</p>
          )}
        </div>
        <div className="mt-3">
          <div className={studioLabelClass}>Tone</div>
          <div className="flex flex-wrap items-center gap-2">
            {SCRIPT_TONE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTone(option.id)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs transition-colors",
                  tone === option.id
                    ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <label className={studioLabelClass} htmlFor="script-source">Source material (optional)</label>
          <textarea
            id="script-source"
            className={studioInputClass}
            placeholder="Paste notes, an article excerpt, or a cleaned transcript…"
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            rows={5}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            The strongest points in your material get woven into the script's main sections.
            Tip: a cleaned transcript can be carried over here directly from Transcript Tools.
          </p>
        </div>
        <div className="mt-4">
          <button
            type="button"
            className={studioPrimaryButtonClass}
            onClick={build}
            disabled={!topic.trim()}
          >
            <PencilLine className="w-4 h-4" />
            Build script
          </button>
        </div>
      </div>

      {!draft && (
        <div className={studioCardClass}>
          <p className="text-sm text-muted-foreground">
            No script yet. Add a topic above, pick a format and tone, and build your first
            draft, it takes a second and works fully offline.
          </p>
        </div>
      )}

      {draft && (
        <>
          <div className={studioCardClass}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">Script: {draft.topic}</h3>
              <EngineBadge engine="built-in" />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {formatLabel(draft.format)} · {toneLabel(draft.tone)} · ≈
              {formatDuration(draft.estDurationSec)} · {draft.wordCount} words
            </p>
            {draft.usedSourceMaterial && (
              <p className="mt-2 text-xs text-muted-foreground">
                Main points in this draft came from the source material you supplied.
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <CopyButton text={scriptToPlainText(draft)} label="Copy script" />
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() =>
                  downloadText(`script-${downloadSlug}.txt`, scriptToPlainText(draft), "text/plain")
                }
              >
                <DownloadSimple className="w-3.5 h-3.5" />
                Download .txt
              </button>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() =>
                  downloadText(`script-${downloadSlug}.md`, scriptToMarkdown(draft), "text/markdown")
                }
              >
                <DownloadSimple className="w-3.5 h-3.5" />
                Download .md
              </button>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={saveDraft}
                disabled={saved}
              >
                {saved ? <Check className="w-3.5 h-3.5" /> : <BookmarkSimple className="w-3.5 h-3.5" />}
                {saved ? "Saved" : "Save to Projects"}
              </button>
              {saveError && (
                <span role="alert" className="text-xs text-red-500">
                  {saveError}
                </span>
              )}
              <span className="flex-1" />
              <button type="button" className={studioPrimaryButtonClass} onClick={sendToVoiceover}>
                <Microphone className="w-4 h-4" />
                Send to Voiceover
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {draft.sections.map((section) => (
              <div key={section.id} className={studioCardClass}>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-medium">{section.heading}</h4>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {section.kind}
                  </span>
                  <span className="text-xs text-muted-foreground">~{section.seconds}s</span>
                  <span className="text-xs text-muted-foreground">
                    {countWords(section.text)} words
                  </span>
                  <span className="flex-1" />
                  <EngineBadge engine={section.engine} />
                </div>
                <textarea
                  className={cn(studioInputClass, "mt-3")}
                  value={section.text}
                  onChange={(e) => updateSectionText(section.id, e.target.value)}
                  rows={Math.min(10, Math.max(3, section.text.split("\n").length + 1))}
                  aria-label={`${section.heading} text`}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => polishSection(section.id)}
                    disabled={polishBusyId === section.id}
                  >
                    {polishBusyId === section.id ? (
                      <CircleNotch className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Lightning className="w-3.5 h-3.5" />
                    )}
                    Polish with Free AI
                  </button>
                  {polishNotes[section.id] && (
                    <p className="text-xs text-muted-foreground">{polishNotes[section.id]}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
