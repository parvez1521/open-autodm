/**
 * Area — Creator Studio Projects-lite store (Programme S1).
 *
 * Round-trip over an in-memory Storage fake: save/list/get/delete,
 * newest-first ordering, the cap, and corrupt-storage tolerance (the
 * tools must never break because local data is damaged).
 */

import { describe, it, expect } from 'vitest';
import {
  createProjectStore,
  STUDIO_PROJECTS_CAP,
  STUDIO_PROJECTS_KEY,
  type StorageLike,
} from '@/lib/studio/projects';

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('createProjectStore', () => {
  it('round-trips save → list → get → delete', () => {
    const store = createProjectStore(fakeStorage(), () => 1000);
    expect(store.list()).toEqual([]);

    const saved = store.save({
      kind: 'niche',
      title: 'Niche: AI tools',
      summary: 'Score 72/100',
      payload: { overall: 72 },
    });
    expect(saved.id).toMatch(/^sp-/);
    expect(saved.createdAt).toBe(1000);

    expect(store.list()).toHaveLength(1);
    expect(store.get(saved.id)?.title).toBe('Niche: AI tools');
    expect(store.get('missing')).toBeNull();

    expect(store.remove(saved.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove(saved.id)).toBe(false);
  });

  it('lists newest first and keeps ids unique', () => {
    let t = 0;
    const store = createProjectStore(fakeStorage(), () => ++t);
    const a = store.save({ kind: 'ideas', title: 'A', summary: '', payload: {} });
    const b = store.save({ kind: 'seo', title: 'B', summary: '', payload: {} });
    const c = store.save({ kind: 'niche', title: 'C', summary: '', payload: {} });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(store.list().map((p) => p.title)).toEqual(['C', 'B', 'A']);
  });

  it('caps the stored list at STUDIO_PROJECTS_CAP, dropping the oldest', () => {
    let t = 0;
    const storage = fakeStorage();
    const store = createProjectStore(storage, () => ++t);
    for (let i = 0; i < STUDIO_PROJECTS_CAP + 5; i++) {
      store.save({ kind: 'ideas', title: `Item ${i}`, summary: '', payload: {} });
    }
    const list = store.list();
    expect(list).toHaveLength(STUDIO_PROJECTS_CAP);
    expect(list[0]!.title).toBe(`Item ${STUDIO_PROJECTS_CAP + 4}`);
    expect(list.some((p) => p.title === 'Item 0')).toBe(false);
    expect(storage.map.has(STUDIO_PROJECTS_KEY)).toBe(true);
  });

  it('tolerates corrupt or wrong-shaped stored data', () => {
    const storage = fakeStorage();
    storage.setItem(STUDIO_PROJECTS_KEY, '{not json');
    const store = createProjectStore(storage);
    expect(store.list()).toEqual([]);

    storage.setItem(STUDIO_PROJECTS_KEY, JSON.stringify([{ nope: true }, 42, null]));
    expect(store.list()).toEqual([]);

    // …and saving still works afterwards.
    store.save({ kind: 'seo', title: 'Recovered', summary: '', payload: {} });
    expect(store.list().map((p) => p.title)).toEqual(['Recovered']);
  });

  it('clear() empties the store', () => {
    const store = createProjectStore(fakeStorage());
    store.save({ kind: 'niche', title: 'X', summary: '', payload: {} });
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
