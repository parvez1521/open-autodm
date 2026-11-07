/**
 * Area — Creator Studio Meme Library membership (Programme S3).
 *
 * The Meme Library is a view over Projects tagged "meme". Pins:
 * case-insensitive membership (stored tags are normalised to lower
 * case at save time, but the check itself must be safe), filtering,
 * and tag toggling that preserves the other tags.
 */

import { describe, it, expect } from 'vitest';
import { MEME_TAG, filterMemeProjects, isMemeProject, toggleMemeTag } from '@/lib/studio/memes';
import type { StudioProject } from '@/lib/studio/types';

function project(id: string, tags?: string[]): StudioProject {
  return {
    id,
    kind: 'ideas',
    title: `Project ${id}`,
    createdAt: 1_700_000_000_000,
    summary: 'summary',
    payload: {},
    ...(tags ? { tags } : {}),
  };
}

describe('isMemeProject', () => {
  it('recognises the meme tag case-insensitively', () => {
    expect(MEME_TAG).toBe('meme');
    expect(isMemeProject(project('a', ['meme']))).toBe(true);
    expect(isMemeProject(project('b', ['Meme']))).toBe(true);
    expect(isMemeProject(project('c', ['MEME']))).toBe(true);
    expect(isMemeProject(project('d', ['funny', 'meme']))).toBe(true);
  });

  it('rejects untagged and differently tagged projects', () => {
    expect(isMemeProject(project('a'))).toBe(false);
    expect(isMemeProject(project('b', []))).toBe(false);
    expect(isMemeProject(project('c', ['funny']))).toBe(false);
    expect(isMemeProject(project('d', ['memes']))).toBe(false);
  });
});

describe('filterMemeProjects', () => {
  it('keeps only the meme-tagged projects, in order', () => {
    const all = [
      project('1', ['meme']),
      project('2', ['work']),
      project('3', ['Meme', 'funny']),
      project('4'),
    ];
    expect(filterMemeProjects(all).map((p) => p.id)).toEqual(['1', '3']);
    expect(filterMemeProjects([])).toEqual([]);
  });
});

describe('toggleMemeTag', () => {
  it('adds the tag while preserving the other tags', () => {
    const next = toggleMemeTag(['funny', ' Reaction '], true);
    expect(next).toContain('meme');
    expect(next).toContain('funny');
    expect(next).toContain('reaction'); // normalisation lower-cases + trims
  });

  it('does not duplicate the tag when it is already present', () => {
    expect(toggleMemeTag(['meme', 'funny'], true)).toEqual(['meme', 'funny']);
    expect(toggleMemeTag(['Meme'], true)).toEqual(['meme']);
  });

  it('removes the tag (any case) while preserving the other tags', () => {
    expect(toggleMemeTag(['meme', 'funny'], false)).toEqual(['funny']);
    expect(toggleMemeTag(['Meme', 'funny'], false)).toEqual(['funny']);
    expect(toggleMemeTag(['funny'], false)).toEqual(['funny']);
    expect(toggleMemeTag(['meme'], false)).toEqual([]);
  });
});
