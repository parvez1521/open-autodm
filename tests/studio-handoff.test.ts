/**
 * Area — Creator Studio tool hand-offs + S2 project kinds (Programme S2).
 *
 * Hand-offs (idea → script, transcript → script, script → voiceover)
 * ride in an injected storage: delivered exactly once (read-and-clear),
 * isolated per target, and tolerant of corrupt data. Also pins that
 * the Projects store accepts the three S2 kinds end-to-end.
 */

import { describe, it, expect } from 'vitest';
import { createHandoffStore } from '@/lib/studio/handoff';
import { createProjectStore, type StorageLike } from '@/lib/studio/projects';

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('createHandoffStore', () => {
  it('delivers a script hand-off exactly once', () => {
    const store = createHandoffStore(fakeStorage());
    expect(store.takeScript()).toBeNull();
    store.setScript({ topic: 'AI tools', sourceText: 'Some source.', from: 'Transcript Tools' });
    expect(store.takeScript()).toEqual({
      topic: 'AI tools',
      sourceText: 'Some source.',
      from: 'Transcript Tools',
    });
    expect(store.takeScript()).toBeNull();
  });

  it('keeps the script and voiceover slots independent', () => {
    const store = createHandoffStore(fakeStorage());
    store.setScript({ topic: 'T' });
    store.setVoiceover({ text: 'Speak me.', from: 'Script Builder' });
    expect(store.takeVoiceover()).toEqual({ text: 'Speak me.', from: 'Script Builder' });
    expect(store.takeScript()).toEqual({ topic: 'T' });
  });

  it('survives corrupt stored data', () => {
    const storage = fakeStorage();
    storage.map.set('open-autodm:studio-handoff:script', '{not json');
    const store = createHandoffStore(storage);
    expect(store.takeScript()).toBeNull();
  });
});

describe('Projects store — S2 kinds', () => {
  it('round-trips script, transcript and voiceover projects', () => {
    const store = createProjectStore(fakeStorage(), () => 42);
    store.save({ kind: 'script', title: 'Script: X', summary: 's', payload: { sections: [] } });
    store.save({ kind: 'transcript', title: 'Transcript: f.srt', summary: 't', payload: { segments: [] } });
    store.save({ kind: 'voiceover', title: 'Voiceover: Heart', summary: 'v', payload: { text: 'hi' } });
    const kinds = store.list().map((p) => p.kind);
    expect(kinds).toEqual(['voiceover', 'transcript', 'script']); // newest first
    const id = store.list()[0]!.id;
    expect(store.get(id)?.kind).toBe('voiceover');
    expect(store.remove(id)).toBe(true);
    expect(store.list()).toHaveLength(2);
  });
});
