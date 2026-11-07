/**
 * Creator Studio — tool-to-tool hand-offs (Programme S2).
 *
 * One Studio tool sends work into another (an idea into the Script
 * Builder, a cleaned transcript as script source material, a finished
 * script into the Voiceover Studio). Hand-offs ride in sessionStorage:
 * they survive the in-app navigation, never leave the device, and are
 * consumed (read once, then cleared) by the receiving tool so stale
 * material never leaks into a later visit. The store takes an injected
 * Storage-like object so it is fully unit-testable in node, exactly
 * like the Projects store.
 */

import type { StorageLike } from "./projects";
import type { ThumbnailDoc } from "./types";

export const STUDIO_HANDOFF_SCRIPT_KEY = "open-autodm:studio-handoff:script";
export const STUDIO_HANDOFF_VOICEOVER_KEY = "open-autodm:studio-handoff:voiceover";
export const STUDIO_HANDOFF_THUMBNAIL_KEY = "open-autodm:studio-handoff:thumbnail";

export interface ScriptHandoff {
  topic?: string;
  /** Source material for the builder (e.g. a cleaned transcript). */
  sourceText?: string;
  /** Human label of the sending tool, shown as a note in the builder. */
  from?: string;
}

export interface VoiceoverHandoff {
  text?: string;
  /** Human label of the sending tool, shown as a note in the studio. */
  from?: string;
}

/**
 * Into the Thumbnail Editor (Programme S3). Exactly one payload shape
 * is used per hand-off: a stock image to place, a prompt to prefill
 * the AI-image field, or a whole saved document to reopen.
 */
export interface ThumbnailHandoff {
  /** Remote image URL (stock) to add as a layer / background. */
  imageUrl?: string;
  /** Attribution line for that image, carried onto the layer. */
  imageCredit?: string;
  /** Prompt text (Prompt Library) to prefill the AI-image prompt. */
  promptText?: string;
  /** A saved editor document to reopen (from Projects). */
  doc?: ThumbnailDoc;
  /** Human label of the sending surface, shown as a note in the editor. */
  from?: string;
}

export interface HandoffStore {
  setScript(handoff: ScriptHandoff): void;
  /** Read-and-clear: a hand-off is delivered exactly once. */
  takeScript(): ScriptHandoff | null;
  setVoiceover(handoff: VoiceoverHandoff): void;
  takeVoiceover(): VoiceoverHandoff | null;
  setThumbnail(handoff: ThumbnailHandoff): void;
  takeThumbnail(): ThumbnailHandoff | null;
}

function read<T>(storage: StorageLike, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as T;
  } catch {
    return null; // Corrupt hand-off data must never break a tool.
  }
}

function write(storage: StorageLike, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota/privacy-mode failures are non-fatal: the hand-off is a
    // convenience, and the receiving tool works fully without it.
  }
}

function take<T>(storage: StorageLike, key: string): T | null {
  const value = read<T>(storage, key);
  try {
    storage.removeItem(key);
  } catch {
    // Non-fatal.
  }
  return value;
}

export function createHandoffStore(storage: StorageLike): HandoffStore {
  return {
    setScript: (h) => write(storage, STUDIO_HANDOFF_SCRIPT_KEY, h),
    takeScript: () => take<ScriptHandoff>(storage, STUDIO_HANDOFF_SCRIPT_KEY),
    setVoiceover: (h) => write(storage, STUDIO_HANDOFF_VOICEOVER_KEY, h),
    takeVoiceover: () => take<VoiceoverHandoff>(storage, STUDIO_HANDOFF_VOICEOVER_KEY),
    setThumbnail: (h) => write(storage, STUDIO_HANDOFF_THUMBNAIL_KEY, h),
    takeThumbnail: () => take<ThumbnailHandoff>(storage, STUDIO_HANDOFF_THUMBNAIL_KEY),
  };
}

/** Browser singleton (client components only; sessionStorage). */
let browserStore: HandoffStore | null = null;
export function getBrowserHandoffStore(): HandoffStore {
  if (!browserStore) {
    const ss: StorageLike = {
      getItem: (k) => window.sessionStorage.getItem(k),
      setItem: (k, v) => window.sessionStorage.setItem(k, v),
      removeItem: (k) => window.sessionStorage.removeItem(k),
    };
    browserStore = createHandoffStore(ss);
  }
  return browserStore;
}
