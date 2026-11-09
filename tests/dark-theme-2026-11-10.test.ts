/**
 * Full dark theme (owner directive, 2026-11-10 ~01:32 IST:
 * "Poori site bhi dark kar do"). Supersedes the cream/light Open
 * Caption restyle of 2026-11-09 for Open AutoDM: the site now runs
 * the dark system the owner approved on Open Caption — warm
 * near-black #141412 ground, #1C1C1A / #232320 surfaces, cream
 * #FFFFEB text, accents unchanged (lavender #F0D7FF, emerald
 * #34D399, orange #FFA946). Typography and all restyle animations
 * stay; the logo is untouched ("logo pehle waala hi rakh").
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
    expect(css).toContain("--card: #1C1C1A;");
    expect(css).toContain("--popover: #232320;");
    expect(css).toContain("--muted-foreground: #A9A99C;");
    expect(css).toContain("--border: #2E2E2A;");
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
    expect(read("components/ui/ThemeToggle.tsx")).toContain(
      "REMOVED 2026-11-10",
    );
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

  it("the logo mark is untouched (owner: pehle waala logo)", () => {
    const logo = read("components/ui/Logo.tsx");
    expect(logo).toContain('fill="url(#oadm-grad)"');
    expect(logo).toContain('<stop offset="0%" stopColor="#FFA946" />');
    expect(logo).toContain('<stop offset="100%" stopColor="#34D399" />');
  });
});
