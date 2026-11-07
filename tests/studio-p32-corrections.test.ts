/**
 * Area — Creator Studio Programme 32 corrections (Iteration 8).
 *
 * §1 Projects-lite write failures are observable: every store mutator
 * throws the typed StudioProjectsPersistError when the storage write
 * fails (quota exceeded / storage unavailable), reads stay tolerant,
 * and every Studio page that writes to the store surfaces the shared
 * failure message with an alert (source pins, labelled as such).
 * §2 Transcript timestamps enforce the conventional ranges (minutes
 * and seconds < 60, hours unbounded) and end <= start is invalid —
 * both through the parser's existing skipped-row accounting.
 * §3 Thumbnail document import enforces a maximum layer count and a
 * serialized-size guard; violations return the parser's null outcome.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createProjectStore,
  StudioProjectsPersistError,
  STUDIO_PROJECTS_SAVE_FAILED_MESSAGE,
  type StorageLike,
} from '@/lib/studio/projects';
import { parseTranscript } from '@/lib/studio/transcriptEngine';
import {
  addLayer,
  createTextLayer,
  createThumbnailDoc,
  thumbnailDocFromJson,
  thumbnailDocToJson,
  THUMB_MAX_DOC_JSON_CHARS,
  THUMB_MAX_LAYERS,
  THUMB_TEMPLATES,
} from '@/lib/studio/thumbnail';

// ── §1 storage fakes ───────────────────────────────────────────────

function quotaStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  };
}

function unavailableStorage(): StorageLike {
  const fail = (): never => {
    throw new Error('SecurityError: storage access denied');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
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

/** A store seeded with one saved project, over storage whose writes throw. */
function seededWriteFailingStore() {
  const seed = memoryStorage();
  const seedStore = createProjectStore(seed, () => 1000);
  const saved = seedStore.save({
    kind: 'niche',
    title: 'Seeded',
    summary: 'seed',
    payload: { overall: 50 },
    tags: ['original'],
  });
  const serialized = [...seed.map.values()][0]!;
  const failing: StorageLike = {
    getItem: () => serialized,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('SecurityError: storage access denied');
    },
  };
  return { store: createProjectStore(failing, () => 2000), savedId: saved.id };
}

const SAVE_INPUT = {
  kind: 'seo' as const,
  title: 'SEO pack: test',
  summary: 'summary',
  payload: { topic: 'test' },
};

