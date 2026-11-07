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

describe("design pass round 2 — login split panel + mobile hero", () => {
  it("the login page carries the ink fact panel beside the unchanged form column", () => {
    const login = read("app/login/page.tsx");
    expect(login).toContain("bg-foreground");
    expect(login).toContain("Every comment answered. Every DM on time.");
    expect(login).toContain("180 DMs/hour, 24-hour window");
    expect(login).toContain("<LoginForm signupOpen={signupEnabled} />");
  });

  it("the landing hero has a mobile-only three-row loop visual (desktop keeps the NodeEditor)", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("lg:hidden");
    expect(page).toContain("A visitor comments your keyword");
    expect(page).toContain("The DM lands in their inbox");
  });
});

describe("design pass round 3 — FlowBuilder, CountUp, hero loop chip", () => {
  const builder = read("components/home/FlowBuilder.tsx");

  it("the builder is wired into the landing at #builder with all three controls", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("FlowBuilder");
    expect(page).toContain('id="builder"');
    expect(builder).toContain("Trigger keyword");
    expect(builder).toContain("Public reply style");
    expect(builder).toContain("What the DM carries");
    expect(builder).toContain('role="switch"');
  });

  it("the builder's texts stay template-true (three styles, three payloads, caps line)", () => {
    for (const label of ["Friendly", "Short", "Hinglish", "Send a link", "Send pricing", "Book a demo"]) {
      expect(builder).toContain(label);
    }
    expect(builder).toContain("180 DMs/hour, 24-hour window");
  });

  it("the safety figures animate via CountUp and stay the shipped caps", () => {
    const page = read("app/page.tsx");
    const counter = read("components/home/CountUp.tsx");
    expect(page).toContain("CountUp");
    expect(page).toContain("count: 180");
    expect(page).toContain('suffix: "h"');
    expect(counter).toContain("prefers-reduced-motion");
    expect(counter).toContain("IntersectionObserver");
  });

  it("the hero carries the cycling loop chip, reduced-motion aware", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("HeroLoopChip");
    expect(page).toContain("comment 'PRICE'");
    expect(page).toContain("prefers-reduced-motion");
  });
});
