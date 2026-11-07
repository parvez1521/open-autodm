/**
 * Area — Creator Studio Script Builder engine (Programme S2).
 *
 * Pins: exact section structure per format, determinism, spoken-timing
 * ranges for the short formats, the fixed long-form slot total, tone
 * sensitivity, source-material extraction (relevance, original order,
 * cap, blank handling), source weaving into point sections, section
 * re-timing, draft refresh, and the plain / markdown / spoken exports.
 */

import { describe, it, expect } from 'vitest';
import {
  SPEAKING_WPM,
  SCRIPT_FORMAT_OPTIONS,
  SCRIPT_TONE_OPTIONS,
  buildScript,
  countWords,
  extractKeyPoints,
  formatDuration,
  refreshDraft,
  retimeSection,
  scriptToMarkdown,
  scriptToPlainText,
  scriptToSpokenText,
  spokenSeconds,
} from '@/lib/studio/scriptEngine';
import type { ScriptFormat } from '@/lib/studio/types';

describe('countWords / spokenSeconds / formatDuration', () => {
  it('counts whitespace-separated tokens and treats blank as zero', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n ')).toBe(0);
    expect(countWords('hello')).toBe(1);
    expect(countWords('hello world')).toBe(2);
    expect(countWords('a  b\nc\td')).toBe(4);
  });

  it('times speech at SPEAKING_WPM with a one-second floor', () => {
    expect(SPEAKING_WPM).toBe(150);
    expect(spokenSeconds('')).toBe(0);
    expect(spokenSeconds('   ')).toBe(0);
    expect(spokenSeconds('word')).toBe(1);
    expect(spokenSeconds(Array(75).fill('word').join(' '))).toBe(30);
    expect(spokenSeconds(Array(150).fill('word').join(' '))).toBe(60);
  });

  it('formats durations as m:ss with zero-padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(30)).toBe('0:30');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(465)).toBe('7:45');
  });

  it('exposes the format and tone option tables', () => {
    expect(SCRIPT_FORMAT_OPTIONS.map((o) => o.id)).toEqual(['reel30', 'short60', 'longform']);
    expect(SCRIPT_FORMAT_OPTIONS.map((o) => o.label)).toEqual([
      'Reel / Short · 30s',
      'Short · 60s',
      'Long-form outline',
    ]);
    for (const option of SCRIPT_FORMAT_OPTIONS) expect(option.blurb.length).toBeGreaterThan(10);
    expect(SCRIPT_TONE_OPTIONS.map((o) => o.id)).toEqual(['energetic', 'educational', 'calm', 'bold']);
    expect(SCRIPT_TONE_OPTIONS.map((o) => o.label)).toEqual(['Energetic', 'Educational', 'Calm', 'Bold']);
  });
});

