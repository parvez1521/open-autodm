/**
 * Thumbnail Editor — PAUSED state (owner decision, 2026-11-07).
 *
 * The owner took the Thumbnail Editor off the preview for now ("baad
 * me sochenge"). The pause is deliberately shallow and reversible:
 *
 *  - hidden from the Studio sidebar, the Studio home workflow +
 *    directory, and the landing page's Creator Studio index;
 *  - every in-Studio entry point that routed into it (Library "Use in
 *    Thumbnail", Projects "Open in Thumbnail Editor", the Prompt
 *    Library's thumbnail hand-off) is removed;
 *  - its route redirects to the Studio home in middleware;
 *  - the editor page, its engine (lib/studio/thumbnail.ts) and the
 *    hand-off store stay in the tree byte-for-byte, so restoring the
 *    tool is a small, known change. These pins keep the pause honest:
 *    no surface may quietly link back into a closed tool, and the
 *    code that must survive the pause may not quietly disappear.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("Thumbnail Editor paused (owner decision 2026-11-07)", () => {
  it("middleware redirects the editor route to the Studio home", () => {
    const mw = read("middleware.ts");
    expect(mw).toContain("pathname === '/studio/thumbnail'");
    expect(mw).toContain("redirectUrl.pathname = '/studio';");
  });

  it("no navigation, directory or landing surface links to the editor", () => {
    for (const rel of [
      "components/studio/StudioNav.tsx",
      "app/(main)/studio/page.tsx",
      "app/page.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toContain("/studio/thumbnail");
      expect(src, rel).not.toContain("Thumbnail Editor");
    }
  });

  it("no Studio page routes or hands off into the editor", () => {
    for (const rel of [
      "app/(main)/studio/library/page.tsx",
      "app/(main)/studio/projects/page.tsx",
      "app/(main)/studio/prompts/page.tsx",
    ]) {
      expect(read(rel), rel).not.toContain("/studio/thumbnail");
    }
  });

  it("the editor code, engine and hand-off store remain, restore-ready", () => {
    const page = read("app/(main)/studio/thumbnail/page.tsx");
    expect(page).toContain("if (used) setHistory(createHistory(next));");
    expect(page).toContain("STUDIO_PROJECTS_SAVE_FAILED_MESSAGE");
    expect(read("lib/studio/thumbnail.ts")).toContain("createThumbnailDoc");
    expect(read("lib/studio/handoff.ts")).toContain("setThumbnail");
  });
});
