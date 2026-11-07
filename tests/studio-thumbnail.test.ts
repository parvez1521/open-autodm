/**
 * Area — Creator Studio Thumbnail Editor engine (Programme S3).
 */

import { describe, it, expect } from "vitest";
import {
  THUMB_FONT_STACKS,
  THUMB_TEMPLATES,
  addLayer,
  clampLayer,
  computeFitRect,
  createHistory,
  createImageLayer,
  createShapeLayer,
  createTextLayer,
  createThumbnailDoc,
  duplicateLayer,
  hitTestLayer,
  historyPush,
  historyRedo,
  historyUndo,
  moveLayer,
  removeLayer,
  renderThumbnailDoc,
  setBackground,
  thumbnailDocFromJson,
  thumbnailDocToJson,
  updateLayer,
  wrapTextLines,
  type ThumbCanvasContext,
} from "@/lib/studio/thumbnail";

describe("document operations", () => {
  it("creates a 1280x720 doc with the solid ink default background and no layers", () => {
    const doc = createThumbnailDoc();
    expect(doc.width).toBe(1280);
    expect(doc.height).toBe(720);
    // Default background is a solid deep ink since the owner's design
    // ban (2026-11-07) prohibited the old blue-to-purple gradient.
    expect(doc.background.type).toBe("solid");
    expect(doc.background.color).toBe("#111827");
    expect(doc.layers).toEqual([]);
    expect(THUMB_FONT_STACKS.length).toBeGreaterThanOrEqual(5);
  });

  it("adds, updates and removes layers immutably", () => {
    const doc = createThumbnailDoc();
    const layer = createTextLayer({ text: "Hello" });
    const withLayer = addLayer(doc, layer);
    expect(doc.layers).toHaveLength(0);
    expect(withLayer.layers).toHaveLength(1);
    const updated = updateLayer(withLayer, layer.id, { x: 55 });
    expect(updated.layers[0]!.x).toBe(55);
    expect(withLayer.layers[0]!.x).not.toBe(55);
    const removed = removeLayer(updated, layer.id);
    expect(removed.layers).toHaveLength(0);
  });

  it("duplicates with an offset, a 'copy' name and a new id, above the original", () => {
    const a = createTextLayer({ name: "Title" });
    const b = createShapeLayer({ name: "Box" });
    let doc = addLayer(createThumbnailDoc(), a);
    doc = addLayer(doc, b);
    const dup = duplicateLayer(doc, a.id);
    expect(dup.layers).toHaveLength(3);
    const copy = dup.layers[1]!;
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).toBe("Title copy");
    expect(copy.x).toBe(a.x + 16);
    expect(copy.y).toBe(a.y + 16);
    expect(dup.layers[2]!.id).toBe(b.id);
  });

  it("moves layers up, down, to top and to bottom (index 0 is bottom)", () => {
    const a = createTextLayer({ name: "A" });
    const b = createTextLayer({ name: "B" });
    const c = createTextLayer({ name: "C" });
    let doc = createThumbnailDoc();
    doc = addLayer(addLayer(addLayer(doc, a), b), c);
    expect(moveLayer(doc, a.id, "up").layers.map((l) => l.name)).toEqual(["B", "A", "C"]);
    expect(moveLayer(doc, c.id, "down").layers.map((l) => l.name)).toEqual(["A", "C", "B"]);
    expect(moveLayer(doc, a.id, "top").layers.map((l) => l.name)).toEqual(["B", "C", "A"]);
    expect(moveLayer(doc, c.id, "bottom").layers.map((l) => l.name)).toEqual(["C", "A", "B"]);
  });

  it("sets the background immutably", () => {
    const doc = createThumbnailDoc();
    const next = setBackground(doc, { type: "solid", color: "#123456" });
    expect(next.background.type).toBe("solid");
    expect(next.background.color).toBe("#123456");
    expect(doc.background.type).toBe("solid");
    expect(doc.background.color).toBe("#111827");
  });
});

describe("clampLayer", () => {
  it("enforces minimum size, opacity range and rotation normalisation", () => {
    const layer = clampLayer(createTextLayer({ width: 5, height: 1, opacity: 3, rotation: 270, fontSize: 9999 }));
    expect(layer.width).toBe(20);
    expect(layer.height).toBe(20);
    expect(layer.opacity).toBe(1);
    expect(layer.rotation).toBe(-90);
    expect(layer.fontSize).toBe(400);
    expect(clampLayer(createTextLayer({ rotation: -180 })).rotation).toBe(180);
    expect(clampLayer(createTextLayer({ rotation: 180 })).rotation).toBe(180);
    expect(clampLayer(createTextLayer({ fontSize: 2 })).fontSize).toBe(8);
    expect(clampLayer(createShapeLayer({ opacity: -1 })).opacity).toBe(0);
  });
});

