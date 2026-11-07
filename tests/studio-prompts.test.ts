/**
 * Area — Creator Studio Prompt Library (Programme S1).
 *
 * Pins the bank's integrity (unique ids, every category present, all
 * prompts original product copy with fill-in placeholders) and the
 * search/filter behaviour.
 */

import { describe, it, expect } from 'vitest';
import { PROMPT_BANK, PROMPT_CATEGORIES, searchPrompts } from '@/lib/studio/prompts';

describe('PROMPT_BANK integrity', () => {
  it('has unique ids and covers every category', () => {
    expect(new Set(PROMPT_BANK.map((p) => p.id)).size).toBe(PROMPT_BANK.length);
    for (const cat of PROMPT_CATEGORIES) {
      expect(PROMPT_BANK.some((p) => p.category === cat)).toBe(true);
    }
    expect(PROMPT_BANK.length).toBeGreaterThanOrEqual(20);
  });

  it('every prompt carries at least one [fill-in] placeholder', () => {
    for (const p of PROMPT_BANK) {
      expect(p.prompt).toMatch(/\[[^\]]+\]/);
    }
  });

  it('hand-off targets only name live Studio tools', () => {
    // S1 pinned ideas/seo; S2 adds the Script Builder target now that
    // /studio/script exists.
    for (const p of PROMPT_BANK) {
      // S3 (2026-11-07): 'thumbnail' joined the hand-off targets when the
      // Thumbnail Editor shipped; the S1-era list is superseded.
      if (p.useIn) expect(['ideas', 'seo', 'script', 'thumbnail']).toContain(p.useIn);
    }
    expect(PROMPT_BANK.some((p) => p.useIn === 'seo')).toBe(true);
    expect(PROMPT_BANK.some((p) => p.useIn === 'ideas')).toBe(true);
    expect(PROMPT_BANK.some((p) => p.useIn === 'script')).toBe(true);
    expect(PROMPT_BANK.some((p) => p.useIn === 'thumbnail')).toBe(true);
    // Every Scripts-category prompt hands off to the Script Builder.
    for (const p of PROMPT_BANK.filter((x) => x.category === 'Scripts')) {
      expect(p.useIn).toBe('script');
    }
  });
});

describe('searchPrompts', () => {
  it('returns the whole bank for an empty query with no filter', () => {
    expect(searchPrompts('')).toHaveLength(PROMPT_BANK.length);
    expect(searchPrompts('   ', 'All')).toHaveLength(PROMPT_BANK.length);
  });

  it('filters by category', () => {
    const hooks = searchPrompts('', 'Hooks');
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every((p) => p.category === 'Hooks')).toBe(true);
  });

  it('matches on title, body and category text, case-insensitively', () => {
    expect(searchPrompts('THUMBNAIL').length).toBeGreaterThan(0);
    expect(searchPrompts('sponsorship').length).toBeGreaterThan(0);
    expect(searchPrompts('hook').length).toBeGreaterThan(0);
  });

  it('combines query and category filter', () => {
    const results = searchPrompts('title', 'SEO');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.category === 'SEO')).toBe(true);
  });

  it('returns an empty list for a nonsense query', () => {
    expect(searchPrompts('zzz-no-such-thing')).toEqual([]);
  });
});
