/**
 * Area — Creator Studio Transcript Tools engine (Programme S2).
 *
 * Pins: SRT/VTT parsing (indices optional, comma and dot fractions
 * scaled as decimal fractions, multi-line cues joined, malformed and
 * empty cues counted as skipped, VTT header/NOTE blocks structural and
 * never skipped, inline tags stripped and entities decoded), plain-text
 * paragraph fallback, clean-text bracket removal, timing statistics,
 * and the SRT re-export round trip. There is deliberately no URL mode
 * to test — imports are paste/upload only.
 */

import { describe, it, expect } from 'vitest';
import {
  cleanTranscriptText,
  formatTimestamp,
  parseTranscript,
  serializeSrt,
  timestampedText,
  transcriptStats,
} from '@/lib/studio/transcriptEngine';
import type { TranscriptDoc } from '@/lib/studio/types';

const SRT_BASIC = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'Hello world',
  '',
  '2',
  '00:00:05,500 --> 00:00:08,250',
  'Second cue here',
].join('\n');

describe('parseTranscript — SRT', () => {
  it('parses a basic SRT file with indices and comma milliseconds', () => {
    const doc = parseTranscript(SRT_BASIC);
    expect(doc.format).toBe('srt');
    expect(doc.skipped).toBe(0);
    expect(doc.segments).toEqual([
      { startSec: 1, endSec: 4, text: 'Hello world' },
      { startSec: 5.5, endSec: 8.25, text: 'Second cue here' },
    ]);
  });

  it('joins a multi-line cue with a single space', () => {
    const doc = parseTranscript(
      ['1', '00:00:01,000 --> 00:00:04,000', 'First line', 'second line'].join('\n')
    );
    expect(doc.segments).toEqual([
      { startSec: 1, endSec: 4, text: 'First line second line' },
    ]);
  });

  it('parses identically when cue indices are missing', () => {
    const withoutIndices = [
      '00:00:01,000 --> 00:00:04,000',
      'Hello world',
      '',
      '00:00:05,500 --> 00:00:08,250',
      'Second cue here',
    ].join('\n');
    const withIndices = parseTranscript(SRT_BASIC);
    const without = parseTranscript(withoutIndices);
    expect(without.format).toBe('srt');
    expect(without.segments).toEqual(withIndices.segments);
    expect(without.skipped).toBe(0);
  });

  it('scales fractional seconds as a decimal fraction (.5, .05, .123)', () => {
    const doc = parseTranscript(
      [
        '1',
        '00:00:01,5 --> 00:00:02,05',
        'Fractional cue',
        '',
        '2',
        '00:00:03,123 --> 00:00:04,000',
        'Millis cue',
      ].join('\n')
    );
    expect(doc.segments[0]).toEqual({ startSec: 1.5, endSec: 2.05, text: 'Fractional cue' });
    expect(doc.segments[1]!.startSec).toBeCloseTo(3.123, 10);
  });

  it('counts a malformed-timestamp block as skipped and keeps the good cues', () => {
    const doc = parseTranscript(
      [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        'Good one',
        '',
        '2',
        '00:00:AA,000 --> 00:00:06,000',
        'This timing is broken',
        '',
        '3',
        '00:00:07,000 --> 00:00:08,000',
        'Good two',
      ].join('\n')
    );
    expect(doc.skipped).toBe(1);
    expect(doc.segments.map((s) => s.text)).toEqual(['Good one', 'Good two']);
  });

  it('counts a timing line with no text as skipped', () => {
    const doc = parseTranscript(
      [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        'Hello',
        '',
        '2',
        '00:00:03,000 --> 00:00:04,000',
        '',
        '3',
        '00:00:05,000 --> 00:00:06,000',
        'World',
      ].join('\n')
    );
    expect(doc.skipped).toBe(1);
    expect(doc.segments.map((s) => s.text)).toEqual(['Hello', 'World']);
  });

  it('normalises CRLF line endings', () => {
    const doc = parseTranscript(SRT_BASIC.replace(/\n/g, '\r\n'));
    expect(doc.format).toBe('srt');
    expect(doc.segments).toEqual(parseTranscript(SRT_BASIC).segments);
  });
});

describe('parseTranscript — VTT', () => {
  const VTT_BASIC = [
    'WEBVTT - Demo title',
    'Kind: captions',
    '',
    'NOTE',
    'This is a production note',
    'spanning two lines',
    '',
    'cue-identifier-1',
    '00:01.500 --> 00:04.000',
    '<v Roger>Hello there</v>',
    '',
    '00:05.000 --> 00:07.250',
    'Second VTT cue',
  ].join('\n');

  it('parses VTT: header and NOTE are structural, identifiers dropped, tags stripped, short timestamps work', () => {
    const doc = parseTranscript(VTT_BASIC);
    expect(doc.format).toBe('vtt');
    // Header and NOTE blocks must NOT be counted as skipped.
    expect(doc.skipped).toBe(0);
    expect(doc.segments).toEqual([
      { startSec: 1.5, endSec: 4, text: 'Hello there' },
      { startSec: 5, endSec: 7.25, text: 'Second VTT cue' },
    ]);
  });

  it('decodes HTML entities in VTT cue text', () => {
    const doc = parseTranscript(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:03.000',
        'Fish &amp; Chips &lt;tag&gt; &quot;quoted&quot; &#39;single&#39; a&nbsp;b',
      ].join('\n')
    );
    expect(doc.segments).toEqual([
      { startSec: 1, endSec: 3, text: `Fish & Chips <tag> "quoted" 'single' a b` },
    ]);
  });
});