describe("history", () => {
  it("pushes, undoes and redoes; push clears the redo stack", () => {
    const d0 = createThumbnailDoc();
    const d1 = addLayer(d0, createTextLayer({ name: "One" }));
    const d2 = addLayer(d1, createTextLayer({ name: "Two" }));
    let h = createHistory(d0);
    h = historyPush(h, d1);
    h = historyPush(h, d2);
    expect(h.present).toBe(d2);
    h = historyUndo(h);
    expect(h.present).toBe(d1);
    h = historyRedo(h);
    expect(h.present).toBe(d2);
    h = historyUndo(h);
    const d3 = addLayer(d1, createShapeLayer({}));
    h = historyPush(h, d3);
    expect(h.future).toEqual([]);
    expect(historyRedo(h)).toBe(h);
  });

  it("undo at the start and redo at the end are no-ops returning the same state", () => {
    const h = createHistory(createThumbnailDoc());
    expect(historyUndo(h)).toBe(h);
    expect(historyRedo(h)).toBe(h);
  });

  it("enforces the cap of 50 past entries", () => {
    let h = createHistory(createThumbnailDoc());
    for (let i = 0; i < 80; i++) {
      h = historyPush(h, addLayer(createThumbnailDoc(), createTextLayer({ name: `L${i}` })));
    }
    expect(h.past.length).toBe(50);
  });
});

describe("templates", () => {
  it("has at least 6 templates, each building a valid doc with >=2 layers", () => {
    expect(THUMB_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    for (const t of THUMB_TEMPLATES) {
      const doc = t.build();
      expect(doc.width).toBe(1280);
      expect(doc.height).toBe(720);
      expect(doc.layers.length).toBeGreaterThanOrEqual(2);
      const ids = doc.layers.map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("produces unique layer ids across two builds of the same template", () => {
    for (const t of THUMB_TEMPLATES) {
      const ids = new Set([...t.build().layers, ...t.build().layers].map((l) => l.id));
      expect(ids.size).toBe(t.build().layers.length * 2);
    }
  });
});

describe("computeFitRect", () => {
  it("cover crops a 1000x500 image into a 400x400 box", () => {
    expect(computeFitRect(1000, 500, 400, 400, "cover")).toEqual({
      sx: 250, sy: 0, sw: 500, sh: 500, dx: 0, dy: 0, dw: 400, dh: 400,
    });
  });
  it("contain letterboxes a 1000x500 image into a 400x400 box", () => {
    expect(computeFitRect(1000, 500, 400, 400, "contain")).toEqual({
      sx: 0, sy: 0, sw: 1000, sh: 500, dx: 0, dy: 100, dw: 400, dh: 200,
    });
  });
  it("fill stretches a 1000x500 image into a 400x400 box", () => {
    expect(computeFitRect(1000, 500, 400, 400, "fill")).toEqual({
      sx: 0, sy: 0, sw: 1000, sh: 500, dx: 0, dy: 0, dw: 400, dh: 400,
    });
  });
});

describe("wrapTextLines", () => {
  const measure = (s: string) => s.length * 10;
  it("wraps on word boundaries using the injected measure", () => {
    expect(wrapTextLines("aa bb cc dd", 50, measure)).toEqual(["aa bb", "cc dd"]);
  });
  it("honours explicit newlines", () => {
    expect(wrapTextLines("aa\nbb cc", 100, measure)).toEqual(["aa", "bb cc"]);
  });
});

describe("hitTestLayer", () => {
  it("hits a plain layer and misses outside it", () => {
    const layer = createShapeLayer({ x: 100, y: 100, width: 200, height: 100 });
    const doc = addLayer(createThumbnailDoc(), layer);
    expect(hitTestLayer(doc, 150, 150)).toBe(layer.id);
    expect(hitTestLayer(doc, 50, 50)).toBeNull();
  });

  it("honours 90-degree rotation", () => {
    // A 200x100 layer at (100,100) rotated 90° occupies x 150..250, y 50..250.
    const layer = createShapeLayer({ x: 100, y: 100, width: 200, height: 100, rotation: 90 });
    const doc = addLayer(createThumbnailDoc(), layer);
    expect(hitTestLayer(doc, 200, 60)).toBe(layer.id);
    // Inside the unrotated box but outside the rotated one.
    expect(hitTestLayer(doc, 120, 120)).toBeNull();
  });

  it("returns the topmost layer and skips invisible layers", () => {
    const bottom = createShapeLayer({ name: "bottom", x: 0, y: 0, width: 300, height: 300 });
    const top = createShapeLayer({ name: "top", x: 0, y: 0, width: 300, height: 300 });
    let doc = addLayer(addLayer(createThumbnailDoc(), bottom), top);
    expect(hitTestLayer(doc, 100, 100)).toBe(top.id);
    doc = updateLayer(doc, top.id, { visible: false });
    expect(hitTestLayer(doc, 100, 100)).toBe(bottom.id);
  });
});

// ── Recording fake canvas context ────────────────────────────────

interface Call { method: string; args: unknown[] }

function fakeCtx() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const ctx = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    globalAlpha: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    lineWidth: 1,
    lineJoin: "",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
    fillRect: record("fillRect"),
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ method: "createLinearGradient", args });
      return { addColorStop: record("addColorStop") };
    },
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: record("fillText"),
    strokeText: record("strokeText"),
    beginPath: record("beginPath"),
    rect: record("rect"),
    roundRect: record("roundRect"),
    ellipse: record("ellipse"),
    fill: record("fill"),
    stroke: record("stroke"),
    drawImage: record("drawImage"),
  };
  return { ctx: ctx as unknown as ThumbCanvasContext, calls };
}

