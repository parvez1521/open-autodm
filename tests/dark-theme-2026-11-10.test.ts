/**
 * Full dark theme (owner directive, 2026-11-10 ~01:32 IST:
 * "Poori site bhi dark kar do"). Supersedes the cream/light Open
 * Caption restyle of 2026-11-09 for Open AutoDM: the site now runs
 * the dark system the owner approved on Open Caption — warm
 * near-black #141412 ground, #1C1C1A / #232320 surfaces, cream
 * #FFFFEB text, accents unchanged (lavender #F0D7FF, emerald
 * #34D399, orange #FFA946). Typography and all restyle animations
 * stay; the logo is the original solid orange (the 2026-11-12 UI
 * fix port restored it — the 2026-11-09 orange->emerald gradient
 * is gone; "logo pehle waala hi rakh").
 *
 * These pins keep the dark token set from silently drifting back
 * to a light palette, and keep the theme pinned dark-only.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("dark theme — token layer (2026-11-10)", () => {
  const css = read("app/globals.css");

  it(":root carries the dark tokens", () => {
    expect(css).toContain("--background: #141412;");
    expect(css).toContain("--foreground: #FFFFEB;");
    // Contrast step-up from the 2026-11-12 UI fix port: card
    // #1C1C1A -> #121215, muted text #A9A99C -> #B9B9C2, borders
    // #2E2E2A -> #2F2F37. 2026-11-13 contrast lift: muted text
    // #B9B9C2 -> #D6D6DE (9.5:1 -> 12.8:1 on ground) so secondary
    // text clears AA on every surface. Ground, ink and accents
    // are unchanged.
    expect(css).toContain("--card: #121215;");
    expect(css).toContain("--popover: #232320;");
    expect(css).toContain("--muted-foreground: #D6D6DE;");
    expect(css).toContain("--border: #2F2F37;");
  });

  it("no light ground survives as a semantic token", () => {
    expect(css).not.toContain("--background: #FFFFEB;");
    expect(css).not.toContain("--card: #FFFFEB;");
    expect(css).not.toContain("--muted: #F4F4E0;");
  });

  it("accents are unchanged from the restyle palette", () => {
    expect(css).toContain("--color-side: #F0D7FF;");
    expect(css).toContain("--color-emerald-accent: #34D399;");
    expect(css).toContain("--color-orange-accent: #FFA946;");
  });

  it("the sand scale is inverted (dark end first)", () => {
    expect(css).toContain("--color-sand-50: #141412;");
    expect(css).toContain("--color-sand-900: #FFFFEB;");
  });

  it("brand intro sheet and hero sweep anchors are dark-ground aware", () => {
    expect(css).toContain(
      ".oadm-intro [data-sheet] { position: absolute; inset: 0; background: #141412;",
    );
    // Sweep anchor: cream (was obsidian in the light theme).
    expect(css).toContain(
      "background: linear-gradient(90deg, #FFFFEB, #FFA946, #34D399, #FFFFEB);",
    );
    // Conic CTA ring keeps a visible light stop on dark.
    expect(css).toContain("#F0D7FF, #FFFFEB, #FFA946");
  });
});

describe("dark theme — pinning and surfaces (2026-11-10)", () => {
  it("the theme provider pins dark (no system/light escape)", () => {
    const providers = read("components/providers/Providers.tsx");
    expect(providers).toContain('defaultTheme="dark"');
    expect(providers).not.toContain("enableSystem");
  });

  it("the theme toggle is gone from every surface that carried it", () => {
    for (const f of [
      "app/page.tsx",
      "components/dashboard/Topbar.tsx",
      "components/legal/LegalLayout.tsx",
    ]) {
      expect(read(f)).not.toContain("ThemeToggle");
    }
    // 2026-11-12 UI fix port: the stub file itself is deleted (the
    // 2026-11-10 pass had left a REMOVED-marker stub behind).
    expect(
      fs.existsSync(path.join(ROOT, "components/ui/ThemeToggle.tsx")),
    ).toBe(false);
  });

  it("the sidebar's active item pairs lavender with obsidian text", () => {
    const sidebar = read("components/dashboard/Sidebar.tsx");
    expect(sidebar).toContain("bg-side text-obsidian font-semibold");
    expect(sidebar).not.toContain("bg-side text-foreground");
  });

  it("the OG image renders on the dark ground", () => {
    const og = read("app/opengraph-image.tsx");
    expect(og).toContain('backgroundColor: "#141412"');
    expect(og).toContain('color: "#FFFFEB"');
  });

  it("analytics uses the validated dark chart steps", () => {
    const page = read("app/(main)/analytics/page.tsx");
    expect(page).toContain("const colors = PALETTE.dark;");
    expect(page).toContain('const gridStroke = "#2E2E2A";');
  });

  it("the logo mark is the original solid orange (owner: pehle waala logo)", () => {
    // 2026-11-12 UI fix port: the 2026-11-09 orange->emerald gradient
    // is gone; the mark is the original solid brand orange #F97316
    // with a white bolt, and the wordmark accents autoDM in orange.
    const logo = read("components/ui/Logo.tsx");
    expect(logo).toContain('fill="#F97316"');
    expect(logo).not.toContain("oadm-grad");
    expect(logo).not.toContain("linearGradient");
    expect(logo).toContain('text-[#F97316]');
  });
});
