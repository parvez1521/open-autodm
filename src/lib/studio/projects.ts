/**
 * Creator Studio — Projects-lite (Programme S1).
 *
 * Saved Studio outputs (niche reports, idea lists, SEO packs) kept in the
 * browser's localStorage on THIS device. There is no backend and no sync
 * at this tier, and the UI says so. The store logic takes an injected
 * Storage-like object so it is fully unit-testable in node; the browser
 * singleton binds window.localStorage.
 *
 * Write contract (Programme 32, the Iteration-8 correction): a failed
 * persist — localStorage quota exceeded, storage unavailable or blocked
 * (privacy mode) — is NEVER silent. Every mutator (save, setTags,
 * remove, clear) throws `StudioProjectsPersistError` when the
 * underlying storage write fails, so callers can surface the failure
 * honestly instead of presenting unsaved work as saved. Reads keep the
 * original tolerance: corrupt or unreadable stored data reads as an
 * empty list and never breaks the tools.
 *
 * Read-failure contract (Programme 34, the Iteration-10 correction):
 * a mutator's pre-write READ is held to the same standard. If reading
 * storage itself throws (storage unavailable/blocked), the mutator
 * throws `StudioProjectsPersistError` too — an unreadable store is
 * NOT a confirmed-empty store, so a mutator must neither report a
 * quiet "not found" nor overwrite a list it could not read. Only
 * transport failure is typed this way: corrupt CONTENT (unparsable
 * or wrongly-shaped stored data) keeps the S1 tolerance and reads as
 * an empty list on every path, mutations included.
 */

import type { StudioProject, StudioProjectKind } from "./types";

export const STUDIO_PROJECTS_KEY = "open-autodm:studio-projects:v1";
export const STUDIO_PROJECTS_CAP = 100;

/**
 * User-facing copy for a failed Projects persist (Programme 32).
 * Programme 35 wording correction (ChatGPT Iteration-11 (c)2/(d)4):
 * the failure can be a WRITE (quota/unavailable) or, since Programme
 * 34, the pre-write READ — so the copy no longer speaks of saving
 * only: it says the saved projects could not be updated and the
 * change is not saved, that the caller's work stays on its page, and
 * names the retry path. ONE shared message is kept deliberately:
 * every caller surfaces this single constant, and threading a
 * read/write distinction through all ten call sites was judged
 * disproportionate to the nuance.
 */