describe('parseTranscript — plain text and empty input', () => {
  it('splits plain text on blank lines into untimed paragraph segments', () => {
    const doc = parseTranscript(
      'First paragraph line one\nstill first paragraph\n\nSecond paragraph here'
    );
    expect(doc.format).toBe('text');
    expect(doc.skipped).toBe(0);
    expect(doc.segments).toEqual([
      { startSec: null, endSec: null, text: 'First paragraph line one still first paragraph' },
      { startSec: null, endSec: null, text: 'Second paragraph here' },
    ]);
  });

  it('returns an empty text doc for empty or whitespace input', () => {
    expect(parseTranscript('')).toEqual({ format: 'text', segments: [], skipped: 0 });
    expect(parseTranscript('  \n\n  ')).toEqual({ format: 'text', segments: [], skipped: 0 });
  });
});

describe('cleanTranscriptText', () => {
  const doc: TranscriptDoc = {
    format: 'text',
    skipped: 0,
    segments: [
      { startSec: null, endSec: null, text: '[Music] Hello   world' },
      { startSec: null, endSec: null, text: 'Next [Applause] line' },
    ],
  };

  it('removes bracketed markers and collapses spaces when asked', () => {
    expect(cleanTranscriptText(doc, { removeBracketed: true })).toBe('Hello world Next line');
  });

  it('keeps the markers by default and when removeBracketed is false', () => {
    expect(cleanTranscriptText(doc, { removeBracketed: false })).toBe(
      '[Music] Hello world Next [Applause] line'
    );
    expect(cleanTranscriptText(doc)).toBe('[Music] Hello world Next [Applause] line');
  });
});

describe('transcriptStats', () => {
  it('computes words, duration and words-per-minute exactly on a known fixture', () => {
    const doc: TranscriptDoc = {
      format: 'srt',
      skipped: 0,
      segments: [
        { startSec: 0, endSec: 20, text: 'alpha beta gamma delta epsilon' },
        { startSec: 20, endSec: 60, text: 'zeta eta theta iota kappa' },
      ],
    };
    expect(transcriptStats(doc)).toEqual({
      words: 10,
      segmentCount: 2,
      durationSec: 60,
      wordsPerMinute: 10,
    });
  });

  it('returns null duration and wpm for an untimed doc', () => {
    const doc: TranscriptDoc = {
      format: 'text',
      skipped: 0,
      segments: [
        { startSec: null, endSec: null, text: 'four word sentence here' },
        { startSec: null, endSec: null, text: 'two more' },
      ],
    };
    const stats = transcriptStats(doc);
    expect(stats.words).toBe(6);
    expect(stats.segmentCount).toBe(2);
    expect(stats.durationSec).toBeNull();
    expect(stats.wordsPerMinute).toBeNull();
  });
});

describe('serializeSrt', () => {
  it('round-trips: parse(serializeSrt(doc)) reproduces the same segments', () => {
    const doc = parseTranscript(SRT_BASIC);
    const out = serializeSrt(doc);
    expect(out).toBe(
      '1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,500 --> 00:00:08,250\nSecond cue here\n'
    );
    const reparsed = parseTranscript(out);
    expect(reparsed.segments).toEqual(doc.segments);
    expect(reparsed.skipped).toBe(0);
  });

  it('renumbers from 1 even when the source skipped a block', () => {
    const doc = parseTranscript(
      [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        'First',
        '',
        'A block with no timing at all',
        '',
        '3',
        '00:00:03,000 --> 00:00:04,000',
        'Second',
      ].join('\n')
    );
    expect(doc.skipped).toBe(1);
    expect(doc.segments).toHaveLength(2);
    const out = serializeSrt(doc);
    expect(out.startsWith('1\n')).toBe(true);
    expect(out).toContain('\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond');
    expect(out).not.toContain('3\n00:');
  });

  it('uses start + 2 seconds when endSec is null', () => {
    const doc: TranscriptDoc = {
      format: 'srt',
      skipped: 0,
      segments: [{ startSec: 10, endSec: null, text: 'Open ended' }],
    };
    expect(serializeSrt(doc)).toBe('1\n00:00:10,000 --> 00:00:12,000\nOpen ended\n');
  });

  it('returns an empty string for an untimed doc', () => {
    const doc = parseTranscript('Just a paragraph with no timings at all.');
    expect(serializeSrt(doc)).toBe('');
  });
});

describe('timestampedText and formatTimestamp', () => {
  it('prefixes timed segments with a bracketed timestamp and leaves untimed lines bare', () => {
    const doc: TranscriptDoc = {
      format: 'srt',
      skipped: 0,
      segments: [
        { startSec: 65, endSec: 70, text: 'Hello' },
        { startSec: null, endSec: null, text: 'Plain line' },
        { startSec: 3661, endSec: 3670, text: 'Later' },
      ],
    };
    expect(timestampedText(doc)).toBe('[01:05] Hello\nPlain line\n[1:01:01] Later');
  });

  it('formats timestamp boundaries', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(65)).toBe('01:05');
    expect(formatTimestamp(3661)).toBe('1:01:01');
    expect(formatTimestamp(3599)).toBe('59:59');
    expect(formatTimestamp(3600)).toBe('1:00:00');
    expect(formatTimestamp(65.9)).toBe('01:05');
  });
});
