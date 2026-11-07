"use client";

/**
 * Creator Studio — Transcript Tools (Programme S2).
 *
 * Paste a transcript or upload a caption file (.srt / .vtt / .txt) and
 * everything is processed locally in the browser: statistics, a
 * timestamped view, a cleaned single-paragraph form, clean-text and
 * SRT downloads, saving to Projects, and a hand-off into the Script
 * Builder. There is deliberately no URL import — see the honest note
 * in the header.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, FloppyDisk, Check, DownloadSimple, ArrowRight } from "@/components/phosphor";
import {
  cleanTranscriptText,
  formatTimestamp,
  parseTranscript,
  serializeSrt,
  timestampedText,
  transcriptStats,
} from "@/lib/studio/transcriptEngine";
import type {
  TranscriptDoc,
  TranscriptProjectPayload,
} from "@/lib/studio/types";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import { getBrowserHandoffStore } from "@/lib/studio/handoff";
import {
  CopyButton,
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioLabelClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors disabled:opacity-60";

export default function TranscriptToolsPage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [doc, setDoc] = useState<TranscriptDoc | null>(null);
  const [view, setView] = useState<"timestamped" | "clean">("timestamped");
  const [removeBracketed, setRemoveBracketed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const stats = doc ? transcriptStats(doc) : null;
  const cleanText = doc ? cleanTranscriptText(doc, { removeBracketed }) : "";
  const srtText = doc ? serializeSrt(doc) : "";
  const displayText = doc
    ? view === "timestamped"
      ? timestampedText(doc)
      : cleanText
    : "";

  const handleInputChange = (value: string) => {
    setInput(value);
    // Clear the previous result so stale output is never shown as
    // current once the input has changed.
    setDoc(null);
    setSaved(false);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setInput(text);
    setFileName(file.name);
    setDoc(null);
    setSaved(false);
  };

  const process = () => {
    if (!input.trim()) return;
    setDoc(parseTranscript(input));
    setSaved(false);
  };

  const save = () => {
    if (!doc || !stats) return;
    const payload: TranscriptProjectPayload = {
      format: doc.format,
      skipped: doc.skipped,
      segments: doc.segments,
      cleanText,
      stats,
    };
    try {
      getBrowserProjectStore().save({
        kind: "transcript",
        title: `Transcript: ${fileName ?? "Pasted transcript"}`,
        summary: `${stats.words} words · ${stats.segmentCount} segments · ${
          stats.durationSec !== null ? formatTimestamp(stats.durationSec) : "no timings"
        }`,
        payload,
      });
      setSaved(true);
      setSaveError(null);
    } catch {
      setSaved(false);
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  const useInScriptBuilder = () => {
    if (!doc) return;
    getBrowserHandoffStore().setScript({
      sourceText: cleanText,
      from: "Transcript Tools",
    });
    router.push("/studio/script");
  };

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={FileText}
        title="Transcript Tools"
        purpose="Clean, format and reuse transcripts, paste or upload, no fetching."
        points={[
          "Paste text or upload .srt, .vtt or .txt caption files",
          "Timestamped and clean-text views, with word and timing stats",
          "Download clean text or SRT, or send it to the Script Builder",
        ]}
      />
      <div className={studioCardClass}>
        <p className="text-[13px] text-muted-foreground">
          Bring in a transcript, tidy it up, and reuse it: check the timing and speaking
          rate, read it with timestamps or as clean text, download it, save it to Projects,
          or send the clean text straight into the Script Builder.
        </p>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Transcripts come in by pasting or uploading a caption file. There is no compliant
          free way to pull them straight from a video URL, so the Studio doesn&rsquo;t offer
          one. If a site offers you a transcript download, bring the file here.
        </p>

        <div className="mt-4">
          <label className={studioLabelClass} htmlFor="transcript-input">
            Transcript or caption contents
          </label>
          <textarea
            id="transcript-input"
            className={cn(studioInputClass, "font-mono leading-relaxed")}
            rows={10}
            placeholder={
              "1\n00:00:01,000 --> 00:00:04,000\nPaste your transcript or caption file contents here…"
            }
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
          />
        </div>

        <div className="mt-3">
          <label className={studioLabelClass} htmlFor="transcript-file">
            Or upload a caption file
          </label>
          <input
            id="transcript-file"
            type="file"
            accept=".srt,.vtt,.txt,text/plain"
            onChange={handleFile}
            className="block text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:text-foreground hover:file:bg-muted/60"
          />
          {fileName && (
            <p className="mt-1.5 text-xs text-muted-foreground">Loaded: {fileName}</p>
          )}
        </div>

        <div className="mt-4">
          <button
            type="button"
            className={studioPrimaryButtonClass}
            onClick={process}
            disabled={!input.trim()}
          >
            Process transcript
          </button>
        </div>
      </div>

      {doc && stats && (
        <>
          <div className={studioCardClass}>
            <div className="flex flex-wrap gap-1.5">
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                Segments: {stats.segmentCount}
              </span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                Words: {stats.words}
              </span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                Duration:{" "}
                {stats.durationSec !== null ? formatTimestamp(stats.durationSec) : "No timings"}
              </span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                Speaking rate:{" "}
                {stats.wordsPerMinute !== null ? `${stats.wordsPerMinute} wpm` : "—"}
              </span>
              {doc.skipped > 0 && (
                <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-xs text-rose-500">
                  Skipped cues: {doc.skipped}
                </span>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="flex gap-1.5" role="group" aria-label="Transcript view">
                <button
                  type="button"
                  onClick={() => setView("timestamped")}
                  aria-pressed={view === "timestamped"}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs transition-colors",
                    view === "timestamped"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  Timestamped
                </button>
                <button
                  type="button"
                  onClick={() => setView("clean")}
                  aria-pressed={view === "clean"}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs transition-colors",
                    view === "clean"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  Clean text
                </button>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={removeBracketed}
                  onChange={(e) => {
                    setRemoveBracketed(e.target.checked);
                    setSaved(false);
                  }}
                />
                Remove markers like [Music]
              </label>
            </div>

            <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-muted/50 p-4 text-[13px] leading-relaxed font-sans">
              {displayText || "No transcript text found."}
            </pre>
          </div>

          <div className={studioCardClass}>
            <h3 className="text-sm font-medium mb-3">Use this transcript</h3>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={cleanText} label="Copy clean text" />
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => downloadText("transcript-clean.txt", cleanText)}
              >
                <DownloadSimple className="w-3.5 h-3.5" /> Download clean .txt
              </button>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => downloadText("transcript.srt", srtText)}
                disabled={srtText === ""}
              >
                <DownloadSimple className="w-3.5 h-3.5" /> Download .srt
              </button>
              {srtText === "" && (
                <span className="text-xs text-muted-foreground">
                  Available when the transcript has timings
                </span>
              )}
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={save}
                disabled={saved}
              >
                {saved ? <Check className="w-3.5 h-3.5" /> : <FloppyDisk className="w-3.5 h-3.5" />}
                {saved ? "Saved" : "Save to Projects"}
              </button>
              {saveError && (
                <span role="alert" className="text-xs text-red-500">
                  {saveError}
                </span>
              )}
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={useInScriptBuilder}
              >
                Use in Script Builder <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