describe('Programme 32 §1 — Projects persist failures are observable', () => {
  it('save() throws the typed error when storage is over quota', () => {
    const store = createProjectStore(quotaStorage(), () => 1000);
    let caught: unknown;
    try {
      store.save(SAVE_INPUT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioProjectsPersistError);
    const e = caught as StudioProjectsPersistError;
    expect(e.name).toBe('StudioProjectsPersistError');
    expect(e.operation).toBe('save');
    expect((e.cause as Error).message).toBe('QuotaExceededError');
    // Nothing was persisted, and the failure is distinguishable from success.
    expect(store.list()).toEqual([]);
  });

  it('save() throws the typed error when storage is unavailable (privacy mode)', () => {
    const store = createProjectStore(unavailableStorage(), () => 1000);
    expect(() => store.save(SAVE_INPUT)).toThrow(StudioProjectsPersistError);
    // Reads keep the S1 tolerance: unreadable storage reads as empty.
    expect(store.list()).toEqual([]);
  });

  it('setTags() throws the typed error and leaves stored tags untouched', () => {
    const { store, savedId } = seededWriteFailingStore();
    let caught: unknown;
    try {
      store.setTags(savedId, ['meme']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioProjectsPersistError);
    expect((caught as StudioProjectsPersistError).operation).toBe('setTags');
    expect(store.get(savedId)?.tags).toEqual(['original']);
  });

  it('remove() throws the typed error and the project remains stored', () => {
    const { store, savedId } = seededWriteFailingStore();
    let caught: unknown;
    try {
      store.remove(savedId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioProjectsPersistError);
    expect((caught as StudioProjectsPersistError).operation).toBe('remove');
    expect(store.list().map((p) => p.id)).toEqual([savedId]);
  });

  it('clear() throws the typed error when removeItem fails', () => {
    const { store } = seededWriteFailingStore();
    let caught: unknown;
    try {
      store.clear();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioProjectsPersistError);
    expect((caught as StudioProjectsPersistError).operation).toBe('clear');
  });

  it('no-op mutators (absent id) return false without touching storage', () => {
    const { store } = seededWriteFailingStore();
    expect(store.remove('sp-absent')).toBe(false);
    expect(store.setTags('sp-absent', ['x'])).toBe(false);
  });

  it('a failed save can be retried successfully once storage recovers', () => {
    const backing = memoryStorage();
    let failWrites = true;
    const flaky: StorageLike = {
      getItem: backing.getItem,
      setItem: (k, v) => {
        if (failWrites) throw new Error('QuotaExceededError');
        backing.setItem(k, v);
      },
      removeItem: backing.removeItem,
    };
    const store = createProjectStore(flaky, () => 1000);
    expect(() => store.save(SAVE_INPUT)).toThrow(StudioProjectsPersistError);
    failWrites = false;
    const saved = store.save(SAVE_INPUT);
    expect(store.list().map((p) => p.id)).toEqual([saved.id]);
  });

  it('the failure message copy is exported for the UI', () => {
    expect(STUDIO_PROJECTS_SAVE_FAILED_MESSAGE).toContain('browser storage is full or blocked');
  });
});

describe('Programme 32 §1 — Studio pages surface save failures (source pins)', () => {
  const pages = [
    'src/app/(main)/studio/niche/page.tsx',
    'src/app/(main)/studio/seo/page.tsx',
    'src/app/(main)/studio/script/page.tsx',
    'src/app/(main)/studio/voiceover/page.tsx',
    'src/app/(main)/studio/transcript/page.tsx',
    'src/app/(main)/studio/thumbnail/page.tsx',
    'src/app/(main)/studio/presentations/page.tsx',
    'src/app/(main)/studio/ideas/page.tsx',
    'src/app/(main)/studio/library/page.tsx',
    'src/app/(main)/studio/projects/page.tsx',
  ];
  for (const page of pages) {
    it(`${page} shows the shared failure message in an alert on persist failure`, () => {
      const src = readFileSync(path.resolve(process.cwd(), page), 'utf8');
      expect(src).toContain('STUDIO_PROJECTS_SAVE_FAILED_MESSAGE');
      expect(src).toContain('role="alert"');
    });
  }

  it('the store no longer swallows write failures as non-fatal', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/lib/studio/projects.ts'),
      'utf8'
    );
    expect(src).not.toContain('non-fatal');
    expect(src).toContain('throw new StudioProjectsPersistError');
  });
});

// ── §2 transcript timestamp ranges ─────────────────────────────────

function srt(...blocks: string[]): string {
  return blocks.join('\n\n');
}

function cue(index: number, timing: string, text: string): string {
  return `${index}\n${timing}\n${text}`;
}

describe('Programme 32 §2 — transcript timestamp validation', () => {
  it('rejects a cue whose end seconds component is out of range (00:00:99)', () => {
    const doc = parseTranscript(
      srt(cue(1, '00:00:01,000 --> 00:00:04,000', 'Good'), cue(2, '00:00:10,000 --> 00:00:99,000', 'Bad'))
    );
    expect(doc.segments).toHaveLength(1);
    expect(doc.skipped).toBe(1);
  });

  it('rejects a cue whose minutes component is out of range (00:99:00)', () => {
    const doc = parseTranscript(srt(cue(1, '00:99:00,000 --> 01:00:00,000', 'Bad')));
    expect(doc.segments).toEqual([]);
    expect(doc.skipped).toBe(1);
  });

  it('rejects an out-of-range start timestamp even when the end is valid', () => {
    const doc = parseTranscript(srt(cue(1, '00:00:99,000 --> 00:01:30,000', 'Bad')));
    expect(doc.segments).toEqual([]);
    expect(doc.skipped).toBe(1);
  });

  it('rejects out-of-range VTT timestamps (99:99.999 and MM:SS 00:99.500)', () => {
    const doc = parseTranscript(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:99:99.999',
        'Bad hours form',
        '',
        '00:99.500 --> 01:00.000',
        'Bad minutes form',
      ].join('\n')
    );
    expect(doc.segments).toEqual([]);
    expect(doc.skipped).toBe(2);
  });

  it('rejects a cue whose end is before its start', () => {
    const doc = parseTranscript(srt(cue(1, '00:00:05,000 --> 00:00:03,000', 'Backwards')));
    expect(doc.segments).toEqual([]);
    expect(doc.skipped).toBe(1);
  });

  it('rejects a zero-length cue (end equals start)', () => {
    const doc = parseTranscript(srt(cue(1, '00:00:05,000 --> 00:00:05,000', 'Instant')));
    expect(doc.segments).toEqual([]);
    expect(doc.skipped).toBe(1);
  });

  it('accepts the boundary-valid 00:59:59.999 end', () => {
    const doc = parseTranscript(srt(cue(1, '00:00:00,000 --> 00:59:59,999', 'Long cue')));
    expect(doc.skipped).toBe(0);
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0]!.endSec).toBeCloseTo(3599.999, 3);
  });

  it('accepts large hour values (hours are unbounded)', () => {
    const doc = parseTranscript(srt(cue(1, '99:00:00,000 --> 99:00:01,500', 'Far future')));
    expect(doc.skipped).toBe(0);
    expect(doc.segments).toEqual([{ startSec: 356400, endSec: 356401.5, text: 'Far future' }]);
  });

  it('mixed documents count every invalid cue through the same skipped accounting', () => {
    const doc = parseTranscript(
      srt(
        cue(1, '00:00:01,000 --> 00:00:04,000', 'Good one'),
        cue(2, '00:00:99,000 --> 00:01:00,000', 'Bad range'),
        cue(3, '00:00:10,000 --> 00:00:09,000', 'Bad order'),
        cue(4, '00:00:20,000 --> 00:00:24,000', 'Good two')
      )
    );
    expect(doc.segments.map((s) => s.text)).toEqual(['Good one', 'Good two']);
    expect(doc.skipped).toBe(2);
  });
});

