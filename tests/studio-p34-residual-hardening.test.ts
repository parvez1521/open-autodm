/**
 * Area — Creator Studio Programme 34 residual hardening (Iteration 10)
 * plus the UX-1/UX-2 workspace-UI items.
 *
 * §1 Projects-lite READ failures during a mutation are typed: a
 * storage read that throws (getItem unavailable/blocked) makes
 * setTags/remove/save throw StudioProjectsPersistError instead of
 * reading as a confirmed-empty store; a read that succeeds keeps the
 * quiet not-found behaviour, and corrupt CONTENT keeps the S1
 * tolerance on every path.
 * §2 Thumbnail object-input guard: the cheap structural checks
 * (version, dimensions, layer count) run BEFORE JSON.stringify for
 * already-parsed input, proven with a toJSON spy the parser must
 * never reach for an over-limit document; the editor boundary is
 * pinned at source level (labelled source pins — the page's guarded
 * apply pattern), matching the Iteration-10 finding-12 distinction
 * between the verified parser outcome and the page's apply guard.
 * §3 Quota terminology: the Openverse cap helper is per-instance;
 * the old "global" name is gone from the Studio sources (source
 * pins). Behaviour is unchanged and remains covered by
 * tests/studio-openverse.test.ts.
 * §4 UX-1/UX-2: workspace members/switcher presentation and
 * accessibility fixes, pinned at the codebase's established
 * source-pin tier for this UI (see tests/p18-workspace-ui.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createProjectStore,
  StudioProjectsPersistError,
  type StorageLike,
} from '@/lib/studio/projects';
import {
  addLayer,
  createTextLayer,
  createThumbnailDoc,
  thumbnailDocFromJson,
  thumbnailDocToJson,
  THUMB_MAX_DOC_JSON_CHARS,
  THUMB_MAX_LAYERS,
} from '@/lib/studio/thumbnail';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), rel), 'utf8');

// ── §1 storage fakes ───────────────────────────────────────────────

const READ_ERROR = new Error('SecurityError: storage access denied');

/** getItem throws (transport failure); writes are spied, never throw. */
function readFailingStorage() {
  const calls = { setItem: 0, removeItem: 0 };
  const storage: StorageLike = {
    getItem: () => {
      throw READ_ERROR;
    },
    setItem: () => {
      calls.setItem += 1;
    },
    removeItem: () => {
      calls.removeItem += 1;
    },
  };
  return { storage, calls };
}

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const SAVE_INPUT = {
  kind: 'seo' as const,
  title: 'SEO pack: test',
  summary: 'summary',
  payload: { topic: 'test' },
};

