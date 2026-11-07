/**
 * Creator Studio — Thumbnail Editor document engine (Programme S3).
 *
 * Pure, deterministic document operations, geometry, canvas rendering
 * (against a minimal structural context so it is unit-testable in
 * node), bounded undo history, original layout templates and strict
 * JSON validation. No DOM or framework dependencies.
 */

import {
  THUMB_HEIGHT,
  THUMB_WIDTH,
  type ThumbBackground,
  type ThumbImageLayer,
  type ThumbLayer,
  type ThumbShapeLayer,
  type ThumbTextLayer,
  type ThumbnailDoc,
} from "./types";

// ── Ids ────────────────────────────────────────────────────────────

let fallbackCounter = 0;

function newId(): string {
  fallbackCounter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return `tl-${rand}`;
}

// ── Fonts ──────────────────────────────────────────────────────────

export interface ThumbFontStack {
  key: string;
  label: string;
  stack: string;
}

export const THUMB_FONT_STACKS: ThumbFontStack[] = [
  { key: "sans", label: "Sans (Arial / Helvetica)", stack: "Arial, Helvetica, sans-serif" },
  { key: "display", label: "Display (Impact / Arial Black)", stack: "Impact, 'Arial Black', Arial, sans-serif" },
  { key: "serif", label: "Serif (Georgia)", stack: "Georgia, 'Times New Roman', serif" },
  { key: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { key: "trebuchet", label: "Trebuchet / Segoe", stack: "'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif" },
  { key: "mono", label: "Mono (Courier)", stack: "'Courier New', Courier, monospace" },
];

export function fontStackFor(key: string): string {
  return THUMB_FONT_STACKS.find((f) => f.key === key)?.stack ?? THUMB_FONT_STACKS[0]!.stack;
}

// ── Clamping ───────────────────────────────────────────────────────

export function normaliseRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  let r = (((rotation + 180) % 360) + 360) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function clampLayer<T extends ThumbLayer>(layer: T): T {
  const base = {
    ...layer,
    width: Math.max(20, Number.isFinite(layer.width) ? layer.width : 20),
    height: Math.max(20, Number.isFinite(layer.height) ? layer.height : 20),
    opacity: clampNumber(layer.opacity, 0, 1, 1),
    rotation: normaliseRotation(layer.rotation),
  };
  if (base.kind === "text") {
    return {
      ...base,
      fontSize: clampNumber((base as ThumbTextLayer).fontSize, 8, 400, 48),
    } as T;
  }
  return base as T;
}

// ── Layer factories ────────────────────────────────────────────────

export function createImageLayer(partial: Partial<ThumbImageLayer> = {}): ThumbImageLayer {
  return clampLayer({
    id: partial.id ?? newId(),
    kind: "image",
    name: partial.name ?? "Image",
    x: partial.x ?? 100,
    y: partial.y ?? 100,
    width: partial.width ?? 480,
    height: partial.height ?? 270,
    rotation: partial.rotation ?? 0,
    opacity: partial.opacity ?? 1,
    visible: partial.visible ?? true,
    src: partial.src ?? "",
    fit: partial.fit ?? "cover",
    ...(partial.credit !== undefined ? { credit: partial.credit } : {}),
  });
}

export function createTextLayer(partial: Partial<ThumbTextLayer> = {}): ThumbTextLayer {
  return clampLayer({
    id: partial.id ?? newId(),
    kind: "text",
    name: partial.name ?? "Text",
    x: partial.x ?? 80,
    y: partial.y ?? 280,
    width: partial.width ?? 800,
    height: partial.height ?? 120,
    rotation: partial.rotation ?? 0,
    opacity: partial.opacity ?? 1,
    visible: partial.visible ?? true,
    text: partial.text ?? "Your title here",
    font: partial.font ?? "sans",
    fontSize: partial.fontSize ?? 64,
    fontWeight: partial.fontWeight ?? 800,
    color: partial.color ?? "#ffffff",
    align: partial.align ?? "left",
    strokeColor: partial.strokeColor ?? "#000000",
    strokeWidth: partial.strokeWidth ?? 0,
    shadow: partial.shadow ?? true,
  });
}

export function createShapeLayer(partial: Partial<ThumbShapeLayer> = {}): ThumbShapeLayer {
  return clampLayer({
    id: partial.id ?? newId(),
    kind: "shape",
    name: partial.name ?? "Shape",
    x: partial.x ?? 100,
    y: partial.y ?? 100,
    width: partial.width ?? 240,
    height: partial.height ?? 140,
    rotation: partial.rotation ?? 0,
    opacity: partial.opacity ?? 1,
    visible: partial.visible ?? true,
    shape: partial.shape ?? "rect",
    fill: partial.fill ?? "#f59e0b",
    strokeColor: partial.strokeColor ?? "#000000",
    strokeWidth: partial.strokeWidth ?? 0,
    cornerRadius: partial.cornerRadius ?? 16,
  });
}

// ── Document ───────────────────────────────────────────────────────

export function defaultThumbBackground(): ThumbBackground {
  return {
    type: "solid",
    color: "#111827",
    gradientFrom: "#111827",
    gradientTo: "#1f2937",
    gradientAngle: 45,
    imageSrc: "",
    imageFit: "cover",
  };
}

export function createThumbnailDoc(): ThumbnailDoc {
  return {
    version: 1,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    background: defaultThumbBackground(),
    layers: [],
  };
}

// ── Pure document operations ───────────────────────────────────────

export function addLayer(doc: ThumbnailDoc, layer: ThumbLayer): ThumbnailDoc {
  return { ...doc, layers: [...doc.layers, clampLayer(layer)] };
}

export function updateLayer(
  doc: ThumbnailDoc,
  id: string,
  patch: Partial<ThumbLayer>
): ThumbnailDoc {
  return {
    ...doc,
    layers: doc.layers.map((layer) => {
      if (layer.id !== id) return layer;
      // id and kind are identity, never patched.
      const merged = { ...layer, ...patch, id: layer.id, kind: layer.kind } as ThumbLayer;
      return clampLayer(merged);
    }),
  };
}

export function removeLayer(doc: ThumbnailDoc, id: string): ThumbnailDoc {
  return { ...doc, layers: doc.layers.filter((l) => l.id !== id) };
}

export function duplicateLayer(doc: ThumbnailDoc, id: string): ThumbnailDoc {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) return { ...doc, layers: [...doc.layers] };
  const original = doc.layers[index]!;
  const copy = clampLayer({
    ...original,
    id: newId(),
    x: original.x + 16,
    y: original.y + 16,
    name: `${original.name} copy`,
  } as ThumbLayer);
  const layers = [...doc.layers];
  layers.splice(index + 1, 0, copy);
  return { ...doc, layers };
}

