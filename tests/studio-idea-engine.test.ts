/**
 * Area — Creator Studio Next Video Ideas engine (Programme S1).
 *
 * Pins: every mode returns its own bank's items, counts are respected,
 * results are duplicate-free and deterministic, topic substitution
 * happens, and every item is labelled as built-in engine output.
 */

import { describe, it, expect } from 'vitest';
import { generateIdeas, IDEA_MODE_LABELS } from '@/lib/studio/ideaEngine';
import type { IdeaMode } from '@/lib/studio/types';

const MODES = Object.keys(IDEA_MODE_LABELS) as IdeaMode[];

describe('generateIdeas', () => {
  it('covers every mode with that mode’s own items', () => {
    for (const mode of MODES) {
      const ideas = generateIdeas({ topic: 'home workouts', category: 'Fitness', mode, count: 6 });
      expect(ideas).toHaveLength(6);
      for (const idea of ideas) {
        expect(idea.mode).toBe(mode);
        expect(idea.engine).toBe('built-in');
        expect(idea.title.length).toBeGreaterThan(10);
        expect(idea.whyItWorks.length).toBeGreaterThan(10);
      }
    }
  });

  it('produces distinct lists per mode for the same topic', () => {
    const titles = new Set<string>();
    for (const mode of MODES) {
      for (const idea of generateIdeas({ topic: 'personal finance', category: 'Finance & Business', mode, count: 6 })) {
        titles.add(idea.title);
      }
    }
    expect(titles.size).toBe(18);
  });

  it('never duplicates a title inside one result', () => {
    for (const mode of MODES) {
      const ideas = generateIdeas({ topic: 'ai tools', category: 'Tech & AI Tools', mode, count: 12 });
      expect(new Set(ideas.map((i) => i.title)).size).toBe(ideas.length);
    }
  });

  it('respects the requested count and clamps out-of-range counts', () => {
    expect(generateIdeas({ topic: 'yoga', category: 'Fitness', mode: 'proven', count: 3 })).toHaveLength(3);
    expect(generateIdeas({ topic: 'yoga', category: 'Fitness', mode: 'proven', count: 99 }).length).toBeLessThanOrEqual(12);
    expect(generateIdeas({ topic: 'yoga', category: 'Fitness', mode: 'proven', count: 0 }).length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic for identical input', () => {
    const a = generateIdeas({ topic: 'budget travel', category: 'Travel', mode: 'angles', count: 8 });
    const b = generateIdeas({ topic: 'budget travel', category: 'Travel', mode: 'angles', count: 8 });
    expect(a).toEqual(b);
  });

  it('substitutes the topic into titles (no leftover placeholders)', () => {
    const ideas = generateIdeas({ topic: 'sourdough baking', category: 'Food', mode: 'questions', count: 8 });
    for (const idea of ideas) {
      expect(idea.title).not.toContain('{topic}');
      expect(idea.title).not.toContain('{category}');
      expect(idea.title.toLowerCase()).toContain('sourdough');
    }
  });

  it('falls back to the category name when the topic is blank', () => {
    const ideas = generateIdeas({ topic: '   ', category: 'Gaming', mode: 'proven', count: 4 });
    expect(ideas.length).toBe(4);
    expect(ideas[0]!.title).toContain('Gaming');
  });
});
