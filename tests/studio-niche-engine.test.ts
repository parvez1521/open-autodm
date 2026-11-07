/**
 * Area — Creator Studio Niche Finder engine (Programme S1).
 *
 * Pins the heuristic's contract: deterministic (same input → same
 * report), all scores inside sane bands, verdict thresholds, keyword
 * anchoring vs category fallback, and signal transparency.
 */

import { describe, it, expect } from 'vitest';
import { analyseNiche, stableHash, verdictFor } from '@/lib/studio/nicheEngine';

describe('stableHash', () => {
  it('is deterministic and input-sensitive', () => {
    expect(stableHash('fitness')).toBe(stableHash('fitness'));
    expect(stableHash('fitness')).not.toBe(stableHash('finance'));
  });
});

describe('analyseNiche', () => {
  it('is deterministic: identical input returns a deep-equal report', () => {
    const a = analyseNiche({ topic: 'AI tools for teachers', category: 'Tech & AI Tools' });
    const b = analyseNiche({ topic: 'AI tools for teachers', category: 'Tech & AI Tools' });
    expect(a).toEqual(b);
  });

  it('keeps every score inside 5..98 and the overall inside 5..97', () => {
    for (const topic of ['comedy skits', 'personal finance', 'bgmi gameplay', 'obscure hobby xyz', 'yoga']) {
      const r = analyseNiche({ topic, category: 'Other' });
      for (const v of [r.subScores.demand, r.subScores.competition, r.subScores.easeOfStarting, r.subScores.earningPotential]) {
        expect(v).toBeGreaterThanOrEqual(5);
        expect(v).toBeLessThanOrEqual(98);
      }
      expect(r.overall).toBeGreaterThanOrEqual(5);
      expect(r.overall).toBeLessThanOrEqual(97);
      expect(r.heuristic).toBe(true);
    }
  });

  it('anchors a keyword-matched topic to its dataset entry', () => {
    const r = analyseNiche({ topic: 'mutual funds and investing basics', category: 'Finance & Business' });
    expect(r.matchedNiche).toBe('Personal finance & investing');
    expect(r.signals[0]).toContain('Anchored to');
    expect(r.cpmBandInr).toContain('₹');
  });

  it('falls back to the category profile for an unmatched topic, and says so', () => {
    const r = analyseNiche({ topic: 'underwater basket weaving diaries', category: 'DIY & Home' });
    expect(r.signals[0]).toContain('No close built-in match');
    expect(r.category).toBe('DIY & Home');
  });

  it('applies transparent signals (faceless raises ease; AI angle is listed)', () => {
    const plain = analyseNiche({ topic: 'story channel', category: 'Comedy & Entertainment' });
    const faceless = analyseNiche({ topic: 'faceless story channel', category: 'Comedy & Entertainment' });
    expect(faceless.subScores.easeOfStarting).toBeGreaterThan(plain.subScores.easeOfStarting);
    expect(faceless.signals.join(' ')).toContain('Faceless format');

    const ai = analyseNiche({ topic: 'AI tools roundup', category: 'Tech & AI Tools' });
    expect(ai.signals.join(' ')).toContain('AI angle');
  });

  it('gives finance a higher earning index than comedy at the dataset level', () => {
    const fin = analyseNiche({ topic: 'investing for beginners', category: 'Finance & Business' });
    const com = analyseNiche({ topic: 'comedy skits', category: 'Comedy & Entertainment' });
    expect(fin.subScores.earningPotential).toBeGreaterThan(com.subScores.earningPotential);
  });

  it('maps overall scores to the published verdict bands', () => {
    expect(verdictFor(85)).toContain('Strong opportunity');
    expect(verdictFor(60)).toContain('Worth testing');
    expect(verdictFor(45)).toContain('Tough but workable');
    expect(verdictFor(20)).toContain('High risk');
    const r = analyseNiche({ topic: 'investing', category: 'Finance & Business' });
    expect(r.verdict).toBe(verdictFor(r.overall));
  });

  it('treats an unknown category string as Other', () => {
    const r = analyseNiche({ topic: 'anything', category: 'Not A Category' });
    expect(r.category).toBe('Other');
  });
});
