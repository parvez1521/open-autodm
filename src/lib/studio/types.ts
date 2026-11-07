/**
 * Creator Studio — shared types (Programme S1).
 *
 * Studio is an in-app section of Open AutoDM. Everything in lib/studio is
 * original code written for this product; the engines are deterministic,
 * offline-first, and unit-tested in tests/studio-*.test.ts.
 */

export const STUDIO_CATEGORIES = [
  "Tech & AI Tools",
  "Education",
  "Fitness",
  "Finance & Business",
  "Motivation",
  "Comedy & Entertainment",
  "Food",
  "Travel",
  "Beauty & Fashion",
  "Gaming",
  "Music",
  "DIY & Home",
  "Other",
] as const;

export type StudioCategory = (typeof STUDIO_CATEGORIES)[number];

/** Engine provenance shown in the UI on every generated output. */
export type EngineLabel = "built-in" | "free-ai";

export interface NicheSubScores {
  /** Relative audience-demand index, 0–100. */
  demand: number;
  /** Relative competition index, 0–100 (higher = more crowded). */
  competition: number;
  /** How approachable the niche is for a new creator, 0–100. */
  easeOfStarting: number;
  /** Relative earning-potential index, 0–100. */
  earningPotential: number;
}

export interface NicheReport {
  topic: string;
  category: StudioCategory;
  /** Name of the curated dataset entry the estimate is anchored to. */
  matchedNiche: string;
  overall: number;
  subScores: NicheSubScores;
  /** Coarse audience-size band label (indicative, from built-in data). */
  audienceBand: string;
  /** Indicative CPM range in INR per 1,000 monetised views (built-in band). */
  cpmBandInr: string;
  verdict: string;
  /** Transparent list of the signals that moved the estimate. */
  signals: string[];
  /** Always true in S1 — kept explicit so the UI label is data-driven. */
  heuristic: true;
}

export type IdeaMode = "proven" | "questions" | "angles";

export interface IdeaItem {
  title: string;
  /** Short format label, e.g. "List", "Myth-bust", "Question-led". */
  format: string;
  /** One-line original note on why the format tends to work. */
  whyItWorks: string;
  mode: IdeaMode;
  engine: EngineLabel;
}

export interface SeoTitleOption {
  title: string;
  charCount: number;
  /** Guidance note, e.g. length feedback against the 100-char ceiling. */
  note: string;
}

export interface SeoPack {
  topic: string;
  category: StudioCategory;
  titles: SeoTitleOption[];
  description: string;
  tags: string[];
  /** Total characters of the comma-separated tag string. */
  tagsCharCount: number;
  hashtags: string[];
}

export type PromptCategory =
  | "Hooks"
  | "Scripts"
  | "Thumbnails"
  | "SEO"
  | "Video Ideas"
  | "Sponsorship & Outreach";

export interface PromptItem {
  id: string;
  title: string;
  category: PromptCategory;
  /** The prompt text, with [square-bracket] fill-in placeholders. */
  prompt: string;
  /** Studio tool this prompt pairs with, when one exists. */
  useIn?: "ideas" | "seo" | "script" | "thumbnail";
}

export type StudioProjectKind =
  | "niche"
  | "ideas"
  | "seo"
  | "script"
  | "transcript"
  | "voiceover"
  | "thumbnail"
  | "deck"
  | "stock";

export interface StudioProject {
  id: string;
  kind: StudioProjectKind;
  title: string;
  createdAt: number;
  /** One-line human summary shown in the Projects list. */
  summary: string;
  /** JSON-serialisable snapshot of the tool output. */
  payload: unknown;
  /** Free-form labels (S3). "meme" membership drives the Meme Library view. */
  tags?: string[];
}

// ── S2: Script Builder ─────────────────────────────────────────────

export type ScriptFormat = "reel30" | "short60" | "longform";
export type ScriptTone = "energetic" | "educational" | "calm" | "bold";
export type ScriptSectionKind = "hook" | "setup" | "point" | "payoff" | "cta";

export interface ScriptSection {
  id: string;
  kind: ScriptSectionKind;
  heading: string;
  text: string;
  /**
   * Seconds this section occupies. For the short formats it is derived
   * from the text at speaking pace; for long-form outlines it is the
   * planned slot the outline covers.
   */
  seconds: number;
  /** Which engine last produced this section's text. */
  engine: EngineLabel;
}

export interface ScriptDraft {
  topic: string;
  format: ScriptFormat;
  tone: ScriptTone;
  sections: ScriptSection[];
  wordCount: number;
  estDurationSec: number;
  /** True when main-point sections were woven from supplied source material. */
  usedSourceMaterial: boolean;
}

// ── S2: Transcript Tools ───────────────────────────────────────────

export interface TranscriptSegment {
  /** Seconds from the start; null for plain-text imports. */
  startSec: number | null;
  endSec: number | null;
  text: string;
}

export type TranscriptFormat = "srt" | "vtt" | "text";

export interface TranscriptDoc {
  format: TranscriptFormat;
  segments: TranscriptSegment[];
  /** Cue blocks that were present but could not be parsed. */
  skipped: number;
}

