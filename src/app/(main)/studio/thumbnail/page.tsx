"use client";

/**
 * Creator Studio — Thumbnail Editor (Programme S3).
 *
 * A layer-based 1280×720 canvas editor: templates, text / image /
 * shape layers, drag / resize / rotate on the canvas, bounded
 * undo/redo, PNG export at full size and Projects saves with a small
 * rendered preview. AI images come from the free Workers AI tier via
 * /api/studio/image and are labelled as such; the editor works fully
 * without them.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Loader2,
  Redo2,
  Shapes,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import {
  THUMB_FONT_STACKS,
  THUMB_TEMPLATES,
  addLayer,
  createHistory,
  createImageLayer,
  createShapeLayer,
  createTextLayer,
  createThumbnailDoc,
  duplicateLayer,
  historyPush,
  historyRedo,
  historyUndo,
  hitTestLayer,
  moveLayer,
  removeLayer,
  renderThumbnailDoc,
  setBackground,
  updateLayer,
  type ThumbCanvasContext,
  type ThumbHistory,
} from "@/lib/studio/thumbnail";
import { requestAiImage } from "@/lib/studio/imageClient";
import {
  getBrowserProjectStore,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
} from "@/lib/studio/projects";
import { getBrowserHandoffStore } from "@/lib/studio/handoff";
import type {
  ThumbImageLayer,
  ThumbLayer,
  ThumbShapeLayer,
  ThumbTextLayer,
  ThumbnailDoc,
  ThumbnailProjectPayload,
} from "@/lib/studio/types";
import {
  StudioToolHeader,
  studioCardClass,
  studioInputClass,
  studioLabelClass,
  studioPrimaryButtonClass,
} from "@/components/studio/ui";
import { cn } from "@/lib/utils";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50";

const smallInputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40";

type DragMode = "move" | "resize" | "rotate";

interface DragState {
  mode: DragMode;
  layerId: string;
  startDoc: ThumbnailDoc;
  original: ThumbLayer;
  startX: number;
  startY: number;
  cornerX: -1 | 1;
  cornerY: -1 | 1;
}

function rotatePoint(lx: number, ly: number, rotationDeg: number): { x: number; y: number } {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: lx * cos - ly * sin, y: lx * sin + ly * cos };
}

function layerCanvasPoint(layer: ThumbLayer, lx: number, ly: number): { x: number; y: number } {
  const cx = layer.x + layer.width / 2;
  const cy = layer.y + layer.height / 2;
  const p = rotatePoint(lx, ly, layer.rotation);
  return { x: cx + p.x, y: cy + p.y };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <label className={studioLabelClass}>{label}</label>
      <input
        type="number"
        className={smallInputClass}
        value={Math.round(value * 100) / 100}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className={studioLabelClass}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          className="h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-background"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          className={smallInputClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

export default function ThumbnailEditorPage() {
  const [history, setHistory] = useState<ThumbHistory>(() => createHistory(createThumbnailDoc()));
  const doc = history.present;
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [scale, setScale] = useState(0.55);
  const [imgVersion, setImgVersion] = useState(0);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [shapeToAdd, setShapeToAdd] = useState<ThumbShapeLayer["shape"]>("rect");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const bgUploadRef = useRef<HTMLInputElement | null>(null);

  const selected = doc.layers.find((l) => l.id === selectedLayerId) ?? null;

  const resolveImage = (src: string) => {
    if (!src) return null;
    const cache = imageCacheRef.current;
    const existing = cache.get(src);
    if (existing) {
      if (existing.complete && existing.naturalWidth > 0) {
        return {
          width: existing.naturalWidth,
          height: existing.naturalHeight,
          source: existing as unknown,
        };
      }
      return null;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setImgVersion((v) => v + 1);
    img.src = src;
    cache.set(src, img);
    return null;
  };

  // ── Canvas rendering (document + selection overlay) ──────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rawCtx = canvas.getContext("2d");
    if (!rawCtx) return;
    const ctx = rawCtx as unknown as ThumbCanvasContext;
    renderThumbnailDoc(ctx, doc, resolveImage);

    if (selected && selected.visible) {
      const c = rawCtx;
      const cx = selected.x + selected.width / 2;
      const cy = selected.y + selected.height / 2;
      c.save();
      c.translate(cx, cy);
      c.rotate((selected.rotation * Math.PI) / 180);
      c.strokeStyle = "#22d3ee";
      c.lineWidth = 2;
      c.setLineDash([6, 4]);
      c.strokeRect(-selected.width / 2, -selected.height / 2, selected.width, selected.height);
      c.setLineDash([]);
      // Line up to the rotate handle.
      c.beginPath();
      c.moveTo(0, -selected.height / 2);
      c.lineTo(0, -selected.height / 2 - 24);
      c.stroke();
      c.fillStyle = "#22d3ee";
      const corners: [number, number][] = [
        [-selected.width / 2, -selected.height / 2],
        [selected.width / 2, -selected.height / 2],
        [-selected.width / 2, selected.height / 2],
        [selected.width / 2, selected.height / 2],
      ];
      for (const [hx, hy] of corners) c.fillRect(hx - 5, hy - 5, 10, 10);
      c.beginPath();
      c.arc(0, -selected.height / 2 - 24, 7, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    // resolveImage identity changes per render by design (cache-backed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selectedLayerId, imgVersion]);

  // ── Hand-off (delivered exactly once, on first mount) ────────────
  useEffect(() => {
    const handoff = getBrowserHandoffStore().takeThumbnail();
    if (!handoff) return;
    let next: ThumbnailDoc = handoff.doc ?? createThumbnailDoc();
    let used = false;
    if (handoff.doc) used = true;
    if (handoff.imageUrl) {
      next = addLayer(
        next,
        createImageLayer({
          name: "Stock image",
          src: handoff.imageUrl,
          x: 320,
          y: 130,
          width: 640,
          height: 360,
          fit: "cover",
          ...(handoff.imageCredit ? { credit: handoff.imageCredit } : {}),
        })
      );
      used = true;
    }
    if (used) setHistory(createHistory(next));
    if (handoff.promptText) {
      setAiPrompt(handoff.promptText);
      used = true;
    }
    if (used) {
      setHandoffNote(`Carried over from ${handoff.from ?? "another Studio tool"}.`);
    }
  }, []);

  // ── Document mutation helpers ────────────────────────────────────
  const applyDoc = (next: ThumbnailDoc) => {
    setHistory((h) => historyPush(h, next));
    setSaved(false);
  };

  const patchSelected = (patch: Partial<ThumbLayer>) => {
    if (!selected) return;
    applyDoc(updateLayer(doc, selected.id, patch));
  };

  const addImageFitted = (src: string, credit?: string) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageCacheRef.current.set(src, img);
      setImgVersion((v) => v + 1);
      const natW = img.naturalWidth || 640;
      const natH = img.naturalHeight || 360;
      const fitScale = Math.min(1, 1152 / natW, 648 / natH);
      const width = Math.round(natW * fitScale);
      const height = Math.round(natH * fitScale);
      const layer = createImageLayer({
        src,
        x: Math.round((1280 - width) / 2),
        y: Math.round((720 - height) / 2),
        width,
        height,
        fit: "cover",
        ...(credit ? { credit } : {}),
      });
      applyDoc(addLayer(doc, layer));
      setSelectedLayerId(layer.id);
    };
    img.onerror = () => {
      const layer = createImageLayer({ src, x: 320, y: 180, width: 640, height: 360, ...(credit ? { credit } : {}) });
      applyDoc(addLayer(doc, layer));
      setSelectedLayerId(layer.id);
    };
    img.src = src;
  };

  const onUploadImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") addImageFitted(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const onUploadBackground = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        applyDoc(setBackground(doc, { type: "image", imageSrc: reader.result }));
      }
    };
    reader.readAsDataURL(file);
  };

  // ── Pointer interaction ──────────────────────────────────────────
  const toCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (1280 / rect.width),
      y: (e.clientY - rect.top) * (720 / rect.height),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toCanvasPoint(e);
    canvasRef.current?.setPointerCapture(e.pointerId);

    if (selected && selected.visible) {
      const rotateHandle = layerCanvasPoint(selected, 0, -selected.height / 2 - 24);
      if (distance(point, rotateHandle) <= 16) {
        dragRef.current = {
          mode: "rotate", layerId: selected.id, startDoc: doc, original: selected,
          startX: point.x, startY: point.y, cornerX: 1, cornerY: 1,
        };
        return;
      }
      const corners: { lx: number; ly: number; cx: -1 | 1; cy: -1 | 1 }[] = [
        { lx: -selected.width / 2, ly: -selected.height / 2, cx: -1, cy: -1 },
        { lx: selected.width / 2, ly: -selected.height / 2, cx: 1, cy: -1 },
        { lx: -selected.width / 2, ly: selected.height / 2, cx: -1, cy: 1 },
        { lx: selected.width / 2, ly: selected.height / 2, cx: 1, cy: 1 },
      ];
      for (const corner of corners) {
        if (distance(point, layerCanvasPoint(selected, corner.lx, corner.ly)) <= 14) {
          dragRef.current = {
            mode: "resize", layerId: selected.id, startDoc: doc, original: selected,
            startX: point.x, startY: point.y, cornerX: corner.cx, cornerY: corner.cy,
          };
          return;
        }
      }
    }

    const hitId = hitTestLayer(doc, point.x, point.y);
    if (!hitId) {
      setSelectedLayerId(null);
      return;
    }
    setSelectedLayerId(hitId);
    const layer = doc.layers.find((l) => l.id === hitId);
    if (!layer) return;
    dragRef.current = {
      mode: "move", layerId: hitId, startDoc: doc, original: layer,
      startX: point.x, startY: point.y, cornerX: 1, cornerY: 1,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = toCanvasPoint(e);
    const orig = drag.original;
    let next: ThumbnailDoc;
    if (drag.mode === "move") {
      next = updateLayer(drag.startDoc, drag.layerId, {
        x: orig.x + (point.x - drag.startX),
        y: orig.y + (point.y - drag.startY),
      });
    } else if (drag.mode === "rotate") {
      const cx = orig.x + orig.width / 2;
      const cy = orig.y + orig.height / 2;
      const angleDeg = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI;
      next = updateLayer(drag.startDoc, drag.layerId, { rotation: angleDeg + 90 });
    } else {
      // Resize in layer-local space; the opposite corner stays anchored
      // because the centre moves by half the corner's local delta.
      const deltaCanvas = { x: point.x - drag.startX, y: point.y - drag.startY };
      const local = rotatePoint(deltaCanvas.x, deltaCanvas.y, -orig.rotation);
      const width = Math.max(20, orig.width + drag.cornerX * local.x);
      const height = Math.max(20, orig.height + drag.cornerY * local.y);
      // The applied local delta after clamping, halved, is the centre shift.
      const appliedLocal = {
        x: (width - orig.width) * drag.cornerX,
        y: (height - orig.height) * drag.cornerY,
      };
      const centreShift = rotatePoint(appliedLocal.x / 2, appliedLocal.y / 2, orig.rotation);
      const cx = orig.x + orig.width / 2 + centreShift.x;
      const cy = orig.y + orig.height / 2 + centreShift.y;
      next = updateLayer(drag.startDoc, drag.layerId, {
        width, height, x: cx - width / 2, y: cy - height / 2,
      });
    }
    // During the drag the present is updated WITHOUT pushing history;
    // a single push happens on pointer-up.
    setHistory((h) => ({ ...h, present: next }));
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    setHistory((h) => {
      if (h.present === drag.startDoc) return h;
      return historyPush({ ...h, present: drag.startDoc }, h.present);
    });
    setSaved(false);
  };

  // ── Export & save ────────────────────────────────────────────────
  const renderToCanvas = (w: number, h: number): HTMLCanvasElement => {
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const raw = off.getContext("2d")!;
    if (w !== 1280 || h !== 720) raw.scale(w / 1280, h / 720);
    renderThumbnailDoc(raw as unknown as ThumbCanvasContext, doc, resolveImage);
    return off;
  };

  const exportPng = () => {
    const off = renderToCanvas(1280, 720);
    const anchor = document.createElement("a");
    anchor.href = off.toDataURL("image/png");
    anchor.download = "thumbnail.png";
    anchor.click();
  };

  const saveToProjects = () => {
    const previewDataUrl = renderToCanvas(320, 180).toDataURL("image/png");
    const firstText = doc.layers.find((l): l is ThumbTextLayer => l.kind === "text");
    const title =
      firstText?.text.trim().split("\n")[0]?.slice(0, 80) || "Untitled thumbnail";
    const payload: ThumbnailProjectPayload = { doc, previewDataUrl };
    try {
      getBrowserProjectStore().save({
        kind: "thumbnail",
        title,
        summary: `${doc.layers.length} layers · 1280×720`,
        payload,
      });
      setSaved(true);
      setSaveError(null);
    } catch {
      setSaved(false);
      setSaveError(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE);
    }
  };

  // ── AI image generation ──────────────────────────────────────────
  const generateAiImage = async () => {
    const prompt = aiPrompt.trim();
    if (prompt.length < 3 || aiBusy) return;
    setAiBusy(true);
    setAiNote(null);
    const outcome = await requestAiImage({ prompt });
    setAiBusy(false);
    if (outcome.status === "ok") {
      addImageFitted(outcome.imageDataUrl);
      setAiNote("Generated with Workers AI (FLUX.1-schnell) — free tier");
      return;
    }
    switch (outcome.status) {
      case "not_configured":
        setAiNote(
          "AI image generation is not configured on this workspace yet. The editor works fully without it — upload your own images or use stock from the Libraries."
        );
        break;
      case "quota_reached":
        setAiNote("Today's shared free image quota is used up. Try again tomorrow, or upload your own image instead.");
        break;
      case "daily_quota_reached":
        setAiNote("You have reached today's per-person free image limit. The editor works fully with your own uploads in the meantime.");
        break;
      case "rate_limited":
        setAiNote("Too many image requests in a minute — wait a moment and try again.");
        break;
      case "signed_out":
        setAiNote("Sign in again to generate AI images — the editor itself works either way.");
        break;
      default:
        setAiNote("The free AI image service did not respond just now. Try again in a moment, or upload your own image.");
    }
  };

  const fitScale = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const available = wrap.clientWidth - 2;
    if (available > 0) setScale(Math.max(0.25, Math.min(1.5, available / 1280)));
  };

  const credits = Array.from(
    new Set(
      doc.layers
        .filter((l): l is ThumbImageLayer => l.kind === "image")
        .map((l) => l.credit)
        .filter((c): c is string => typeof c === "string" && c.length > 0)
    )
  );

  const bg = doc.background;

  return (
    <div className="space-y-5">
      <StudioToolHeader
        icon={ImageIcon}
        title="Thumbnail Editor"
        purpose="Compose a 1280×720 thumbnail on a canvas editor with templates and your own images."
        points={[
          "Layer-based canvas with drag, resize and rotate",
          "Templates, text, shapes, backgrounds and your own images",
          "Exports a PNG at exactly 1280×720; optional AI images on the free tier",
        ]}
      />
      <div className={studioCardClass}>
        <p className="text-[13px] text-muted-foreground">
          Design a thumbnail on a 1280×720 canvas and export it as a PNG at exactly that size.
          Everything edits locally in your browser; AI images are an optional extra.
        </p>
        {handoffNote && <p className="mt-3 text-xs text-muted-foreground">{handoffNote}</p>}
      </div>

      {/* Toolbar */}
      <div className={studioCardClass}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              const layer = createTextLayer({ x: 90 + doc.layers.length * 12, y: 90 + doc.layers.length * 12 });
              applyDoc(addLayer(doc, layer));
              setSelectedLayerId(layer.id);
            }}
          >
            <Type className="w-3.5 h-3.5" /> Add text
          </button>
          <select
            className={smallInputClass}
            style={{ width: "auto" }}
            value={shapeToAdd}
            onChange={(e) => setShapeToAdd(e.target.value as ThumbShapeLayer["shape"])}
            aria-label="Shape type"
          >
            <option value="rect">Rectangle</option>
            <option value="roundRect">Rounded rectangle</option>
            <option value="ellipse">Ellipse</option>
          </select>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              const layer = createShapeLayer({
                shape: shapeToAdd,
                x: 120 + doc.layers.length * 12,
                y: 120 + doc.layers.length * 12,
              });
              applyDoc(addLayer(doc, layer));
              setSelectedLayerId(layer.id);
            }}
          >
            <Shapes className="w-3.5 h-3.5" /> Add shape
          </button>
          <button type="button" className={secondaryButtonClass} onClick={() => uploadRef.current?.click()}>
            <Upload className="w-3.5 h-3.5" /> Upload image
          </button>
          <input
            ref={uploadRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              onUploadImage(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <span className="mx-1 h-5 w-px bg-border" />
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setHistory((h) => historyUndo(h))}
            disabled={history.past.length === 0}
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setHistory((h) => historyRedo(h))}
            disabled={history.future.length === 0}
          >
            <Redo2 className="w-3.5 h-3.5" /> Redo
          </button>
          <span className="mx-1 h-5 w-px bg-border" />
          <button type="button" className={secondaryButtonClass} onClick={fitScale}>
            Fit
          </button>
          <input
            type="range"
            min={0.25}
            max={1.5}
            step={0.05}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            aria-label="Zoom"
            className="w-28"
          />
          <span className="text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
          <span className="flex-1" />
          <button type="button" className={secondaryButtonClass} onClick={exportPng}>
            <Download className="w-3.5 h-3.5" /> Export PNG
          </button>
          <button
            type="button"
            className={studioPrimaryButtonClass}
            onClick={saveToProjects}
            disabled={saved}
          >
            {saved ? <Check className="w-4 h-4" /> : <BookmarkPlus className="w-4 h-4" />}
            {saved ? "Saved" : "Save to Projects"}
          </button>
        </div>
        {saveError && (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {saveError}
          </p>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[260px_minmax(0,1fr)_300px]">
        {/* Left column */}
        <div className="space-y-5">
          <div className={studioCardClass}>
            <h3 className="text-sm font-medium">Templates</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Applying a template replaces the current design (undo brings it back).
            </p>
            <div className="mt-3 space-y-2">
              {THUMB_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="w-full rounded-md border border-border px-3 py-2 text-left hover:bg-muted/60 transition-colors"
                  onClick={() => {
                    applyDoc(template.build());
                    setSelectedLayerId(null);
                  }}
                >
                  <span className="block text-xs font-medium text-foreground">{template.name}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{template.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={studioCardClass}>
            <h3 className="text-sm font-medium">Layers</h3>
            {doc.layers.length === 0 && (
              <p className="mt-2 text-xs text-muted-foreground">No layers yet — add text, a shape or an image.</p>
            )}
            <div className="mt-3 space-y-1.5">
              {[...doc.layers].reverse().map((layer) => (
                <div
                  key={layer.id}
                  className={cn(
                    "flex items-center gap-1 rounded-md border px-2 py-1.5",
                    layer.id === selectedLayerId ? "border-primary/50 bg-primary/10" : "border-border"
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-xs text-foreground"
                    onClick={() => setSelectedLayerId(layer.id)}
                    title={layer.name}
                  >
                    {layer.name}
                    <span className="ml-1 text-muted-foreground">({layer.kind})</span>
                  </button>
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => applyDoc(updateLayer(doc, layer.id, { visible: !layer.visible }))}
                    title={layer.visible ? "Hide layer" : "Show layer"}
                  >
                    {layer.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => applyDoc(moveLayer(doc, layer.id, "up"))}
                    title="Move up"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => applyDoc(moveLayer(doc, layer.id, "down"))}
                    title="Move down"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      const next = duplicateLayer(doc, layer.id);
                      applyDoc(next);
                    }}
                    title="Duplicate layer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      applyDoc(removeLayer(doc, layer.id));
                      if (selectedLayerId === layer.id) setSelectedLayerId(null);
                    }}
                    title="Delete layer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className={studioCardClass}>
            <h3 className="text-sm font-medium">Background</h3>
            <div className="mt-3 space-y-3">
              <div>
                <label className={studioLabelClass}>Type</label>
                <select
                  className={smallInputClass}
                  value={bg.type}
                  onChange={(e) =>
                    applyDoc(setBackground(doc, { type: e.target.value as typeof bg.type }))
                  }
                >
                  <option value="solid">Solid colour</option>
                  <option value="gradient">Gradient</option>
                  <option value="image">Image</option>
                </select>
              </div>
              {bg.type === "solid" && (
                <ColorField label="Colour" value={bg.color} onChange={(v) => applyDoc(setBackground(doc, { color: v }))} />
              )}
              {bg.type === "gradient" && (
                <>
                  <ColorField label="From" value={bg.gradientFrom} onChange={(v) => applyDoc(setBackground(doc, { gradientFrom: v }))} />
                  <ColorField label="To" value={bg.gradientTo} onChange={(v) => applyDoc(setBackground(doc, { gradientTo: v }))} />
                  <NumberField label="Angle (degrees)" value={bg.gradientAngle} onChange={(v) => applyDoc(setBackground(doc, { gradientAngle: v }))} />
                </>
              )}
              {bg.type === "image" && (
                <>
                  <ColorField label="Fallback colour" value={bg.color} onChange={(v) => applyDoc(setBackground(doc, { color: v }))} />
                  <div>
                    <label className={studioLabelClass}>Fit</label>
                    <select
                      className={smallInputClass}
                      value={bg.imageFit}
                      onChange={(e) => applyDoc(setBackground(doc, { imageFit: e.target.value as typeof bg.imageFit }))}
                    >
                      <option value="cover">Cover</option>
                      <option value="contain">Contain</option>
                      <option value="fill">Fill</option>
                    </select>
                  </div>
                  <button type="button" className={secondaryButtonClass} onClick={() => bgUploadRef.current?.click()}>
                    <Upload className="w-3.5 h-3.5" /> Upload background image
                  </button>
                  <input
                    ref={bgUploadRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      onUploadBackground(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        {/* Centre column */}
        <div className="min-w-0 space-y-3">
          <div ref={wrapRef} className="overflow-auto rounded-xl border border-border bg-muted/30 p-2">
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              style={{ width: `${1280 * scale}px`, height: `${720 * scale}px` }}
              className="block touch-none bg-black shadow"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Drag a layer to move it, drag a corner to resize, and drag the top handle to rotate.
          </p>
          {credits.length > 0 && (
            <p className="text-xs text-muted-foreground">Image credits: {credits.join(" · ")}</p>
          )}

          <div className={studioCardClass}>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="w-4 h-4" /> AI image (free tier)
            </h3>
            <div className="mt-3">
              <label className={studioLabelClass} htmlFor="thumb-ai-prompt">Prompt</label>
              <textarea
                id="thumb-ai-prompt"
                className={studioInputClass}
                placeholder="e.g. a surprised robot looking at a glowing laptop, bold colours"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                rows={3}
                maxLength={600}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={studioPrimaryButtonClass}
                onClick={generateAiImage}
                disabled={aiBusy || aiPrompt.trim().length < 3}
              >
                {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Generate image
              </button>
              {aiNote && <p className="text-xs text-muted-foreground">{aiNote}</p>}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Free tier: AI generations draw from one shared daily pool for the whole workspace
              (about 57 images a day in total), so generations are limited per person.
            </p>
          </div>
        </div>

        {/* Right column: properties */}
        <div className={studioCardClass}>
          <h3 className="text-sm font-medium">Properties</h3>
          {!selected && (
            <p className="mt-2 text-xs text-muted-foreground">
              Select a layer on the canvas or in the Layers list to edit its properties.
            </p>
          )}
          {selected && (
            <div className="mt-3 space-y-3">
              <div>
                <label className={studioLabelClass}>Name</label>
                <input
                  type="text"
                  className={smallInputClass}
                  value={selected.name}
                  onChange={(e) => patchSelected({ name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="X" value={selected.x} onChange={(v) => patchSelected({ x: v })} />
                <NumberField label="Y" value={selected.y} onChange={(v) => patchSelected({ y: v })} />
                <NumberField label="Width" value={selected.width} onChange={(v) => patchSelected({ width: v })} />
                <NumberField label="Height" value={selected.height} onChange={(v) => patchSelected({ height: v })} />
                <NumberField label="Rotation (°)" value={selected.rotation} onChange={(v) => patchSelected({ rotation: v })} />
                <NumberField label="Opacity (0–1)" value={selected.opacity} step={0.05} min={0} max={1} onChange={(v) => patchSelected({ opacity: v })} />
              </div>

              {selected.kind === "text" && (
                <>
                  <div>
                    <label className={studioLabelClass}>Text</label>
                    <textarea
                      className={smallInputClass}
                      value={(selected as ThumbTextLayer).text}
                      rows={3}
                      onChange={(e) => patchSelected({ text: e.target.value } as Partial<ThumbLayer>)}
                    />
                  </div>
                  <div>
                    <label className={studioLabelClass}>Font</label>
                    <select
                      className={smallInputClass}
                      value={(selected as ThumbTextLayer).font}
                      onChange={(e) => patchSelected({ font: e.target.value } as Partial<ThumbLayer>)}
                    >
                      {THUMB_FONT_STACKS.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField label="Size (px)" value={(selected as ThumbTextLayer).fontSize} onChange={(v) => patchSelected({ fontSize: v } as Partial<ThumbLayer>)} />
                    <div>
                      <label className={studioLabelClass}>Weight</label>
                      <select
                        className={smallInputClass}
                        value={(selected as ThumbTextLayer).fontWeight}
                        onChange={(e) => patchSelected({ fontWeight: Number(e.target.value) } as Partial<ThumbLayer>)}
                      >
                        {[400, 600, 700, 800, 900].map((w) => (
                          <option key={w} value={w}>{w}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <ColorField label="Colour" value={(selected as ThumbTextLayer).color} onChange={(v) => patchSelected({ color: v } as Partial<ThumbLayer>)} />
                  <div>
                    <label className={studioLabelClass}>Align</label>
                    <div className="flex gap-1.5">
                      {(["left", "center", "right"] as const).map((align) => (
                        <button
                          key={align}
                          type="button"
                          className={cn(
                            "flex-1 rounded-md border px-2 py-1.5 text-xs capitalize transition-colors",
                            (selected as ThumbTextLayer).align === align
                              ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                              : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
                          )}
                          onClick={() => patchSelected({ align } as Partial<ThumbLayer>)}
                        >
                          {align}
                        </button>
                      ))}
                    </div>
                  </div>
                  <ColorField label="Stroke colour" value={(selected as ThumbTextLayer).strokeColor} onChange={(v) => patchSelected({ strokeColor: v } as Partial<ThumbLayer>)} />
                  <NumberField label="Stroke width" value={(selected as ThumbTextLayer).strokeWidth} min={0} onChange={(v) => patchSelected({ strokeWidth: Math.max(0, v) } as Partial<ThumbLayer>)} />
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={(selected as ThumbTextLayer).shadow}
                      onChange={(e) => patchSelected({ shadow: e.target.checked } as Partial<ThumbLayer>)}
                    />
                    Text shadow
                  </label>
                </>
              )}

              {selected.kind === "image" && (
                <>
                  <div>
                    <label className={studioLabelClass}>Fit</label>
                    <select
                      className={smallInputClass}
                      value={(selected as ThumbImageLayer).fit}
                      onChange={(e) => patchSelected({ fit: e.target.value } as Partial<ThumbLayer>)}
                    >
                      <option value="cover">Cover</option>
                      <option value="contain">Contain</option>
                      <option value="fill">Fill</option>
                    </select>
                  </div>
                  {(selected as ThumbImageLayer).credit && (
                    <div>
                      <label className={studioLabelClass}>Credit</label>
                      <p className="text-xs text-muted-foreground">{(selected as ThumbImageLayer).credit}</p>
                    </div>
                  )}
                  {!(selected as ThumbImageLayer).src && (
                    <p className="text-xs text-muted-foreground">
                      This is an empty photo slot — upload an image, generate one with AI, or bring
                      one over from the Libraries to fill it.
                    </p>
                  )}
                </>
              )}

              {selected.kind === "shape" && (
                <>
                  <div>
                    <label className={studioLabelClass}>Shape</label>
                    <select
                      className={smallInputClass}
                      value={(selected as ThumbShapeLayer).shape}
                      onChange={(e) => patchSelected({ shape: e.target.value } as Partial<ThumbLayer>)}
                    >
                      <option value="rect">Rectangle</option>
                      <option value="roundRect">Rounded rectangle</option>
                      <option value="ellipse">Ellipse</option>
                    </select>
                  </div>
                  <ColorField label="Fill" value={(selected as ThumbShapeLayer).fill} onChange={(v) => patchSelected({ fill: v } as Partial<ThumbLayer>)} />
                  <ColorField label="Stroke colour" value={(selected as ThumbShapeLayer).strokeColor} onChange={(v) => patchSelected({ strokeColor: v } as Partial<ThumbLayer>)} />
                  <NumberField label="Stroke width" value={(selected as ThumbShapeLayer).strokeWidth} min={0} onChange={(v) => patchSelected({ strokeWidth: Math.max(0, v) } as Partial<ThumbLayer>)} />
                  <NumberField label="Corner radius" value={(selected as ThumbShapeLayer).cornerRadius} min={0} onChange={(v) => patchSelected({ cornerRadius: Math.max(0, v) } as Partial<ThumbLayer>)} />
                </>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