export function moveLayer(
  doc: ThumbnailDoc,
  id: string,
  direction: "up" | "down" | "top" | "bottom"
): ThumbnailDoc {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) return { ...doc, layers: [...doc.layers] };
  const layers = [...doc.layers];
  const [layer] = layers.splice(index, 1);
  if (!layer) return { ...doc, layers: [...doc.layers] };
  let target: number;
  switch (direction) {
    case "up":
      target = Math.min(layers.length, index + 1);
      break;
    case "down":
      target = Math.max(0, index - 1);
      break;
    case "top":
      target = layers.length;
      break;
    case "bottom":
      target = 0;
      break;
  }
  layers.splice(target, 0, layer);
  return { ...doc, layers };
}

export function setBackground(doc: ThumbnailDoc, patch: Partial<ThumbBackground>): ThumbnailDoc {
  return { ...doc, background: { ...doc.background, ...patch } };
}

// ── Bounded history ────────────────────────────────────────────────

export interface ThumbHistory {
  past: ThumbnailDoc[];
  present: ThumbnailDoc;
  future: ThumbnailDoc[];
  cap: number;
}

export function createHistory(doc: ThumbnailDoc, cap = 50): ThumbHistory {
  return { past: [], present: doc, future: [], cap: Math.max(1, cap) };
}

export function historyPush(state: ThumbHistory, doc: ThumbnailDoc): ThumbHistory {
  const past = [...state.past, state.present];
  while (past.length > state.cap) past.shift();
  return { past, present: doc, future: [], cap: state.cap };
}

