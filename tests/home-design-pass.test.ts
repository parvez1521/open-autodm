/**
 * Design pass (2026-11-07) — landing-page interactive additions.
 *
 * The owner asked for a more professional, interactive landing page.
 * Two components were added, both additive (no pinned copy moved):
 *  - DemoShowcase: a user-driven comment-to-DM simulation with three
 *    keyword scenarios, staged on timers, reduced-motion safe.
 *  - FaqSection: an accessible accordion whose answers stay
 *    product-truthful (free self-hosting, own Meta app, three
 *    permissions, shipped sending caps, hosted plan in preparation).
 * These pins keep the additions wired into the page and honest.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("design pass — DemoShowcase", () => {
  const src = read("components/home/DemoShowcase.tsx");

  it("exists, is used by the landing page, and the page anchors it at #demo", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("DemoShowcase");
    expect(page).toContain('id="demo"');
    expect(page).toContain('href: "#demo"');
  });

  it("carries the three keyword scenarios with product-truthful DM copy", () => {
    for (const kw of ["PRICE", "LINK", "DEMO"]) expect(src).toContain(kw);
    expect(src).toContain("Sent you the");
    expect(src).toContain("24-hour window");
  });

  it("is staged on timers, auto-runs once in view, and honours reduced motion", () => {
    expect(src).toContain("IntersectionObserver");
    expect(src).toContain("prefers-reduced-motion");
    expect(src).toContain("setTimeout");
  });
});

describe("design pass — FaqSection", () => {
  const src = read("components/home/FaqSection.tsx");

  it("exists, is used by the landing page, and the page anchors it at #faq", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("FaqSection");
    expect(page).toContain('id="faq"');
    expect(page).toContain('href: "#faq"');
  });

  it("is an accessible accordion (real buttons, aria-expanded)", () => {
    expect(src).toContain("aria-expanded");
    expect(src).toContain('type="button"');
  });

  it("answers stay product-truthful: free self-host, own Meta app, three permissions, shipped caps", () => {
    expect(src).toContain("MIT licence");
    expect(src).toContain("exactly three Instagram permissions");
    expect(src).toContain("180 DMs per hour");
    expect(src).toContain("in preparation");
  });
});
