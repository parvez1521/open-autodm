/**
 * Area — Creator Studio SEO Workspace engine (Programme S1).
 *
 * Pins: title character counts are exact and measured against the
 * 100-char ceiling, the tag string respects the ~500-char budget, tags
 * are deduplicated, extra keywords are included, and the description
 * carries the hook + hashtags.
 */

import { describe, it, expect } from 'vitest';
import { assembleTags, buildSeoPack, titleNote, topicTags } from '@/lib/studio/seoEngine';

describe('buildSeoPack', () => {
  const pack = buildSeoPack({ topic: 'best free AI video tools', category: 'Tech & AI Tools' });

  it('produces title options whose charCount equals the real length', () => {
    expect(pack.titles.length).toBeGreaterThanOrEqual(6);
    for (const t of pack.titles) {
      expect(t.charCount).toBe(t.title.length);
      expect(t.note.length).toBeGreaterThan(0);
    }
  });

  it('flags an over-long title against the 100-char ceiling', () => {
    expect(titleNote(120)).toContain('100-character');
    expect(titleNote(50)).toContain('Comfortable');
    const long = buildSeoPack({
      topic: 'the absolutely complete and exhaustive guide to every single free ai video editing tool available online today',
      category: 'Tech & AI Tools',
    });
    expect(long.titles.some((t) => t.charCount > 100 && t.note.includes('100-character'))).toBe(true);
  });

  it('keeps the comma-separated tag string within the 500-char budget', () => {
    expect(pack.tagsCharCount).toBeLessThanOrEqual(500);
    expect(pack.tags.join(', ').length).toBe(pack.tagsCharCount);
    expect(pack.tags.length).toBeGreaterThanOrEqual(8);
  });

  it('puts the exact topic phrase first and deduplicates tags', () => {
    expect(pack.tags[0]).toBe('best free ai video tools');
    expect(new Set(pack.tags).size).toBe(pack.tags.length);
  });

  it('includes creator-supplied extra keywords', () => {
    const p = buildSeoPack({
      topic: 'ai tools',
      category: 'Tech & AI Tools',
      keywords: 'no watermark, beginner friendly',
    });
    expect(p.tags).toContain('no watermark');
    expect(p.tags).toContain('beginner friendly');
  });

  it('description opens with the topic and ends with hashtags', () => {
    expect(pack.description.toLowerCase()).toContain('best free ai video tools');
    expect(pack.description).toContain('Timestamps:');
    const lastLine = pack.description.trim().split('\n').pop()!;
    expect(lastLine.startsWith('#')).toBe(true);
    expect(pack.hashtags.length).toBeGreaterThanOrEqual(1);
    for (const h of pack.hashtags) expect(h).not.toContain(' ');
  });
});

describe('assembleTags / topicTags', () => {
  it('stops adding tags at the budget instead of overflowing', () => {
    const candidates = Array.from({ length: 60 }, (_, i) => `tag number ${i} with some length`);
    const { tags, totalChars } = assembleTags(candidates, 200);
    expect(totalChars).toBeLessThanOrEqual(200);
    expect(tags.join(', ').length).toBe(totalChars);
  });

  it('topicTags yields the full phrase before n-grams', () => {
    const tags = topicTags('home workout plan');
    expect(tags[0]).toBe('home workout plan');
    expect(tags).toContain('home workout');
    expect(tags).toContain('workout plan');
  });
});
