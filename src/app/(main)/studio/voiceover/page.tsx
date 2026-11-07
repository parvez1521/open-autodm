"use client";

/**
 * Creator Studio — Voiceover Studio (Programme S2).
 *
 * Two engines, honestly labelled:
 *  (a) PREVIEW — the browser's built-in speech (Web Speech API).
 *      Instant playback, but the browser cannot save it as a file.
 *  (b) EXPORT — Kokoro-82M running in the browser via kokoro-js.
 *      Produces a downloadable WAV; the model downloads once
 *      (~90 MB) and then runs on this device, even offline.
 *
 * The export catalogue is the library's real one (28 English voices).
 * The Kokoro model family also has Hindi voices, but this library
 * build ships English voices only — the Hindi panel below says so
 * plainly instead of offering an export control that cannot work.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import {
  AudioLines,
  Play,
  Square,
  Download,
  BookmarkPlus,
  Check,
  Loader2,
  AlertTriangle,
  FileAudio,
} from "lucide-react";
import { getBrowserHandoffStore } from "@/lib/studio/handoff";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import { formatDuration } from "@/lib/studio/scriptEngine";
import {
  HINDI_MODEL_VOICES,
  VOICE_LANGUAGES,
  estimateSpeechSeconds,
  initialVoiceoverState,
  voiceoverReducer,
  voicesForLanguage,
  type VoiceoverEngineState,
} from "@/lib/studio/voiceover";
import { KokoroEngineError, generateVoiceoverWav } from "@/lib/studio/kokoroEngine";
import type { VoiceLanguage, VoiceoverProjectPayload } from "@/lib/studio/types";
import {
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioLabelClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

interface GenerationResult {
  url: string;
  sizeBytes: number;
  durationSec: number;
  chunks: number;
  voiceName: string;
}

const PREVIEW_LANG: Record<VoiceLanguage, string> = {
  "en-US": "en-US",
  "en-GB": "en-GB",
  hi: "hi-IN",
};

export default function VoiceoverStudioPage() {
  const [text, setText] = useState("");
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [language, setLanguage] = useState<VoiceLanguage>("en-US");
  const [voiceId, setVoiceId] = useState("af_heart");
  const [engine, dispatch] = useReducer(voiceoverReducer, initialVoiceoverState);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [downloadFile, setDownloadFile] = useState<string | null>(null);
  const [engineDetail, setEngineDetail] = useState<string | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewSupported, setPreviewSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const startedRef = useRef(false);
  const resultUrlRef = useRef<string | null>(null);

  useEffect(() => {
    setPreviewSupported(typeof window !== "undefined" && "speechSynthesis" in window);
    const handoff = getBrowserHandoffStore().takeVoiceover();
    if (handoff?.text) {
      setText(handoff.text);
      setHandoffNote(`Carried over from ${handoff.from ?? "another Studio tool"}.`);
    }
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    };
  }, []);

  const voices = voicesForLanguage(language);
  const voice = voices.find((v) => v.id === voiceId) ?? voices[0];
  const busy = engine.phase === "loading-model" || engine.phase === "generating";
  const estSeconds = estimateSpeechSeconds(text);

  const pickLanguage = (lang: VoiceLanguage) => {
    setLanguage(lang);
    const first = voicesForLanguage(lang)[0];
    if (first) setVoiceId(first.id);
    setResult(null);
    setSaved(false);
  };

  // ── Preview (Web Speech) ────────────────────────────────────────
  const playPreview = () => {
    if (!previewSupported || !text.trim()) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = PREVIEW_LANG[language];
    const match = synth
      .getVoices()
      .find((v) => v.lang.toLowerCase().startsWith(PREVIEW_LANG[language].toLowerCase().slice(0, 2)));
    if (match) utterance.voice = match;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utterance);
  };

  const stopPreview = () => {
    if (previewSupported) window.speechSynthesis.cancel();
    setSpeaking(false);
  };

  // ── Export (Kokoro in-browser) ──────────────────────────────────
  const generate = async () => {
    if (!text.trim() || !voice || busy) return;
    startedRef.current = false;
    setResult(null);
    setEngineDetail(null);
    setDownloadPercent(null);
    setDownloadFile(null);
    setSaved(false);
    dispatch({ type: "load-start" });
    try {
      const out = await generateVoiceoverWav(text, voice.id, (p) => {
        if (p.phase === "download") {
          if (typeof p.percent === "number") setDownloadPercent(Math.round(p.percent));
          if (p.file) setDownloadFile(p.file.split("/").pop() ?? null);
        } else {
          if (!startedRef.current) {
            startedRef.current = true;
            dispatch({ type: "load-ok" });
            dispatch({ type: "generate-start", chunks: p.total });
          }
          dispatch({ type: "generate-progress", done: p.done });
        }
      });
      if (!startedRef.current) {
        dispatch({ type: "load-ok" });
        dispatch({ type: "generate-start", chunks: out.chunks });
        dispatch({ type: "generate-progress", done: out.chunks });
      }
      dispatch({ type: "generate-ok" });
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
      const url = URL.createObjectURL(out.blob);
      resultUrlRef.current = url;
      setResult({
        url,
        sizeBytes: out.blob.size,
        durationSec: out.durationSec,
        chunks: out.chunks,
        voiceName: voice.name,
      });
    } catch (err) {
      const code = err instanceof KokoroEngineError ? err.code : "generation_failed";
      setEngineDetail(err instanceof Error ? err.message : null);
      if (code === "init_failed") {
        dispatch({ type: "load-fail" });
      } else {
        if (!startedRef.current) {
          dispatch({ type: "load-ok" });
          dispatch({ type: "generate-start", chunks: 1 });
        }
        dispatch({ type: "generate-fail" });
      }
    }
  };

  const saveToProjects = () => {
    if (!voice || !text.trim()) return;
    const payload: VoiceoverProjectPayload = {
      text,
      voiceId: voice.id,
      voiceName: voice.name,
      language,
      charCount: text.length,
    };
    try {
      getBrowserProjectStore().save({
        kind: "voiceover",
        title: `Voiceover: ${voice.name}`,
        summary: `${voice.name} · ${language} · ${text.length} characters · audio not stored`,
        payload,
      });
      setSaved(true);
      setSaveError(null);
    } catch {
      setSaved(false);
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  const engineStatusLine = (state: VoiceoverEngineState): string | null => {
    switch (state.phase) {
      case "loading-model":
        return downloadPercent !== null
          ? `Downloading the voice model${downloadFile ? ` (${downloadFile})` : ""} — ${downloadPercent}%`
          : "Downloading the voice model…";
      case "generating":
        return `Generating audio — part ${state.chunksDone} of ${state.chunksTotal}…`;
      default:
        return null;
    }
  };
  const statusLine = engineStatusLine(engine);

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={AudioLines}
        title="Voiceover Studio"
        purpose="Turn the script into narration in the browser — no uploads, no paid voices."
        points={[
          "Instant preview with your browser's built-in voice",
          "Export a real WAV with Kokoro-82M running on your device",
          "Your text never leaves the device for either engine",
        ]}
      />
      <div className={studioCardClass}>
        <p className="text-[13px] text-muted-foreground">
          Turn a script into narration without uploading anything. Preview instantly with
          your browser's built-in voice, or export a real audio file with the Kokoro-82M
          voice model running on this device. Both are free; neither sends your text to a
          server.
        </p>
        <div className="mt-4">
          <label className={studioLabelClass} htmlFor="voiceover-text">
            Narration text
          </label>
          <textarea
            id="voiceover-text"
            className={cn(studioInputClass, "min-h-32")}
            placeholder="Paste or write the words to speak — or send a finished script here from the Script Builder."
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            maxLength={20000}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{text.length} characters</span>
            <span>Estimated length ≈ {formatDuration(estSeconds)}</span>
            {text.length > 4000 && (
              <span>Long text is generated in parts — it can take a little while.</span>
            )}
            {handoffNote && <span className="text-foreground">{handoffNote}</span>}
          </div>
        </div>

        <div className="mt-4">
          <span className={studioLabelClass}>Language</span>
          <div className="flex flex-wrap gap-2">
            {VOICE_LANGUAGES.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => pickLanguage(l.id)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs transition-colors",
                  language === l.id
                    ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {language !== "hi" ? (
          <div className="mt-4">
            <label className={studioLabelClass} htmlFor="voiceover-voice">
              Voice
            </label>
            <select
              id="voiceover-voice"
              className={studioInputClass}
              value={voice?.id ?? ""}
              onChange={(e) => {
                setVoiceId(e.target.value);
                setResult(null);
                setSaved(false);
              }}
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.gender === "female" ? "Female" : "Male"}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              English is Kokoro's quality tier — its strongest, most natural voices.
            </p>
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-dashed border-border bg-muted/30 p-3.5">
            <p className="text-[13px] font-medium">
              Beta — Hindi voices are experimental
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              The Kokoro model family includes four Hindi voices (
              {HINDI_MODEL_VOICES.map((v) => v.name).join(", ")}), but the in-browser
              library build used here ships English voices only, so Hindi export is not
              available in this build — we would rather say that plainly than offer a
              button that cannot work. If your device has a Hindi voice installed, the
              Preview below can still read Hindi text aloud.
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className={studioCardClass}>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Play className="w-4 h-4" /> Preview — browser speech
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Instant playback using your device's built-in voice. Preview only: the
            browser cannot save this as an audio file — use Export when you need the
            file.
          </p>
          <div className="mt-3 flex items-center gap-2">
            {speaking ? (
              <button type="button" className={studioPrimaryButtonClass} onClick={stopPreview}>
                <Square className="w-4 h-4" /> Stop
              </button>
            ) : (
              <button
                type="button"
                className={studioPrimaryButtonClass}
                onClick={playPreview}
                disabled={!previewSupported || !text.trim()}
              >
                <Play className="w-4 h-4" /> Play preview
              </button>
            )}
            {!previewSupported && (
              <span className="text-xs text-muted-foreground">
                This browser does not provide speech preview.
              </span>
            )}
          </div>
        </div>

        <div className={studioCardClass}>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileAudio className="w-4 h-4" /> Export — Kokoro-82M in your browser
          </h3>
          {language === "hi" ? (
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Export is not available for Hindi in this build (see the note above).
              Switch to an English language to generate a WAV file.
            </p>
          ) : (
            <>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                First use downloads the voice model (about 90 MB) into your browser;
                after that it runs on your device, even offline. Generation produces a
                WAV file you can download and use anywhere.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={studioPrimaryButtonClass}
                  onClick={generate}
                  disabled={!text.trim() || busy}
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileAudio className="w-4 h-4" />
                  )}
                  {engine.phase === "error" ? "Try again" : "Generate WAV file"}
                </button>
                {text.trim() && voice && (
                  <button
                    type="button"
                    onClick={saveToProjects}
                    disabled={saved}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-60"
                    title="Save the text and voice choice to Projects"
                  >
                    {saved ? <Check className="w-4 h-4" /> : <BookmarkPlus className="w-4 h-4" />}
                    {saved ? "Saved" : "Save to Projects"}
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Projects saves the text and voice choice — audio files are not stored at
                this tier; you can regenerate the WAV any time.
              </p>
              {saveError && (
                <p role="alert" className="mt-1.5 text-xs text-red-500">
                  {saveError}
                </p>
              )}
              {statusLine && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> {statusLine}
                </p>
              )}
              {engine.phase === "error" && engine.errorCode === "init_failed" && (
                <div className="mt-3 rounded-lg border border-dashed border-border bg-muted/30 p-3.5">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium">
                    <AlertTriangle className="w-4 h-4" /> The export engine could not be
                    initialised in this browser.
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    The voice model could not be downloaded or started here. Your text
                    and settings are unchanged, and the Preview above still works.
                    {engineDetail ? ` (${engineDetail})` : ""}
                  </p>
                </div>
              )}
              {engine.phase === "error" && engine.errorCode === "generation_failed" && (
                <div className="mt-3 rounded-lg border border-dashed border-border bg-muted/30 p-3.5">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium">
                    <AlertTriangle className="w-4 h-4" /> Generation failed partway through.
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    Your text and settings are unchanged — try again.
                    {engineDetail ? ` (${engineDetail})` : ""}
                  </p>
                </div>
              )}
              {result && (
                <div className="mt-3 space-y-2">
                  <audio id="voiceover-audio" controls src={result.url} className="w-full" />
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      id="voiceover-download"
                      href={result.url}
                      download="voiceover.wav"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/60 transition-colors"
                    >
                      <Download className="w-4 h-4" /> Download WAV
                    </a>
                    <span className="text-xs text-muted-foreground">
                      {result.voiceName} · {formatDuration(Math.round(result.durationSec))} of
                      audio · {(result.sizeBytes / 1024).toFixed(0)} KB · generated in{" "}
                      {result.chunks} part{result.chunks === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