describe('buildScript structure', () => {
  const KINDS: Record<ScriptFormat, string[]> = {
    reel30: ['hook', 'setup', 'point', 'point', 'payoff', 'cta'],
    short60: ['hook', 'setup', 'point', 'point', 'point', 'payoff', 'cta'],
    longform: ['hook', 'setup', 'point', 'point', 'point', 'point', 'payoff', 'cta'],
  };

  it('produces the exact kind sequence, ids and headings per format', () => {
    for (const format of Object.keys(KINDS) as ScriptFormat[]) {
      const draft = buildScript({ topic: 'home workouts', format, tone: 'energetic' });
      expect(draft.sections.map((s) => s.kind)).toEqual(KINDS[format]);
      const pointCount = KINDS[format].filter((k) => k === 'point').length;
      expect(draft.sections.map((s) => s.id)).toEqual([
        'hook',
        'setup',
        ...Array.from({ length: pointCount }, (_, i) => `point-${i + 1}`),
        'payoff',
        'cta',
      ]);
      expect(draft.sections.map((s) => s.heading)).toEqual([
        'Hook',
        'Setup',
        ...Array.from({ length: pointCount }, (_, i) => `Main point ${i + 1}`),
        'Payoff',
        'Call to action',
      ]);
      for (const section of draft.sections) {
        expect(section.engine).toBe('built-in');
        expect(section.text.length).toBeGreaterThan(10);
        expect(section.text).not.toContain('{topic}');
      }
      expect(draft.topic).toBe('home workouts');
      expect(draft.usedSourceMaterial).toBe(false);
      expect(draft.wordCount).toBe(
        draft.sections.reduce((sum, s) => sum + countWords(s.text), 0)
      );
      expect(draft.estDurationSec).toBe(draft.sections.reduce((sum, s) => sum + s.seconds, 0));
    }
  });

  it('is deterministic for identical input', () => {
    const a = buildScript({ topic: 'budget travel', format: 'short60', tone: 'calm' });
    const b = buildScript({ topic: 'budget travel', format: 'short60', tone: 'calm' });
    expect(a).toEqual(b);
  });

  it('gives short-format points a speakable line plus an on-screen note', () => {
    const draft = buildScript({ topic: 'home workouts', format: 'reel30', tone: 'bold' });
    for (const section of draft.sections.filter((s) => s.kind === 'point')) {
      expect(section.text).toContain('\nOn screen: ');
      expect(section.seconds).toBe(spokenSeconds(section.text));
    }
  });

  it('lands reel30 near its target length and duration', () => {
    const draft = buildScript({ topic: 'home workouts', format: 'reel30', tone: 'energetic' });
    expect(draft.wordCount).toBeGreaterThanOrEqual(50);
    expect(draft.wordCount).toBeLessThanOrEqual(110);
    expect(draft.estDurationSec).toBeGreaterThanOrEqual(20);
    expect(draft.estDurationSec).toBeLessThanOrEqual(45);
  });

  it('lands short60 near a minute of speech', () => {
    const draft = buildScript({ topic: 'home workouts', format: 'short60', tone: 'educational' });
    expect(draft.estDurationSec).toBeGreaterThanOrEqual(45);
    expect(draft.estDurationSec).toBeLessThanOrEqual(80);
  });

  it('gives long-form the exact planned slot total of 465 seconds', () => {
    const draft = buildScript({ topic: 'home workouts', format: 'longform', tone: 'calm' });
    expect(draft.sections.map((s) => s.seconds)).toEqual([30, 45, 75, 75, 75, 75, 60, 30]);
    expect(draft.estDurationSec).toBe(465);
    expect(draft.estDurationSec).toBe(draft.sections.reduce((sum, s) => sum + s.seconds, 0));
  });

  it('changes the hook when only the tone changes', () => {
    const energetic = buildScript({ topic: 'home workouts', format: 'reel30', tone: 'energetic' });
    const calm = buildScript({ topic: 'home workouts', format: 'reel30', tone: 'calm' });
    expect(energetic.sections[0]!.text).not.toBe(calm.sections[0]!.text);
  });

  it('falls back to "your topic" when the topic is blank', () => {
    const draft = buildScript({ topic: '   ', format: 'reel30', tone: 'energetic' });
    expect(draft.topic).toBe('your topic');
    expect(draft.sections[0]!.text).toContain('your topic');
  });
});

describe('extractKeyPoints', () => {
  it('returns nothing for blank input or a non-positive cap', () => {
    expect(extractKeyPoints('', 'home workouts', 3)).toEqual([]);
    expect(extractKeyPoints('   \n ', 'home workouts', 3)).toEqual([]);
    expect(extractKeyPoints('Home workouts are great fun for everyone involved daily.', 'home workouts', 0)).toEqual([]);
  });

  it('ignores fragments outside the 6–40 word window', () => {
    expect(extractKeyPoints('Too short here. Also tiny.', 'home workouts', 3)).toEqual([]);
  });

  it('selects the most topic-relevant sentences and returns them in original order', () => {
    const earlier =
      'Home workouts are flexible and need almost no equipment at all.';
    const filler =
      'Many people say staying consistent is the hardest part of any new routine.';
    const later =
      'Beginners love home workouts because beginners can progress gently at home daily.';
    const source = [earlier, filler, later].join(' ');
    // `later` scores higher (three topic tokens) but must stay second.
    expect(extractKeyPoints(source, 'home workouts beginners', 2)).toEqual([earlier, later]);
  });

  it('respects the cap', () => {
    const sentence = 'Home workouts build strength steadily when you repeat them every single week.';
    const source = Array(6).fill(sentence).join(' ');
    expect(extractKeyPoints(source, 'home workouts', 2)).toHaveLength(2);
    expect(extractKeyPoints(source, 'home workouts', 10)).toHaveLength(6);
  });

  it('normalises casing and terminal punctuation', () => {
    const points = extractKeyPoints(
      'home workouts build real strength when practised with patience every week',
      'home workouts',
      1
    );
    expect(points).toEqual(['Home workouts build real strength when practised with patience every week.']);
  });
});