describe('Programme 34 §1 — mutation read failures are typed, not silent', () => {
  it('setTags() throws the typed error when the pre-write read fails, and writes nothing', () => {
    const { storage, calls } = readFailingStorage();
    const store = createProjectStore(storage, () => 1000);
    let caught: unknown;
    try {
      store.setTags('sp-whatever', ['meme']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioProjectsPersistError);
    const e = caught as StudioProjectsPersistError;
    expect(e.operation).toBe('setTags');
    expect(e.cause).toBe(READ_ERROR);
    expect(calls.setItem).toBe(0);
  });

  it('remove() throws the typed error when the pre-write read fails, and writes nothing', () => {
    const { storage, calls } = readFailingStorage();
    const store = createProjectStore(storage, () => 1000);
    let caught: unknown;
    try {
      store.remove('sp-whatever');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioProjectsPersistError);
    const e = caught as StudioProjectsPersistError;
    expect(e.operation).toBe('remove');
    expect(e.cause).toBe(READ_ERROR);
    expect(calls.setItem).toBe(0);
  });

  it('save() throws the typed error when its pre-write read fails, instead of overwriting an unread list', () => {
    const { storage, calls } = readFailingStorage();
    const store = createProjectStore(storage, () => 1000);
    let caught: unknown;
    try {
      store.save(SAVE_INPUT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioProjectsPersistError);
    const e = caught as StudioProjectsPersistError;
    expect(e.operation).toBe('save');
    expect(e.cause).toBe(READ_ERROR);
    // The single-item write that would have clobbered the unread
    // stored list never happened.
    expect(calls.setItem).toBe(0);
  });

  it('a store seeded while reads work is left untouched when reads later fail', () => {
    const backing = memoryStorage();
    const seedStore = createProjectStore(backing, () => 1000);
    const saved = seedStore.save({ ...SAVE_INPUT, tags: ['original'] });
    let failReads = false;
    const flipping: StorageLike = {
      getItem: (k) => {
        if (failReads) throw READ_ERROR;
        return backing.getItem(k);
      },
      setItem: backing.setItem,
      removeItem: backing.removeItem,
    };
    const store = createProjectStore(flipping, () => 2000);
    failReads = true;
    expect(() => store.setTags(saved.id, ['meme'])).toThrow(StudioProjectsPersistError);
    expect(() => store.remove(saved.id)).toThrow(StudioProjectsPersistError);
    failReads = false;
    // Nothing was written during the failed-read window.
    expect(store.get(saved.id)?.tags).toEqual(['original']);
    expect(store.list().map((p) => p.id)).toEqual([saved.id]);
  });

  it('quiet not-found is preserved when the read succeeds (absent id → false, no throw)', () => {
    const store = createProjectStore(memoryStorage(), () => 1000);
    expect(store.setTags('sp-absent', ['x'])).toBe(false);
    expect(store.remove('sp-absent')).toBe(false);
  });

  it('corrupt CONTENT keeps the S1 tolerance on the mutation path (only transport failure is typed)', () => {
    const corrupt: StorageLike = {
      getItem: () => '{not json',
      setItem: () => {},
      removeItem: () => {},
    };
    const store = createProjectStore(corrupt, () => 1000);
    // Unparsable content reads as an empty list: not-found stays
    // quiet, and a save proceeds over the corrupt blob.
    expect(store.setTags('sp-absent', ['x'])).toBe(false);
    expect(store.remove('sp-absent')).toBe(false);
    expect(() => store.save(SAVE_INPUT)).not.toThrow();
  });

  it('read-only callers keep the full tolerance when the read throws', () => {
    const { storage } = readFailingStorage();
    const store = createProjectStore(storage, () => 1000);
    expect(store.list()).toEqual([]);
    expect(store.get('sp-whatever')).toBeNull();
  });
});

// ── §2 thumbnail object-input guard ordering ───────────────────────

function docWithLayers(count: number) {
  let doc = createThumbnailDoc();
  for (let i = 0; i < count; i += 1) {
    doc = addLayer(doc, createTextLayer({ text: `Layer ${i}` }));
  }
  return doc;
}

describe('Programme 34 §2 — structural checks precede serialization for object input', () => {
  it('rejects an over-limit layer count WITHOUT serializing (toJSON spy never fires)', () => {
    let stringifyReached = false;
    const doc = docWithLayers(THUMB_MAX_LAYERS + 1) as unknown as Record<string, unknown>;
    const hostile = {
      ...doc,
      toJSON: () => {
        stringifyReached = true;
        return {};
      },
    };
    expect(thumbnailDocFromJson(hostile)).toBeNull();
    expect(stringifyReached).toBe(false);
  });

  it('rejects a wrong-version object WITHOUT serializing', () => {
    let stringifyReached = false;
    const doc = docWithLayers(2) as unknown as Record<string, unknown>;
    const hostile = {
      ...doc,
      version: 2,
      toJSON: () => {
        stringifyReached = true;
        return {};
      },
    };
    expect(thumbnailDocFromJson(hostile)).toBeNull();
    expect(stringifyReached).toBe(false);
  });

  it('still rejects an oversized already-parsed object (serialized-size guard preserved)', () => {
    const doc = addLayer(
      createThumbnailDoc(),
      createTextLayer({ text: 'x'.repeat(THUMB_MAX_DOC_JSON_CHARS) })
    );
    expect(thumbnailDocFromJson(JSON.parse(thumbnailDocToJson(doc)))).toBeNull();
  });

  it('still accepts an at-limit already-parsed object', () => {
    const doc = docWithLayers(THUMB_MAX_LAYERS);
    const restored = thumbnailDocFromJson(JSON.parse(thumbnailDocToJson(doc)));
    expect(restored).not.toBeNull();
    expect(restored!.layers).toHaveLength(THUMB_MAX_LAYERS);
  });

  it('the size limit is worded as characters (code units), never as a byte figure (source pin)', () => {
    const src = readSrc('src/lib/studio/thumbnail.ts');
    expect(src).toContain('8,000,000 characters');
    expect(src).not.toContain('≈8 MB');
    expect(src).not.toContain('8M chars');
  });

  it('editor boundary: the page applies a carried-over document only under its success guard (source pin)', () => {
    const page = readSrc('src/app/(main)/studio/thumbnail/page.tsx');
    // The editor's only document-entry path: a handoff document is
    // applied to history state solely when one was actually carried
    // over; a rejected/absent document leaves state untouched.
    expect(page).toContain('if (used) setHistory(createHistory(next));');
    // Owner decision (2026-11-07): the Thumbnail Editor is PAUSED on
    // the preview — hidden from navigation, directory and landing, its
    // route redirected by middleware, and the Projects hand-off button
    // removed. The Projects page must therefore not reference the
    // editor route at all while paused; the hand-off store itself
    // (lib/studio/handoff.ts) is untouched and returns with the
    // editor. When the editor is restored, this half reverts to
    // pinning the guarded hand-off ('if (doc) {' + setThumbnail).
    const projectsPage = readSrc('src/app/(main)/studio/projects/page.tsx');
    expect(projectsPage).not.toContain('/studio/thumbnail');
    expect(readSrc('src/lib/studio/handoff.ts')).toContain('setThumbnail');
  });
});

// ── §3 quota terminology (source pins) ─────────────────────────────

describe('Programme 34 §3 — Openverse cap terminology is per-instance (source pins)', () => {
  it('the helper is named and documented as a per-instance counter', () => {
    const src = readSrc('src/lib/studio/openverseQuota.ts');
    expect(src).toContain('export function createPerInstanceDailyCap');
    expect(src).toContain('PER-INSTANCE');
    expect(src).toContain('not a\n * deployment-wide cap');
    expect(src).not.toContain('createDailyGlobalCap');
    expect(src).not.toContain('app-global');
  });

  it('the route and client use the per-instance name; "app-global" is gone from the Studio sources', () => {
    const route = readSrc('src/app/api/studio/openverse/route.ts');
    expect(route).toContain('createPerInstanceDailyCap');
    expect(route).toContain('perInstanceCap');
    expect(route).not.toContain('globalCap');
    expect(route).not.toContain('app-global');
    const client = readSrc('src/lib/studio/openverse.ts');
    expect(client).toContain('per-instance');
    expect(client).not.toContain('app-global');
  });
});

// ── §4 UX-1 / UX-2 (source pins — the codebase tier for this UI) ───

describe('Programme 34 §4 UX-1 — members email presentation', () => {
  const members = readSrc('src/components/workspace/WorkspaceMembers.tsx');

  it('renders an explicit "Email not stored" affordance instead of the bare user ID', () => {
    expect(members).toContain('Email not stored');
    expect(members).toContain('data-testid="member-email-not-stored"');
    // Updated 2026-11-09 (customer fix O): the visible "Member ID
    // {userId}" fragment this pin used to REQUIRE is exactly what
    // the fix removed — raw member UUIDs no longer render in the
    // row at all (the joined date is formatted human-readably
    // instead of a raw ISO timestamp). The §4 posture is preserved:
    // email still comes only from the members route, never metadata.
    expect(members).not.toContain('Member ID');
    // The old presentation (raw user ID as the identity line) is gone.
    expect(members).not.toContain('{m.email ?? m.userId ?? "Unknown user"}');
  });

  it('posture preserved: email is never derived from user metadata anywhere in the members path', () => {
    expect(members).not.toContain('user_metadata');
    const route = readSrc('src/app/api/workspaces/[workspaceId]/members/route.ts');
    expect(route).not.toContain('user_metadata');
    expect(route).toContain("typeof r['email'] === 'string' ? r['email'] : null");
  });
});

describe('Programme 34 §4 UX-2 — workspace UI accessibility fixes', () => {
  const members = readSrc('src/components/workspace/WorkspaceMembers.tsx');
  const switcher = readSrc('src/components/workspace/WorkspaceSwitcher.tsx');

  it('members page announces notice, error and loading through live regions', () => {
    expect(members).toContain('role="status"');
    expect(members).toContain('role="alert"');
    expect(members).toContain('Loading members…');
    expect(members).toContain('sr-only');
  });

  it('placeholder-only inputs gained accessible names; Remove buttons are per-member labelled', () => {
    expect(members).toContain('aria-label="Invitee email address"');
    expect(members).toContain('aria-label="Invitation token"');
    expect(members).toContain('aria-label="New workspace name"');
    // Updated 2026-11-09 (round-2 customer fix): the Remove label's
    // identity fallback is no longer the raw member UUID — since
    // memberships store no email, `m.email ?? m.userId` put the
    // UUID into the accessible name in practice. Labels now resolve
    // through memberLabel (email, else the row position). The §4
    // posture is preserved: labels are still per-member.
    expect(members).toContain('aria-label={`Remove ${memberLabel}`}');
  });

  it('invite button contrast: the white-on-primary 2.80:1 pairing is replaced', () => {
    expect(members).toContain('bg-orange-700');
    expect(members).not.toContain('text-primary-foreground');
  });

  it('switcher popup has the listbox keyboard model (focus-in, arrows, Escape, focus return)', () => {
    expect(switcher).toContain('e.key === "Escape"');
    expect(switcher).toContain('e.key === "ArrowDown"');
    expect(switcher).toContain('e.key === "ArrowUp"');
    expect(switcher).toContain('e.key === "Home"');
    expect(switcher).toContain('e.key === "End"');
    expect(switcher).toContain('triggerRef.current?.focus()');
    expect(switcher).toContain('tabIndex={-1}');
  });

  it('switcher closes on an outside pointer press and names the collapsed trigger', () => {
    expect(switcher).toContain('document.addEventListener("pointerdown"');
    expect(switcher).toContain('Current workspace:');
    expect(switcher).toContain('aria-label="Workspaces"');
  });

  it('interactive controls in both components carry deliberate focus rings', () => {
    expect(switcher).toContain('focus-visible:ring-ring');
    expect(members).toContain('focus-visible:ring-ring');
  });
});