export function historyUndo(state: ThumbHistory): ThumbHistory {
  if (state.past.length === 0) return state;
  const present = state.past[state.past.length - 1]!;
  return {
    past: state.past.slice(0, -1),
    present,
    future: [state.present, ...state.future],
    cap: state.cap,
  };
}

export function historyRedo(state: ThumbHistory): ThumbHistory {
  if (state.future.length === 0) return state;
  const present = state.future[0]!;
  const past = [...state.past, state.present];
  while (past.length > state.cap) past.shift();
  return { past, present, future: state.future.slice(1), cap: state.cap };
}

// ── Geometry ───────────────────────────────────────────────────────

export type ThumbFit = "cover" | "contain" | "fill";

export interface FitRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export function computeFitRect(
  imgW: number,
  imgH: number,
  boxW: number,
  boxH: number,
  fit: ThumbFit
): FitRect {
  if (imgW <= 0 || imgH <= 0 || boxW <= 0 || boxH <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(0, imgW), sh: Math.max(0, imgH), dx: 0, dy: 0, dw: boxW, dh: boxH };
  }
  if (fit === "fill") {
    return { sx: 0, sy: 0, sw: imgW, sh: imgH, dx: 0, dy: 0, dw: boxW, dh: boxH };
  }
  if (fit === "contain") {
    const scale = Math.min(boxW / imgW, boxH / imgH);
    const dw = imgW * scale;
    const dh = imgH * scale;
    return { sx: 0, sy: 0, sw: imgW, sh: imgH, dx: (boxW - dw) / 2, dy: (boxH - dh) / 2, dw, dh };
  }
  // cover
  const scale = Math.max(boxW / imgW, boxH / imgH);
  const sw = boxW / scale;
  const sh = boxH / scale;
  return { sx: (imgW - sw) / 2, sy: (imgH - sh) / 2, sw, sh, dx: 0, dy: 0, dw: boxW, dh: boxH };
}

export function wrapTextLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth || current === "") {
        // A single word wider than the box still gets its own line;
        // breaking mid-word would need per-character layout.
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

export function hitTestLayer(doc: ThumbnailDoc, x: number, y: number): string | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i]!;
    if (!layer.visible) continue;
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const rad = (-layer.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    if (Math.abs(lx) <= layer.width / 2 && Math.abs(ly) <= layer.height / 2) {
      return layer.id;
    }
  }
  return null;
}

// ── Rendering ──────────────────────────────────────────────────────

export interface ThumbGradient {
  addColorStop(offset: number, color: string): void;
}

/**
 * Minimal structural canvas context. The real
 * CanvasRenderingContext2D satisfies this interface.
 */