describe("renderThumbnailDoc", () => {
  it("paints the background first, then layers in order", () => {
    const { ctx, calls } = fakeCtx();
    let doc = setBackground(createThumbnailDoc(), { type: "solid", color: "#111111" });
    doc = addLayer(doc, createTextLayer({ text: "AAA", name: "first" }));
    doc = addLayer(doc, createTextLayer({ text: "BBB", name: "second" }));
    renderThumbnailDoc(ctx, doc, () => null);
    expect(calls[0]!.method).toBe("fillRect");
    const texts = calls.filter((c) => c.method === "fillText").map((c) => c.args[0]);
    expect(texts).toEqual(["AAA", "BBB"]);
  });

  it("produces no draw calls for an invisible layer", () => {
    const { ctx, calls } = fakeCtx();
    let doc = setBackground(createThumbnailDoc(), { type: "solid", color: "#111111" });
    const hidden = createTextLayer({ text: "HIDDEN", visible: false });
    doc = addLayer(doc, hidden);
    renderThumbnailDoc(ctx, doc, () => null);
    expect(calls.filter((c) => c.method === "fillText")).toHaveLength(0);
  });

  it("skips an empty-src image and an image whose resolver returns null", () => {
    const { ctx, calls } = fakeCtx();
    let doc = createThumbnailDoc();
    doc = addLayer(doc, createImageLayer({ src: "" }));
    doc = addLayer(doc, createImageLayer({ src: "https://example.test/x.png" }));
    renderThumbnailDoc(ctx, doc, () => null);
    expect(calls.filter((c) => c.method === "drawImage")).toHaveLength(0);
  });

  it("draws an image when the resolver provides one", () => {
    const { ctx, calls } = fakeCtx();
    let doc = createThumbnailDoc();
    doc = addLayer(doc, createImageLayer({ src: "data:image/png;base64,x" }));
    renderThumbnailDoc(ctx, doc, () => ({ width: 100, height: 100 }));
    expect(calls.filter((c) => c.method === "drawImage")).toHaveLength(1);
  });
});

describe("serialisation", () => {
  it("round-trips a document through JSON", () => {
    let doc = createThumbnailDoc();
    doc = addLayer(doc, createTextLayer({ text: "Round trip" }));
    doc = addLayer(doc, createImageLayer({ src: "data:image/png;base64,abc", credit: "Photo by A" }));
    doc = addLayer(doc, createShapeLayer({ shape: "ellipse" }));
    const restored = thumbnailDocFromJson(thumbnailDocToJson(doc));
    expect(restored).toEqual(doc);
    // Also accepts a parsed object.
    expect(thumbnailDocFromJson(JSON.parse(thumbnailDocToJson(doc)))).toEqual(doc);
  });

  it("rejects a wrong version", () => {
    const doc = createThumbnailDoc();
    expect(thumbnailDocFromJson(JSON.stringify({ ...doc, version: 2 }))).toBeNull();
  });

  it("rejects a bad layer kind", () => {
    const doc = addLayer(createThumbnailDoc(), createTextLayer({}));
    const bad = JSON.parse(thumbnailDocToJson(doc)) as { layers: { kind: string }[] };
    bad.layers[0]!.kind = "video";
    expect(thumbnailDocFromJson(bad)).toBeNull();
  });

  it("rejects non-objects and malformed strings without throwing", () => {
    expect(thumbnailDocFromJson(null)).toBeNull();
    expect(thumbnailDocFromJson(42)).toBeNull();
    expect(thumbnailDocFromJson("not json")).toBeNull();
    expect(thumbnailDocFromJson("{")).toBeNull();
  });
});
