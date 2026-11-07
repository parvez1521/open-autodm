/**
 * Creator Studio — Voiceover Studio logic (Programme S2).
 *
 * Pure, unit-tested pieces of the voiceover tool: the voice catalogue,
 * TTS text chunking, the WAV encoder and the export-engine state
 * machine. The browser-only Kokoro loader lives in kokoroEngine.ts.
 *
 * THE CATALOGUE IS THE LIBRARY'S REAL ONE. kokoro-js@1.2.1 (verified
 * against its shipped dist + type definitions) validates every voice
 * against a built-in map of 28 English voices and phonemizes ONLY
 * en-us / en-gb — `generate()` throws for anything else. The upstream
 * Kokoro-82M MODEL family also ships Hindi voice packs (hf_* / hm_*),
 * but they are NOT loadable through this library build, so they are
 * listed separately below (HINDI_MODEL_VOICES) purely so the UI can
 * explain the Hindi state honestly instead of offering a control that
 * would always fail.
 */

import type { VoiceLanguage, VoiceOption } from "./types";

export const VOICE_LANGUAGES: { id: VoiceLanguage; label: string }[] = [
  { id: "en-US", label: "English (US)" },
  { id: "en-GB", label: "English (GB)" },
  { id: "hi", label: "Hindi" },
];

/**
 * The 28 voices kokoro-js@1.2.1 can actually synthesize (its frozen
 * VOICES map), with names/genders as the library publishes them.
 * English is Kokoro's quality tier (the research: English voices are
 * the model's strong set), so every entry is tier "quality".
 */
