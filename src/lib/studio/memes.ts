/**
 * Creator Studio — Meme Library membership (Programme S3).
 *
 * The Studio does not scrape meme libraries. The Meme Library is a
 * view over the user's own Projects: anything saved in Projects and
 * tagged "meme" collects there. Membership is a single tag, managed
 * here so the Projects page shortcuts and the Library tab agree.
 */

import { normalizeTags } from "./projects";
import type { StudioProject } from "./types";

export const MEME_TAG = "meme";

/** Case-insensitive: tags are normalised to lower case when saved, but
 *  membership checks stay safe against mixed-case stored data. */
export function isMemeProject(p: StudioProject): boolean {
  if (!p.tags) return false;
  return p.tags.some((t) => t.trim().toLowerCase() === MEME_TAG);
}

export function filterMemeProjects(projects: StudioProject[]): StudioProject[] {
  return projects.filter(isMemeProject);
}

/**
 * Add or remove the meme tag, preserving the other tags. The result
 * goes through normalizeTags (trimmed, lower-cased, de-duplicated,
 * capped) — the same normalisation the Projects store applies.
 */
export function toggleMemeTag(tags: readonly string[], on: boolean): string[] {
  if (on) {
    return normalizeTags([...tags, MEME_TAG]);
  }
  return normalizeTags(tags.filter((t) => t.trim().toLowerCase() !== MEME_TAG));
}