describe('buildScript with source material', () => {
  const sourceSentence =
    'Home workouts need almost no equipment and fit around a busy family schedule easily.';
  const sourceText = [
    sourceSentence,
    'The weather today is rainy and the roads outside are completely empty this morning.',
    'Consistency matters more than intensity when you are building a lasting exercise habit slowly.',
    'Short home workouts still build real strength when you repeat them every single week.',
  ].join(' ');

  it('weaves source sentences into point sections, verbatim and labelled', () => {
    const draft = buildScript({
      topic: 'home workouts',
      format: 'reel30',
      tone: 'energetic',
      sourceText,
    });
    expect(draft.usedSourceMaterial).toBe(true);
    const points = draft.sections.filter((s) => s.kind === 'point');
    expect(points[0]!.text).toBe(sourceSentence);
    expect(points.some((s) => s.text.includes(sourceSentence))).toBe(true);
    for (const point of points) {
      expect(point.heading).toContain('from your material');
    }
    expect(draft.sections.find((s) => s.kind === 'hook')!.heading).toBe('Hook');
  });

  it('keeps planned long-form slots when source points replace outline text', () => {
    const draft = buildScript({
      topic: 'home workouts',
      format: 'longform',
      tone: 'calm',
      sourceText,
    });
    expect(draft.usedSourceMaterial).toBe(true);
    expect(draft.estDurationSec).toBe(465);
    const points = draft.sections.filter((s) => s.kind === 'point');
    expect(points[0]!.text).toBe(sourceSentence);
    expect(points[0]!.seconds).toBe(75);
    expect(points[0]!.heading).toContain('from your material');
  });

  it('reports no source use when the source yields no usable sentences', () => {
    const draft = buildScript({
      topic: 'home workouts',
      format: 'reel30',
      tone: 'energetic',
      sourceText: 'Too short. Really tiny.',
    });
    expect(draft.usedSourceMaterial).toBe(false);
  });
});

describe('retimeSection / refreshDraft', () => {
  it('re-times short-format sections from their edited text', () => {
    const draft = buildScript({ topic: 'home workouts', format: 'reel30', tone: 'energetic' });
    const hook = draft.sections[0]!;
    const longer = { ...hook, text: Array(40).fill('word').join(' ') };
    const retimed = retimeSection(longer, 'reel30');
    expect(retimed.seconds).toBe(spokenSeconds(longer.text));
    expect(retimed.seconds).toBeGreaterThan(hook.seconds);
    expect(retimed.text).toBe(longer.text);
  });

  it('keeps planned slots for long-form sections', () => {
    const draft = buildScript({ topic: 'home workouts', format: 'longform', tone: 'energetic' });
    const point = draft.sections.find((s) => s.kind === 'point')!;
    const edited = { ...point, text: 'A much shorter replacement line.' };
    const retimed = retimeSection(edited, 'longform');
    expect(retimed.seconds).toBe(75);
    expect(retimed.text).toBe(edited.text);
  });

  it('recomputes draft totals from the current sections', () => {
    const draft = buildScript({ topic: 'home workouts', format: 'short60', tone: 'bold' });
    const edited = {
      ...draft,
      sections: draft.sections.map((s, i) =>
        i === 0 ? { ...s, text: 'One two three four five six seven eight nine ten.', seconds: 99 } : s
      ),
      wordCount: 1,
      estDurationSec: 1,
    };
    const refreshed = refreshDraft(edited);
    expect(refreshed.wordCount).toBe(
      edited.sections.reduce((sum, s) => sum + countWords(s.text), 0)
    );
    expect(refreshed.estDurationSec).toBe(edited.sections.reduce((sum, s) => sum + s.seconds, 0));
    expect(refreshed.estDurationSec).not.toBe(1);
    expect(refreshed.wordCount).not.toBe(1);
  });
});

describe('exports', () => {
  const draft = buildScript({ topic: 'home workouts', format: 'reel30', tone: 'energetic' });

  it('plain text carries the topic, the meta line and every heading', () => {
    const text = scriptToPlainText(draft);
    expect(text.startsWith('Script: home workouts\n')).toBe(true);
    expect(text).toContain('Reel / Short · 30s · Energetic · ≈');
    expect(text).toContain(`${draft.wordCount} words`);
    for (const section of draft.sections) {
      expect(text).toContain(`[${section.heading} · ~${section.seconds}s]`);
      expect(text).toContain(section.text);
    }
    expect(text.endsWith('\n')).toBe(true);
  });

  it('markdown carries the topic and every section heading', () => {
    const md = scriptToMarkdown(draft);
    expect(md.startsWith('# Script: home workouts\n')).toBe(true);
    for (const section of draft.sections) {
      expect(md).toContain(`## ${section.heading} (~${section.seconds}s)`);
      expect(md).toContain(section.text);
    }
    expect(md.endsWith('\n')).toBe(true);
  });

  it('spoken text contains every section text and no headings', () => {
    const spoken = scriptToSpokenText(draft);
    for (const section of draft.sections) {
      expect(spoken).toContain(section.text);
      expect(spoken).not.toContain(section.heading);
    }
    expect(spoken).toBe(draft.sections.map((s) => s.text).join('\n\n'));
  });
});
