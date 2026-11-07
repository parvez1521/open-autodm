/**
 * Creator Studio — Transcript Tools engine (Programme S2).
 *
 * Fully offline and client-side. Imports arrive by pasting text or by
 * uploading a caption file (.srt / .vtt / .txt) that the page has
 * already read into a string; this module never fetches anything and
 * has no URL mode at all. It parses SRT and WebVTT cues, falls back to
 * plain-text paragraphs, and offers the small set of transforms the
 * Transcript page needs: a cleaned single-paragraph form, timing
 * statistics, an SRT re-export, and a timestamped reading view. All
 * parsing rules are deterministic and unit-tested. Timestamp
 * components follow the conventional ranges (minutes and seconds
 * < 60; Programme 32) and a cue whose end is not after its start is
 * invalid — both are counted through the skipped-row accounting.
 */

import type { TranscriptDoc, TranscriptFormat, TranscriptSegment, TranscriptStats } from "./types";

/**
 * One timestamp: optional hours, minutes, seconds, then a `.` or `,`
 * separator and 1–3 fraction digits, e.g. `01:02:03,500`, `02:03.5`,
 * `00:03,05`. The fraction is a decimal fraction of a second.
 */
const TIMESTAMP_PATTERN = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}`;

/** A timing line: two timestamps separated by `-->`. */
const TIMING_LINE_RE = new RegExp(`(${TIMESTAMP_PATTERN})\\s*-->\\s*(${TIMESTAMP_PATTERN})`);

/** Anchored single-timestamp grammar used by the timestamp parser. */
const TIMESTAMP_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

const VTT_STRUCTURAL_RE = /^(NOTE|STYLE|REGION)(\s|$)/;

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|nbsp);/g;

function parseTimestamp(raw: string): number | null {
  const m = TIMESTAMP_RE.exec(raw.trim());
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2]!, 10);
  const seconds = parseInt(m[3]!, 10);
  // Conventional ranges (Programme 32, the Iteration-8 correction):
  // the minutes and seconds components must be < 60 in both the
  // MM:SS and HH:MM:SS forms; hours are unbounded beyond the
  // grammar's two digits. An out-of-range component makes the
  // timestamp invalid — the caller counts the cue as skipped,
  // exactly like any other malformed timing row.
  if (minutes >= 60 || seconds >= 60) return null;
  const frac = m[4]!;
  // Fraction digits are a decimal fraction: "5" → 500ms, "05" → 50ms,
  // "123" → 123ms — i.e. scale by the number of digits present.
  const ms = parseInt(frac, 10) * Math.pow(10, 3 - frac.length);
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (entity) => ENTITY_MAP[entity] ?? entity);
}

/** Split normalised text into blocks separated by blank lines. */
function splitBlocks(normalized: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of normalized.split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

export function parseTranscript(input: string): TranscriptDoc {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const firstNonEmpty = lines.find((l) => l.trim().length > 0);
  let format: TranscriptFormat;
  if (firstNonEmpty && firstNonEmpty.trim().toLowerCase().startsWith("webvtt")) {
    format = "vtt";
  } else if (lines.some((l) => TIMING_LINE_RE.test(l))) {
    format = "srt";
  } else {
    format = "text";
  }

  if (format === "text") {
    const segments: TranscriptSegment[] = [];
    for (const block of splitBlocks(normalized)) {
      const text = block.join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      segments.push({ startSec: null, endSec: null, text });
    }
    return { format, segments, skipped: 0 };
  }

  // Timed mode (srt + vtt).
  const segments: TranscriptSegment[] = [];
  let skipped = 0;
  const blocks = splitBlocks(normalized);

  blocks.forEach((block, blockIndex) => {
    const firstLine = block[0]!.trim();

    if (format === "vtt") {
      // Header block: the WEBVTT line plus any metadata up to the
      // first blank line — structural, never a cue and never skipped.
      if (blockIndex === 0 && firstLine.toLowerCase().startsWith("webvtt")) return;
      // NOTE / STYLE / REGION blocks are structural too.
      if (VTT_STRUCTURAL_RE.test(firstLine)) return;
    }

    const timingIdx = block.findIndex((l) => TIMING_LINE_RE.test(l));
    if (timingIdx === -1) {
      skipped += 1;
      return;
    }

    const match = TIMING_LINE_RE.exec(block[timingIdx]!);
    const startSec = match ? parseTimestamp(match[1]!) : null;
    const endSec = match ? parseTimestamp(match[2]!) : null;
    if (startSec === null || endSec === null) {
      skipped += 1;
      return;
    }
    // A cue whose end is not after its start is invalid (Programme
    // 32): skipped and counted through the same malformed-row
    // accounting — no second error channel.
    if (endSec <= startSec) {
      skipped += 1;
      return;
    }

    let rawText = block.slice(timingIdx + 1).join(" ");
    if (format === "vtt") {
      rawText = rawText.replace(/<[^>]*>/g, "");
      rawText = decodeEntities(rawText);
    }
    const text = rawText.replace(/\s+/g, " ").trim();
    if (!text) {
      skipped += 1;
      return;
    }

    segments.push({ startSec, endSec, text });
  });

  return { format, segments, skipped };
}

export function cleanTranscriptText(
  doc: TranscriptDoc,
  opts?: { removeBracketed?: boolean }
): string {
  const removeBracketed = opts?.removeBracketed ?? false;
  const parts = doc.segments.map((seg) => {
    let t = seg.text;
    if (removeBracketed) t = t.replace(/\[[^\]]*\]/g, "");
    return t;
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function transcriptStats(doc: TranscriptDoc): TranscriptStats {
  const joined = doc.segments.map((s) => s.text).join(" ");
  const trimmed = joined.trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;

  const timed = doc.segments.filter((s) => s.startSec !== null);
  let durationSec: number | null = null;
  if (timed.length >= 1) {
    const first = timed[0]!;
    const last = timed[timed.length - 1]!;
    const end = last.endSec ?? last.startSec;
    if (end !== null && first.startSec !== null) {
      const computed = end - first.startSec;
      durationSec = computed > 0 ? computed : null;
    }
  }

  const wordsPerMinute = durationSec ? Math.round(words / (durationSec / 60)) : null;

  return { words, segmentCount: doc.segments.length, durationSec, wordsPerMinute };
}

function formatSrtTimestamp(sec: number): string {
  const totalMs = Math.round(sec * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function serializeSrt(doc: TranscriptDoc): string {
  const timed = doc.segments.filter((s) => s.startSec !== null);
  if (timed.length === 0) return "";
  const blocks = timed.map((seg, i) => {
    const start = seg.startSec!;
    const end = seg.endSec ?? start + 2;
    return `${i + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${seg.text}`;
  });
  return blocks.join("\n\n") + "\n";
}

export function formatTimestamp(sec: number): string {
  const total = Math.floor(sec);
  const safe = total < 0 ? 0 : total;
  if (safe < 3600) {
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function timestampedText(doc: TranscriptDoc): string {
  return doc.segments
    .map((seg) => {
      if (seg.startSec !== null) return `[${formatTimestamp(seg.startSec)}] ${seg.text}`;
      return seg.text;
    })
    .join("\n");
}
