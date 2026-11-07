/**
 * Creator Studio — Kokoro-82M export engine (Programme S2).
 *
 * BROWSER ONLY. This module dynamically imports kokoro-js on first
 * use so the (large) synthesis bundle is code-split and never part of
 * the app's main bundle or any server path. The model itself is
 * downloaded by the library from its CDN into the browser on first
 * use (~90 MB, q8) and cached by the browser afterwards; synthesis
 * then runs entirely on the user's device — no server, no uploads, no
 * cost (research: saas/STUDIO_FREE_PROVIDERS_RESEARCH.md).
 *
 * Failures are typed: a model that cannot be downloaded/initialised
 * is `init_failed`; a failure mid-synthesis is `generation_failed`;
 * a voice outside the library's real catalogue is `unsupported_voice`
 * (checked up-front so the UI never promises what the library would
 * reject — see voiceover.ts for the catalogue evidence).
 */

import { chunkTextForTts, encodeWavPcm16, getVoice } from "./voiceover";

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export type KokoroProgress =
  | { phase: "download"; file?: string; percent?: number }
  | { phase: "generate"; done: number; total: number };

export type KokoroErrorCode = "init_failed" | "generation_failed" | "unsupported_voice";

export class KokoroEngineError extends Error {
  constructor(
    public readonly code: KokoroErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KokoroEngineError";
  }
}

export interface VoiceoverGeneration {
  blob: Blob;
  /** Total audio duration in seconds (samples ÷ sample rate). */
  durationSec: number;
  sampleRate: number;
  chunks: number;
}

type KokoroTTSInstance = Awaited<
  ReturnType<(typeof import("kokoro-js"))["KokoroTTS"]["from_pretrained"]>
>;

let ttsPromise: Promise<KokoroTTSInstance> | null = null;

function loadTts(onProgress?: (p: KokoroProgress) => void): Promise<KokoroTTSInstance> {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (info) => {
          const rec = info as { file?: unknown; progress?: unknown };
          onProgress?.({
            phase: "download",
            file: typeof rec.file === "string" ? rec.file : undefined,
            percent: typeof rec.progress === "number" ? rec.progress : undefined,
          });
        },
      });
    })();
    // A failed load must not poison the singleton: the next attempt
    // starts fresh (the page offers a retry).
    ttsPromise.catch(() => {
      ttsPromise = null;
    });
  }
  return ttsPromise;
}

/**
 * Synthesize `text` with the given Kokoro voice and return one WAV.
 * Long texts are chunked at sentence boundaries (see
 * chunkTextForTts) and the chunk waveforms concatenated in order.
 */
export async function generateVoiceoverWav(
  text: string,
  voiceId: string,
  onProgress?: (p: KokoroProgress) => void
): Promise<VoiceoverGeneration> {
  if (typeof window === "undefined") {
    throw new KokoroEngineError("init_failed", "The export engine runs in the browser only.");
  }
  if (!getVoice(voiceId)) {
    throw new KokoroEngineError(
      "unsupported_voice",
      `Voice "${voiceId}" is not in the export engine's catalogue.`
    );
  }
  const chunks = chunkTextForTts(text);
  if (chunks.length === 0) {
    throw new KokoroEngineError("generation_failed", "There is no text to speak.");
  }

  let tts: KokoroTTSInstance;
  try {
    tts = await loadTts(onProgress);
  } catch (err) {
    throw new KokoroEngineError(
      "init_failed",
      `The voice model could not be downloaded or initialised. ${err instanceof Error ? err.message : ""}`.trim()
    );
  }

  const parts: Float32Array[] = [];
  let sampleRate = 24000;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const audio = await tts.generate(chunks[i]!, { voice: voiceId as never });
      parts.push(audio.audio);
      if (typeof audio.sampling_rate === "number" && audio.sampling_rate > 0) {
        sampleRate = audio.sampling_rate;
      }
      onProgress?.({ phase: "generate", done: i + 1, total: chunks.length });
    }
  } catch (err) {
    throw new KokoroEngineError(
      "generation_failed",
      `Synthesis stopped partway through. ${err instanceof Error ? err.message : ""}`.trim()
    );
  }

  const totalSamples = parts.reduce((n, p) => n + p.length, 0);
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  const wavBytes = encodeWavPcm16(merged, sampleRate);
  const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: "audio/wav" });
  return { blob, durationSec: totalSamples / sampleRate, sampleRate, chunks: chunks.length };
}