export const STUDIO_PROJECTS_SAVE_FAILED_MESSAGE =
  "Couldn't update your saved projects on this device — browser storage is full or blocked, so the change isn't saved. Your work is still on this page; free up space or allow storage for this site, then try again.";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Thrown by a ProjectStore mutator when device storage cannot be
 * safely updated: the write fails (quota exceeded, storage
 * unavailable/blocked) or — since Programme 34 — the pre-write read
 * fails, in which case the mutator aborts before any write. The
 * original storage exception is preserved on `cause`. (Programme 35:
 * the message prose is neutral across read/write failure modes; the
 * error's type, `operation` and `cause` semantics are unchanged.)
 */
export class StudioProjectsPersistError extends Error {
  readonly operation: "save" | "setTags" | "remove" | "clear";
  constructor(operation: "save" | "setTags" | "remove" | "clear", cause: unknown) {
    super(`Studio Projects could not be safely updated on device storage (${operation}).`);
    this.name = "StudioProjectsPersistError";
    this.operation = operation;
    this.cause = cause;
  }
}

export interface ProjectStore {
  list(): StudioProject[];
  get(id: string): StudioProject | null;
  /**
   * Throws StudioProjectsPersistError when the write fails or the
   * pre-write read fails (Programme 34 — a failed read aborts the
   * save instead of overwriting an unread list).
   */
  save(input: {
    kind: StudioProjectKind;
    title: string;
    summary: string;
    payload: unknown;
    tags?: string[];
  }): StudioProject;
  /**
   * Replace a project's tag list (S3 tagging). Returns false if absent
   * (confirmed by a successful read). Throws
   * StudioProjectsPersistError when the write fails or the pre-write
   * read fails (Programme 34).
   */
  setTags(id: string, tags: string[]): boolean;
  /**
   * Returns false if absent (confirmed by a successful read). Throws
   * StudioProjectsPersistError when the write fails or the pre-write
   * read fails (Programme 34).
   */
  remove(id: string): boolean;
  /** Throws StudioProjectsPersistError when the removal fails. */
  clear(): void;
}

/** Normalise a tag list: trimmed, lower-cased, de-duplicated, capped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

let fallbackCounter = 0;

function newId(): string {
  fallbackCounter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return `sp-${rand}`;
}

function isProject(value: unknown): value is StudioProject {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const tagsOk =
    p["tags"] === undefined ||
    (Array.isArray(p["tags"]) && p["tags"].every((t) => typeof t === "string"));
  return (
    typeof p["id"] === "string" &&
    typeof p["title"] === "string" &&
    typeof p["createdAt"] === "number" &&
    tagsOk &&
    (p["kind"] === "niche" ||
      p["kind"] === "ideas" ||
      p["kind"] === "seo" ||
      p["kind"] === "script" ||
      p["kind"] === "transcript" ||
      p["kind"] === "voiceover" ||
      p["kind"] === "thumbnail" ||
      p["kind"] === "deck" ||
      p["kind"] === "stock")
  );
}

export function createProjectStore(storage: StorageLike, now: () => number = Date.now): ProjectStore {
  /**
   * Content-tolerant parse (S1): unparsable or wrongly-shaped stored
   * data reads as an empty list. This is a CONTENT judgement only —
   * it never sees a transport failure, because callers hand it the
   * raw string (or null) after the read itself has succeeded.
   */
  function parseStored(raw: string | null): StudioProject[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isProject).sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return []; // Corrupt storage must never break the tools.
    }
  }

  /** Read-only read: any failure (transport or content) reads empty. */
  function readAll(): StudioProject[] {
    try {
      return parseStored(storage.getItem(STUDIO_PROJECTS_KEY));
    } catch {
      return []; // Unreadable storage must never break read-only callers.
    }
  }

  /**
   * The read a MUTATION performs before writing (Programme 34). A
   * transport failure (getItem throws — storage unavailable or
   * blocked) is NOT a confirmed-empty store: it throws the typed
   * persist error carrying the mutator's operation, so the caller
   * surfaces the failure instead of the mutator reporting a quiet
   * not-found (setTags/remove) or overwriting an unread list
   * (save). Corrupt content keeps the parseStored tolerance.
   */
  function readAllForMutation(
    operation: StudioProjectsPersistError["operation"]
  ): StudioProject[] {
    let raw: string | null;
    try {
      raw = storage.getItem(STUDIO_PROJECTS_KEY);
    } catch (err) {
      throw new StudioProjectsPersistError(operation, err);
    }
    return parseStored(raw);
  }

  function writeAll(
    items: StudioProject[],
    operation: StudioProjectsPersistError["operation"]
  ): void {
    try {
      storage.setItem(STUDIO_PROJECTS_KEY, JSON.stringify(items.slice(0, STUDIO_PROJECTS_CAP)));
    } catch (err) {
      // Quota or privacy-mode failure (Programme 32): the caller must
      // learn the save did not happen — never report success.
      throw new StudioProjectsPersistError(operation, err);
    }
  }

  return {
    list: readAll,
    get(id) {
      return readAll().find((p) => p.id === id) ?? null;
    },
    save(input) {
      const project: StudioProject = {
        id: newId(),
        kind: input.kind,
        title: input.title.slice(0, 160),
        summary: input.summary.slice(0, 240),
        payload: input.payload,
        createdAt: now(),
      };
      if (input.tags && input.tags.length > 0) {
        project.tags = normalizeTags(input.tags);
      }
      writeAll([project, ...readAllForMutation("save")], "save");
      return project;
    },
    setTags(id, tags) {
      const items = readAllForMutation("setTags");
      const index = items.findIndex((p) => p.id === id);
      if (index < 0) return false;
      const next = items.slice();
      const updated: StudioProject = { ...next[index]! };
      const normalised = normalizeTags(tags);
      if (normalised.length > 0) updated.tags = normalised;
      else delete updated.tags;
      next[index] = updated;
      writeAll(next, "setTags");
      return true;
    },
    remove(id) {
      const items = readAllForMutation("remove");
      const next = items.filter((p) => p.id !== id);
      if (next.length === items.length) return false;
      writeAll(next, "remove");
      return true;
    },
    clear() {
      try {
        storage.removeItem(STUDIO_PROJECTS_KEY);
      } catch (err) {
        throw new StudioProjectsPersistError("clear", err);
      }
    },
  };
}

/** Browser singleton (client components only). */
let browserStore: ProjectStore | null = null;
export function getBrowserProjectStore(): ProjectStore {
  if (!browserStore) {
    const ls: StorageLike = {
      getItem: (k) => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
      removeItem: (k) => window.localStorage.removeItem(k),
    };
    browserStore = createProjectStore(ls);
  }
  return browserStore;
}