export interface TranscriptStats {
  words: number;
  segmentCount: number;
  /** Last timed cue end − first timed cue start; null when untimed. */
  durationSec: number | null;
  /** Words per minute over the timed duration; null when untimed. */
  wordsPerMinute: number | null;
}

/** Payload saved to Projects for a transcript import. */
export interface TranscriptProjectPayload {
  format: TranscriptFormat;
  skipped: number;
  segments: TranscriptSegment[];
  cleanText: string;
  stats: TranscriptStats;
}

// ── S2: Voiceover Studio ───────────────────────────────────────────

export type VoiceLanguage = "en-US" | "en-GB" | "hi";
export type VoiceGender = "female" | "male";
export type VoiceTier = "quality" | "standard" | "beta";

export interface VoiceOption {
  /** Kokoro voice id, e.g. "af_heart". */
  id: string;
  /** Display name from the library catalogue, e.g. "Heart". */
  name: string;
  language: VoiceLanguage;
  gender: VoiceGender;
  tier: VoiceTier;
}

/** Payload saved to Projects for a voiceover (text + voice, never audio). */
export interface VoiceoverProjectPayload {
  text: string;
  voiceId: string;
  voiceName: string;
  language: VoiceLanguage;
  charCount: number;
}

// ── S3: Thumbnail Editor ───────────────────────────────────────────

/** Thumbnails are composed and exported at exactly this size. */
export const THUMB_WIDTH = 1280;
export const THUMB_HEIGHT = 720;

export type ThumbLayerKind = "image" | "text" | "shape";

export interface ThumbLayerBase {
  id: string;
  kind: ThumbLayerKind;
  name: string;
  /** Top-left corner in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise rotation in degrees around the layer centre. */
  rotation: number;
  /** 0 (transparent) to 1 (opaque). */
  opacity: number;
  visible: boolean;
}

export interface ThumbImageLayer extends ThumbLayerBase {
  kind: "image";
  /**
   * Data URL (uploads, AI generations) or a remote provider URL (stock
   * hand-off). Never a blob: URL — those do not survive a reload.
   */
  src: string;
  fit: "cover" | "contain" | "fill";
  /** Attribution line when the image came from a stock library. */
  credit?: string;
}

export interface ThumbTextLayer extends ThumbLayerBase {
  kind: "text";
  text: string;
  /** Key into the editor's built-in font-stack list. */
  font: string;
  fontSize: number;
  /** 100–900, mapped to the nearest supported stack weight. */
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  /** Stroke width 0 disables the stroke. */
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
}

export interface ThumbShapeLayer extends ThumbLayerBase {
  kind: "shape";
  shape: "rect" | "roundRect" | "ellipse";
  fill: string;
  strokeColor: string;
  strokeWidth: number;
  /** Corner radius for roundRect; ignored by the other shapes. */
  cornerRadius: number;
}

export type ThumbLayer = ThumbImageLayer | ThumbTextLayer | ThumbShapeLayer;

export interface ThumbBackground {
  type: "solid" | "gradient" | "image";
  color: string;
  gradientFrom: string;
  gradientTo: string;
  /** Gradient direction in degrees (0 = left→right, 90 = top→bottom). */
  gradientAngle: number;
  imageSrc: string;
  imageFit: "cover" | "contain" | "fill";
}

/**
 * The editor document. Pure JSON — it is what gets saved to Projects,
 * serialised for export, and handed between tools. Layers paint in
 * array order: index 0 is the bottom layer.
 */
export interface ThumbnailDoc {
  version: 1;
  width: number;
  height: number;
  background: ThumbBackground;
  layers: ThumbLayer[];
}

/** Payload saved to Projects for a thumbnail. */
export interface ThumbnailProjectPayload {
  doc: ThumbnailDoc;
  /**
   * Reduced-size PNG data URL rendered from the document at save time.
   * Preview only — the document is the source of truth and re-renders
   * at full size on export.
   */
  previewDataUrl: string;
}

// ── S3: Presentations ──────────────────────────────────────────────

export type DeckSlideKind = "title" | "agenda" | "section" | "content" | "closing";

export interface DeckSlide {
  id: string;
  kind: DeckSlideKind;
  title: string;
  bullets: string[];
  /** Which engine last produced this slide's text. */
  engine: EngineLabel;
}

export interface Deck {
  topic: string;
  audience: string;
  slides: DeckSlide[];
}

/** Payload saved to Projects for a presentation deck. */
export interface DeckProjectPayload {
  deck: Deck;
}

// ── S3: Stock Libraries ────────────────────────────────────────────

export type StockSource = "pexels" | "openverse";
export type StockMedia = "image" | "video" | "audio";

/**
 * A saved stock REFERENCE. Projects stores the provider URL and the
 * credit/licence metadata only — the file itself stays on the
 * provider's CDN. The Studio never re-hosts stock media as its own
 * library (the providers' terms forbid standalone redistribution).
 */
export interface StockReferencePayload {
  source: StockSource;
  media: StockMedia;
  title: string;
  /** The item's page on the provider's site. */
  pageUrl: string;
  /** Direct asset/stream URL on the provider's CDN. */
  assetUrl: string;
  creator: string;
  creatorUrl?: string;
  /** Licence label + link (Openverse items; Pexels uses its licence). */
  licenseName?: string;
  licenseUrl?: string;
}