export const KOKORO_VOICES: VoiceOption[] = [
  // American English — female
  { id: "af_heart", name: "Heart", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_alloy", name: "Alloy", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_aoede", name: "Aoede", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_bella", name: "Bella", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_jessica", name: "Jessica", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_kore", name: "Kore", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_nicole", name: "Nicole", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_nova", name: "Nova", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_river", name: "River", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_sarah", name: "Sarah", language: "en-US", gender: "female", tier: "quality" },
  { id: "af_sky", name: "Sky", language: "en-US", gender: "female", tier: "quality" },
  // American English — male
  { id: "am_adam", name: "Adam", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_echo", name: "Echo", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_eric", name: "Eric", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_fenrir", name: "Fenrir", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_liam", name: "Liam", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_michael", name: "Michael", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_onyx", name: "Onyx", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_puck", name: "Puck", language: "en-US", gender: "male", tier: "quality" },
  { id: "am_santa", name: "Santa", language: "en-US", gender: "male", tier: "quality" },
  // British English — female
  { id: "bf_alice", name: "Alice", language: "en-GB", gender: "female", tier: "quality" },
  { id: "bf_emma", name: "Emma", language: "en-GB", gender: "female", tier: "quality" },
  { id: "bf_isabella", name: "Isabella", language: "en-GB", gender: "female", tier: "quality" },
  { id: "bf_lily", name: "Lily", language: "en-GB", gender: "female", tier: "quality" },
  // British English — male
  { id: "bm_daniel", name: "Daniel", language: "en-GB", gender: "male", tier: "quality" },
  { id: "bm_fable", name: "Fable", language: "en-GB", gender: "male", tier: "quality" },
  { id: "bm_george", name: "George", language: "en-GB", gender: "male", tier: "quality" },
  { id: "bm_lewis", name: "Lewis", language: "en-GB", gender: "male", tier: "quality" },
];

/**
 * Hindi voices that exist in the upstream Kokoro-82M model family
 * (research: 4 voices, all grade C — experimental). kokoro-js@1.2.1
 * cannot load them (its catalogue + phonemizer are English-only), so
 * these are NEVER offered as exportable voices; the UI lists them only
 * to explain the Hindi state, labelled beta.
 */
export const HINDI_MODEL_VOICES: VoiceOption[] = [
  { id: "hf_alpha", name: "Alpha", language: "hi", gender: "female", tier: "beta" },
  { id: "hf_beta", name: "Beta", language: "hi", gender: "female", tier: "beta" },
  { id: "hm_omega", name: "Omega", language: "hi", gender: "male", tier: "beta" },
  { id: "hm_psi", name: "Psi", language: "hi", gender: "male", tier: "beta" },
];

export function voicesForLanguage(language: VoiceLanguage): VoiceOption[] {
  return KOKORO_VOICES.filter((v) => v.language === language);
}

export function getVoice(id: string): VoiceOption | undefined {
  return KOKORO_VOICES.find((v) => v.id === id);
}

/** True only for voices the export engine (kokoro-js) can synthesize. */
export function isExportableVoice(id: string): boolean {
  return getVoice(id) !== undefined;
}

// ── Chunking ───────────────────────────────────────────────────────

/**
 * Kokoro synthesizes best in ~100–200-token chunks (research). At
 * roughly 4 characters per token for English prose, 800 characters is
 * the top of that band.
 */
export const TTS_CHUNK_MAX_CHARS = 800;

/** Split raw text into speakable sentences (terminal punctuation kept). */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences: string[] = [];
  const re = /[^.!?…]+[.!?…]+["'”’)\]]*\s*/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const s = match[0].trim();
    if (s) sentences.push(s);
    consumed = re.lastIndex;
  }
  const rest = normalized.slice(consumed).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = sentence.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars; // a single word longer than the cap: hard split
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Pack sentences into chunks of at most `maxChars` characters. Joining
 * the chunks with a single space reproduces the whitespace-normalized
 * input for ordinary punctuated text.
 */
export function chunkTextForTts(text: string, maxChars: number = TTS_CHUNK_MAX_CHARS): string[] {
  const cap = Math.max(40, maxChars);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const sentence of splitSentences(text)) {
    const parts = sentence.length > cap ? splitLongSentence(sentence, cap) : [sentence];
    for (const part of parts) {
      if (!current) {
        current = part;
      } else if (current.length + 1 + part.length <= cap) {
        current = `${current} ${part}`;
      } else {
        flush();
        current = part;
      }
    }
  }
  flush();
  return chunks;
}

/** Rough spoken-duration estimate at an average narration pace. */
export function estimateSpeechSeconds(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (words === 0) return 0;
  return Math.max(1, Math.round((words / 150) * 60));
}

// ── WAV encoding ───────────────────────────────────────────────────

/**
 * Encode mono Float32 samples as a 16-bit PCM WAV file (44-byte
 * header). Samples are clamped to [-1, 1]. Pure and deterministic —
 * the exact bytes the download delivers.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.min(1, Math.max(-1, samples[i]!));
    view.setInt16(44 + i * bytesPerSample, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}

// ── Export-engine state machine ────────────────────────────────────

export type VoiceoverPhase = "idle" | "loading-model" | "ready" | "generating" | "error";
export type VoiceoverErrorCode = "init_failed" | "generation_failed";

export interface VoiceoverEngineState {
  phase: VoiceoverPhase;
  errorCode: VoiceoverErrorCode | null;
  chunksDone: number;
  chunksTotal: number;
}

export const initialVoiceoverState: VoiceoverEngineState = {
  phase: "idle",
  errorCode: null,
  chunksDone: 0,
  chunksTotal: 0,
};

export type VoiceoverEvent =
  | { type: "load-start" }
  | { type: "load-ok" }
  | { type: "load-fail" }
  | { type: "generate-start"; chunks: number }
  | { type: "generate-progress"; done: number }
  | { type: "generate-ok" }
  | { type: "generate-fail" }
  | { type: "reset" };

/**
 * The export engine's lifecycle. Deliberately conservative: events
 * that don't apply to the current phase are no-ops, so a stray late
 * callback can never corrupt the visible state.
 */
export function voiceoverReducer(
  state: VoiceoverEngineState,
  event: VoiceoverEvent
): VoiceoverEngineState {
  switch (event.type) {
    case "reset":
      return initialVoiceoverState;
    case "load-start":
      if (state.phase === "idle" || state.phase === "error" || state.phase === "ready") {
        return { phase: "loading-model", errorCode: null, chunksDone: 0, chunksTotal: 0 };
      }
      return state;
    case "load-ok":
      return state.phase === "loading-model" ? { ...state, phase: "ready" } : state;
    case "load-fail":
      return state.phase === "loading-model"
        ? { phase: "error", errorCode: "init_failed", chunksDone: 0, chunksTotal: 0 }
        : state;
    case "generate-start":
      if (
        state.phase === "ready" ||
        state.phase === "idle" ||
        (state.phase === "error" && state.errorCode === "generation_failed")
      ) {
        return {
          phase: "generating",
          errorCode: null,
          chunksDone: 0,
          chunksTotal: Math.max(1, event.chunks),
        };
      }
      return state;
    case "generate-progress":
      return state.phase === "generating"
        ? { ...state, chunksDone: Math.min(event.done, state.chunksTotal) }
        : state;
    case "generate-ok":
      return state.phase === "generating"
        ? { ...state, phase: "ready", chunksDone: state.chunksTotal }
        : state;
    case "generate-fail":
      return state.phase === "generating"
        ? { ...state, phase: "error", errorCode: "generation_failed" }
        : state;
    default:
      return state;
  }
}
