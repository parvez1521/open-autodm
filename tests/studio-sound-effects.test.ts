/**
 * Sound Effects tab — the MyInstants-LINKED route (owner's choice,
 * 2026-11-07).
 *
 * The licensing shape is the feature: sounds stay on MyInstants. The
 * app links to each sound's canonical page and plays through the
 * OFFICIAL embed player MyInstants offers for every sound. These pins
 * keep that shape: no audio file URLs (myinstants.com/media/...) may
 * ever appear in the data or the page, every entry carries a verified
 * canonical page + matching embed URL, and the tab stays wired into
 * the Library.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  SOUND_EFFECTS,
  filterSoundEffects,
  myinstantsSearchUrl,
} from "../src/lib/studio/soundEffects";

const SRC = path.resolve(process.cwd(), "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("sound effects data — linked, never hosted", () => {
  it("carries the curated board of verified classics", () => {
    expect(SOUND_EFFECTS.length).toBe(12);
    const names = SOUND_EFFECTS.map((s) => s.name);
    for (const classic of ["Vine Boom", "Bruh", "Sad Violin", "Anime Wow", "Fart"]) {
      expect(names).toContain(classic);
    }
  });

  it("every entry links to a canonical MyInstants page with a matching official embed URL", () => {
    for (const s of SOUND_EFFECTS) {
      expect(s.pageUrl).toMatch(/^https:\/\/www\.myinstants\.com\/en\/instant\/[a-z0-9-]+\/$/);
      const slug = s.pageUrl.split("/instant/")[1]!.replace(/\/$/, "");
      expect(s.embedUrl).toBe(`https://www.myinstants.com/instant/${slug}/embed/`);
      expect(s.favorites).toBeGreaterThan(0);
    }
    const urls = SOUND_EFFECTS.map((s) => s.pageUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("no entry hotlinks or re-hosts an audio file", () => {
    const dataSrc = read("lib/studio/soundEffects.ts");
    expect(dataSrc).not.toContain("myinstants.com/media/");
    expect(dataSrc).not.toMatch(/\.mp3/);
  });

  it("search + filter behave (query, category, both)", () => {
    expect(filterSoundEffects("boom", "All").map((s) => s.name)).toEqual(["Vine Boom"]);
    expect(filterSoundEffects("", "Drama").map((s) => s.name)).toEqual([
      "Dun Dun Duuun",
      "Undertaker Bell",
    ]);
    expect(filterSoundEffects("zzz", "All")).toEqual([]);
    expect(myinstantsSearchUrl("vine boom")).toBe(
      "https://www.myinstants.com/en/search/?name=vine%20boom",
    );
  });
});

describe("sound effects tab — Library wiring", () => {
  const page = read("app/(main)/studio/library/page.tsx");

  it("the Library has a Sound Effects tab rendering the panel", () => {
    expect(page).toContain('{ id: "sounds", label: "Sound Effects" }');
    expect(page).toContain("SoundEffectsPanel");
    expect(page).toContain('tab === "sounds"');
  });

  it("playback uses the official embed; the page never references MyInstants media files", () => {
    expect(page).toContain("s.embedUrl");
    expect(page).toContain("<iframe");
    expect(page).not.toContain("myinstants.com/media/");
    expect(page).toContain("never copied or");
  });
});