// ── §3 thumbnail document limits ───────────────────────────────────

function docWithLayers(count: number) {
  let doc = createThumbnailDoc();
  for (let i = 0; i < count; i += 1) {
    doc = addLayer(doc, createTextLayer({ text: `Layer ${i}` }));
  }
  return doc;
}

describe('Programme 32 §3 — thumbnail document limits', () => {
  it('accepts a document at exactly the layer limit', () => {
    const doc = docWithLayers(THUMB_MAX_LAYERS);
    const restored = thumbnailDocFromJson(thumbnailDocToJson(doc));
    expect(restored).not.toBeNull();
    expect(restored!.layers).toHaveLength(THUMB_MAX_LAYERS);
  });

  it('rejects a document one layer over the limit with the null outcome', () => {
    const doc = docWithLayers(THUMB_MAX_LAYERS + 1);
    expect(thumbnailDocFromJson(thumbnailDocToJson(doc))).toBeNull();
    expect(thumbnailDocFromJson(JSON.parse(thumbnailDocToJson(doc)))).toBeNull();
  });

  it('rejects a serialized document over the size guard even when otherwise valid', () => {
    const doc = docWithLayers(2);
    const json = thumbnailDocToJson(doc);
    const padded = json + ' '.repeat(THUMB_MAX_DOC_JSON_CHARS);
    expect(padded.length).toBeGreaterThan(THUMB_MAX_DOC_JSON_CHARS);
    expect(thumbnailDocFromJson(padded)).toBeNull();
    // Control: the same document unpadded parses.
    expect(thumbnailDocFromJson(json)).not.toBeNull();
  });

  it('rejects an oversized already-parsed object input', () => {
    const doc = addLayer(
      createThumbnailDoc(),
      createTextLayer({ text: 'x'.repeat(THUMB_MAX_DOC_JSON_CHARS) })
    );
    expect(thumbnailDocFromJson(JSON.parse(thumbnailDocToJson(doc)))).toBeNull();
  });

  it('leaves every shipped template importable', () => {
    for (const template of THUMB_TEMPLATES) {
      const doc = template.build();
      expect(doc.layers.length).toBeLessThanOrEqual(THUMB_MAX_LAYERS);
      expect(thumbnailDocFromJson(thumbnailDocToJson(doc))).toEqual(doc);
    }
  });
});