export interface ThumbCanvasContext {
  canvas?: { width: number; height: number };
  fillStyle: string | ThumbGradient | unknown;
  strokeStyle: string | unknown;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  lineWidth: number;
  lineJoin: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): ThumbGradient;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect?(x: number, y: number, w: number, h: number, radii: number): void;
  moveTo?(x: number, y: number): void;
  lineTo?(x: number, y: number): void;
  quadraticCurveTo?(cpx: number, cpy: number, x: number, y: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export interface ResolvedThumbImage {
  width: number;
  height: number;
  /** The drawable source; defaults to the resolved object itself. */
  source?: unknown;
}

export type ThumbImageResolver = (src: string) => ResolvedThumbImage | null;

function drawShapePath(ctx: ThumbCanvasContext, layer: ThumbShapeLayer): void {
  const x = -layer.width / 2;
  const y = -layer.height / 2;
  ctx.beginPath();
  if (layer.shape === "ellipse") {
    ctx.ellipse(0, 0, layer.width / 2, layer.height / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (layer.shape === "roundRect") {
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, layer.width, layer.height, Math.min(layer.cornerRadius, layer.width / 2, layer.height / 2));
      return;
    }
    if (typeof ctx.moveTo === "function" && typeof ctx.lineTo === "function" && typeof ctx.quadraticCurveTo === "function") {
      const r = Math.min(layer.cornerRadius, layer.width / 2, layer.height / 2);
      const right = x + layer.width;
      const bottom = y + layer.height;
      ctx.moveTo(x + r, y);
      ctx.lineTo(right - r, y);
      ctx.quadraticCurveTo(right, y, right, y + r);
      ctx.lineTo(right, bottom - r);
      ctx.quadraticCurveTo(right, bottom, right - r, bottom);
      ctx.lineTo(x + r, bottom);
      ctx.quadraticCurveTo(x, bottom, x, bottom - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      return;
    }
    ctx.rect(x, y, layer.width, layer.height);
    return;
  }
  ctx.rect(x, y, layer.width, layer.height);
}

export function renderThumbnailDoc(
  ctx: ThumbCanvasContext,
  doc: ThumbnailDoc,
  resolveImage: ThumbImageResolver
): void {
  const W = doc.width;
  const H = doc.height;
  const bg = doc.background;

  // Background
  if (bg.type === "gradient") {
    const rad = (bg.gradientAngle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
    const cx = W / 2;
    const cy = H / 2;
    const gradient = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    gradient.addColorStop(0, bg.gradientFrom);
    gradient.addColorStop(1, bg.gradientTo);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
    if (bg.type === "image" && bg.imageSrc) {
      const resolved = resolveImage(bg.imageSrc);
      if (resolved && resolved.width > 0 && resolved.height > 0) {
        const fit = computeFitRect(resolved.width, resolved.height, W, H, bg.imageFit);
        ctx.drawImage(resolved.source ?? resolved, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx, fit.dy, fit.dw, fit.dh);
      }
    }
  }

  // Layers, bottom → top.
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.translate(cx, cy);
    if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);

    if (layer.kind === "image") {
      if (layer.src) {
        const resolved = resolveImage(layer.src);
        if (resolved && resolved.width > 0 && resolved.height > 0) {
          const fit = computeFitRect(resolved.width, resolved.height, layer.width, layer.height, layer.fit);
          ctx.drawImage(
            resolved.source ?? resolved,
            fit.sx,
            fit.sy,
            fit.sw,
            fit.sh,
            -layer.width / 2 + fit.dx,
            -layer.height / 2 + fit.dy,
            fit.dw,
            fit.dh
          );
        }
      }
    } else if (layer.kind === "text") {
      const stack = fontStackFor(layer.font);
      ctx.font = `${layer.fontWeight} ${layer.fontSize}px ${stack}`;
      const lines = wrapTextLines(layer.text, layer.width, (s) => ctx.measureText(s).width);
      const lineHeight = layer.fontSize * 1.15;
      ctx.textAlign = layer.align;
      ctx.textBaseline = "top";
      const startX = layer.align === "left" ? -layer.width / 2 : layer.align === "right" ? layer.width / 2 : 0;
      let y = -layer.height / 2;
      if (layer.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 3;
      } else {
        ctx.shadowColor = "rgba(0,0,0,0)";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
      for (const line of lines) {
        if (layer.strokeWidth > 0) {
          ctx.strokeStyle = layer.strokeColor;
          ctx.lineWidth = layer.strokeWidth;
          ctx.lineJoin = "round";
          ctx.strokeText(line, startX, y);
        }
        ctx.fillStyle = layer.color;
        ctx.fillText(line, startX, y);
        y += lineHeight;
      }
    } else {
      drawShapePath(ctx, layer);
      ctx.fillStyle = layer.fill;
      ctx.fill();
      if (layer.strokeWidth > 0) {
        ctx.strokeStyle = layer.strokeColor;
        ctx.lineWidth = layer.strokeWidth;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ── Templates ──────────────────────────────────────────────────────

export interface ThumbTemplate {
  id: string;
  name: string;
  description: string;
  build(): ThumbnailDoc;
}

function docWith(background: Partial<ThumbBackground>, layers: ThumbLayer[]): ThumbnailDoc {
  const doc = createThumbnailDoc();
  return {
    ...doc,
    background: { ...doc.background, ...background },
    layers,
  };
}

export const THUMB_TEMPLATES: ThumbTemplate[] = [
  {
    id: "bold-statement",
    name: "Bold Statement",
    description: "Gradient background, accent bar and a huge two-line headline on the left.",
    build: () =>
      docWith(
        { type: "gradient", gradientFrom: "#111827", gradientTo: "#7c2d12", gradientAngle: 35 },
        [
          createShapeLayer({ name: "Accent bar", x: 64, y: 120, width: 14, height: 300, fill: "#facc15", shape: "rect", cornerRadius: 0 }),
          createTextLayer({ name: "Headline", text: "YOUR BIG\nTITLE HERE", x: 110, y: 110, width: 900, height: 280, font: "display", fontSize: 118, fontWeight: 900, color: "#ffffff" }),
          createTextLayer({ name: "Subtitle", text: "A short supporting line viewers can read at a glance", x: 112, y: 430, width: 760, height: 80, fontSize: 36, fontWeight: 600, color: "#fde68a", shadow: false }),
        ]
      ),
  },
  {
    id: "photo-right",
    name: "Photo Right",
    description: "Text on the left, a full-height photo slot on the right half.",
    build: () =>
      docWith(
        { type: "solid", color: "#0f172a" },
        [
          createImageLayer({ name: "Photo slot", src: "", x: 640, y: 0, width: 640, height: 720, fit: "cover" }),
          createTextLayer({ name: "Headline", text: "Watch this\nbefore you start", x: 64, y: 200, width: 520, height: 220, font: "display", fontSize: 76, fontWeight: 900, color: "#ffffff" }),
          createTextLayer({ name: "Kicker", text: "STEP-BY-STEP GUIDE", x: 66, y: 130, width: 500, height: 50, fontSize: 30, fontWeight: 700, color: "#38bdf8", shadow: false }),
        ]
      ),
  },
  {
    id: "big-number",
    name: "Big Number",
    description: "One giant number in the centre with a caption underneath.",
    build: () =>
      docWith(
        { type: "gradient", gradientFrom: "#052e16", gradientTo: "#14532d", gradientAngle: 90 },
        [
          createTextLayer({ name: "Number", text: "10", x: 340, y: 60, width: 600, height: 380, font: "display", fontSize: 340, fontWeight: 900, color: "#4ade80", align: "center" }),
          createTextLayer({ name: "Caption", text: "mistakes beginners make", x: 240, y: 470, width: 800, height: 90, fontSize: 52, fontWeight: 800, color: "#ffffff", align: "center" }),
        ]
      ),
  },
  {
    id: "versus-split",
    name: "Versus Split",
    description: "Two contrasting halves with a VS badge in the middle.",
    build: () =>
      docWith(
        { type: "solid", color: "#111827" },
        [
          createShapeLayer({ name: "Left half", x: 0, y: 0, width: 640, height: 720, fill: "#dc2626", shape: "rect", cornerRadius: 0 }),
          createShapeLayer({ name: "Right half", x: 640, y: 0, width: 640, height: 720, fill: "#2563eb", shape: "rect", cornerRadius: 0 }),
          createShapeLayer({ name: "VS badge", x: 540, y: 260, width: 200, height: 200, fill: "#facc15", shape: "ellipse" }),
          createTextLayer({ name: "VS label", text: "VS", x: 540, y: 315, width: 200, height: 90, font: "display", fontSize: 72, fontWeight: 900, color: "#111827", align: "center", shadow: false }),
          createTextLayer({ name: "Left label", text: "OPTION A", x: 70, y: 310, width: 500, height: 90, font: "display", fontSize: 64, fontWeight: 900, color: "#ffffff", align: "center" }),
          createTextLayer({ name: "Right label", text: "OPTION B", x: 710, y: 310, width: 500, height: 90, font: "display", fontSize: 64, fontWeight: 900, color: "#ffffff", align: "center" }),
        ]
      ),
  },
  {
    id: "quote-card",
    name: "Quote Card",
    description: "A centred quote on a solid dark background with a small attribution.",
    build: () =>
      docWith(
        { type: "solid", color: "#18181b" },
        [
          createTextLayer({ name: "Quote", text: "\u201CThe best time to start was yesterday. The next best time is now.\u201D", x: 140, y: 180, width: 1000, height: 300, font: "serif", fontSize: 58, fontWeight: 600, color: "#fafafa", align: "center", shadow: false }),
          createTextLayer({ name: "Attribution", text: "— Attribution", x: 440, y: 520, width: 400, height: 50, fontSize: 28, fontWeight: 400, color: "#a1a1aa", align: "center", shadow: false }),
        ]
      ),
  },
  {
    id: "three-step-list",
    name: "Three-Step List",
    description: "Three numbered rows — a clear promise of a quick process.",
    build: () => {
      const layers: ThumbLayer[] = [
        createTextLayer({ name: "Headline", text: "Do it in 3 steps", x: 80, y: 56, width: 900, height: 90, font: "display", fontSize: 68, fontWeight: 900, color: "#ffffff" }),
      ];
      const labels = ["Set it up", "Make the thing", "Share it"];
      labels.forEach((label, i) => {
        const y = 200 + i * 160;
        layers.push(
          createShapeLayer({ name: `Step ${i + 1} chip`, x: 80, y, width: 96, height: 96, fill: "#f59e0b", shape: "ellipse" })
        );
        layers.push(
          createTextLayer({ name: `Step ${i + 1} number`, text: String(i + 1), x: 80, y: y + 18, width: 96, height: 60, fontSize: 48, fontWeight: 900, color: "#111827", align: "center", shadow: false })
        );
        layers.push(
          createTextLayer({ name: `Step ${i + 1} label`, text: label, x: 210, y: y + 20, width: 700, height: 60, fontSize: 44, fontWeight: 700, color: "#ffffff", shadow: false })
        );
      });
      return docWith({ type: "gradient", gradientFrom: "#0f172a", gradientTo: "#1e293b", gradientAngle: 90 }, layers);
    },
  },
];

// ── Serialisation ──────────────────────────────────────────────────

/**
 * Import limits (Programme 32, the Iteration-8 correction). The
 * bundled templates ship at most 10 layers; 100 layers is 10× that
 * headroom while keeping per-frame render + hit-test work and the
 * stored document bounded — an unbounded layers array in an imported
 * document is a resource-boundary risk. The serialized-size guard
 * (8,000,000 characters — JavaScript string code units, NOT a byte
 * count) leaves room for a few full-size data-URL images (a
 * 1280×720 PNG data URL is typically ≤ ~2.5M characters) while
 * keeping a single document inside a practical localStorage budget
 * alongside the rest of the Projects list. Violations return the
 * parser's invalid outcome (null) and no document is produced.
 */
export const THUMB_MAX_LAYERS = 100;
export const THUMB_MAX_DOC_JSON_CHARS = 8_000_000;

export function thumbnailDocToJson(doc: ThumbnailDoc): string {
  return JSON.stringify(doc);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function validateBackground(v: unknown): ThumbBackground | null {
  if (!isRecord(v)) return null;
  if (v["type"] !== "solid" && v["type"] !== "gradient" && v["type"] !== "image") return null;
  if (!isString(v["color"]) || !isString(v["gradientFrom"]) || !isString(v["gradientTo"])) return null;
  if (!isFiniteNumber(v["gradientAngle"])) return null;
  if (!isString(v["imageSrc"])) return null;
  if (v["imageFit"] !== "cover" && v["imageFit"] !== "contain" && v["imageFit"] !== "fill") return null;
  return {
    type: v["type"],
    color: v["color"],
    gradientFrom: v["gradientFrom"],
    gradientTo: v["gradientTo"],
    gradientAngle: v["gradientAngle"],
    imageSrc: v["imageSrc"],
    imageFit: v["imageFit"],
  };
}

function validateLayer(v: unknown): ThumbLayer | null {
  if (!isRecord(v)) return null;
  if (v["kind"] !== "image" && v["kind"] !== "text" && v["kind"] !== "shape") return null;
  if (!isString(v["id"]) || !v["id"]) return null;
  if (!isString(v["name"])) return null;
  if (!isFiniteNumber(v["x"]) || !isFiniteNumber(v["y"]) || !isFiniteNumber(v["width"]) || !isFiniteNumber(v["height"])) return null;
  if (!isFiniteNumber(v["rotation"]) || !isFiniteNumber(v["opacity"])) return null;
  if (typeof v["visible"] !== "boolean") return null;
  const base = {
    id: v["id"],
    name: v["name"],
    x: v["x"],
    y: v["y"],
    width: v["width"],
    height: v["height"],
    rotation: v["rotation"],
    opacity: v["opacity"],
    visible: v["visible"],
  };
  if (v["kind"] === "image") {
    if (!isString(v["src"])) return null;
    if (v["fit"] !== "cover" && v["fit"] !== "contain" && v["fit"] !== "fill") return null;
    if (v["credit"] !== undefined && !isString(v["credit"])) return null;
    const layer: ThumbImageLayer = {
      ...base,
      kind: "image",
      src: v["src"],
      fit: v["fit"],
      ...(isString(v["credit"]) ? { credit: v["credit"] } : {}),
    };
    return layer;
  }
  if (v["kind"] === "text") {
    if (!isString(v["text"]) || !isString(v["font"]) || !isString(v["color"])) return null;
    if (!isFiniteNumber(v["fontSize"]) || !isFiniteNumber(v["fontWeight"])) return null;
    if (v["align"] !== "left" && v["align"] !== "center" && v["align"] !== "right") return null;
    if (!isString(v["strokeColor"]) || !isFiniteNumber(v["strokeWidth"])) return null;
    if (typeof v["shadow"] !== "boolean") return null;
    const layer: ThumbTextLayer = {
      ...base,
      kind: "text",
      text: v["text"],
      font: v["font"],
      fontSize: v["fontSize"],
      fontWeight: v["fontWeight"],
      color: v["color"],
      align: v["align"],
      strokeColor: v["strokeColor"],
      strokeWidth: v["strokeWidth"],
      shadow: v["shadow"],
    };
    return layer;
  }
  // shape
  if (v["shape"] !== "rect" && v["shape"] !== "roundRect" && v["shape"] !== "ellipse") return null;
  if (!isString(v["fill"]) || !isString(v["strokeColor"])) return null;
  if (!isFiniteNumber(v["strokeWidth"]) || !isFiniteNumber(v["cornerRadius"])) return null;
  const layer: ThumbShapeLayer = {
    ...base,
    kind: "shape",
    shape: v["shape"],
    fill: v["fill"],
    strokeColor: v["strokeColor"],
    strokeWidth: v["strokeWidth"],
    cornerRadius: v["cornerRadius"],
  };
  return layer;
}

export function thumbnailDocFromJson(json: unknown): ThumbnailDoc | null {
  try {
    let parsed: unknown = json;
    if (typeof json === "string") {
      if (!json.trim()) return null;
      if (json.length > THUMB_MAX_DOC_JSON_CHARS) return null;
      parsed = JSON.parse(json);
    } else {
      // Already-parsed input (e.g. a saved project payload). Cheap
      // structural checks FIRST (Programme 34, the Iteration-10
      // correction): version and dimensions are O(1) property reads
      // and the layer count is a single .length — every one of them
      // rejects again below, so checking them here changes NO
      // outcome, but an over-limit or wrong-shaped document is now
      // refused BEFORE paying for a full serialization of it. Only
      // then is the serialized-size guard applied to the object's
      // JSON form; that guard necessarily runs AFTER serialization,
      // so it bounds what the parser ACCEPTS, not the one-off cost
      // of serializing an already-parsed object a caller supplied.
      if (isRecord(json)) {
        if (json["version"] !== 1) return null;
        if (json["width"] !== THUMB_WIDTH || json["height"] !== THUMB_HEIGHT) return null;
        if (Array.isArray(json["layers"]) && json["layers"].length > THUMB_MAX_LAYERS) {
          return null;
        }
      }
      const serialized = JSON.stringify(json);
      if (serialized === undefined || serialized.length > THUMB_MAX_DOC_JSON_CHARS) return null;
    }
    if (!isRecord(parsed)) return null;
    if (parsed["version"] !== 1) return null;
    if (parsed["width"] !== THUMB_WIDTH || parsed["height"] !== THUMB_HEIGHT) return null;
    const background = validateBackground(parsed["background"]);
    if (!background) return null;
    if (!Array.isArray(parsed["layers"])) return null;
    if (parsed["layers"].length > THUMB_MAX_LAYERS) return null;
    const layers: ThumbLayer[] = [];
    for (const raw of parsed["layers"]) {
      const layer = validateLayer(raw);
      if (!layer) return null;
      layers.push(layer);
    }
    return { version: 1, width: THUMB_WIDTH, height: THUMB_HEIGHT, background, layers };
  } catch {
    return null;
  }
}
