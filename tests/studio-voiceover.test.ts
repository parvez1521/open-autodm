/**
 * Area — Creator Studio Voiceover Studio logic (Programme S2).
 *
 * The pure pieces: the voice catalogue (pinned to kokoro-js@1.2.1's
 * REAL built-in voice map — 28 English voices; the Hindi model voices
 * are present but explicitly NOT exportable through this library),
 * TTS chunking at sentence boundaries, the 16-bit PCM WAV encoder,
 * and the export-engine state machine. The browser synthesis itself
 * is exercised separately in the Playwright rehearsal.
 */

import { describe, it, expect } from 'vitest';
import {
  KOKORO_VOICES,
  HINDI_MODEL_VOICES,
  VOICE_LANGUAGES,
  voicesForLanguage,
  getVoice,
  isExportableVoice,
  TTS_CHUNK_MAX_CHARS,
  splitSentences,
  chunkTextForTts,
  estimateSpeechSeconds,
  encodeWavPcm16,
  initialVoiceoverState,
  voiceoverReducer,
  type VoiceoverEngineState,
} from '@/lib/studio/voiceover';

describe('voice catalogue', () => {
  it('contains exactly the 28 voices kokoro-js@1.2.1 ships', () => {
    expect(KOKORO_VOICES).toHaveLength(28);
    expect(new Set(KOKORO_VOICES.map((v) => v.id)).size).toBe(28);
    // The ids are the library's own: af_/am_ (en-US) and bf_/bm_ (en-GB).
    for (const v of KOKORO_VOICES) {
      expect(v.id).toMatch(/^[ab][fm]_[a-z]+$/);
      expect(v.language === 'en-US' || v.language === 'en-GB').toBe(true);
      expect(v.tier).toBe('quality');
    }
    expect(getVoice('af_heart')?.name).toBe('Heart');
    expect(getVoice('bm_fable')?.language).toBe('en-GB');
  });

  it('splits by language for the picker', () => {
    expect(voicesForLanguage('en-US')).toHaveLength(20);
    expect(voicesForLanguage('en-GB')).toHaveLength(8);
    expect(voicesForLanguage('hi')).toHaveLength(0);
  });

  it('keeps the Hindi model voices listed but NOT exportable', () => {
    expect(HINDI_MODEL_VOICES.map((v) => v.id)).toEqual(['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi']);
    for (const v of HINDI_MODEL_VOICES) {
      expect(v.tier).toBe('beta');
      expect(isExportableVoice(v.id)).toBe(false);
      expect(getVoice(v.id)).toBeUndefined();
    }
    expect(isExportableVoice('af_heart')).toBe(true);
    expect(VOICE_LANGUAGES.map((l) => l.id)).toEqual(['en-US', 'en-GB', 'hi']);
  });
});

describe('splitSentences + chunkTextForTts', () => {
  it('splits on terminal punctuation and keeps it', () => {
    expect(splitSentences('One. Two? Three! Four')).toEqual(['One.', 'Two?', 'Three!', 'Four']);
  });

  it('returns no chunks for blank text', () => {
    expect(chunkTextForTts('')).toEqual([]);
    expect(chunkTextForTts('   \n ')).toEqual([]);
  });

  it('packs sentences under the cap and round-trips the text', () => {
    const sentence = 'This is a complete sentence for chunking.'; // 42 chars
    const text = Array.from({ length: 30 }, () => sentence).join(' ');
    const chunks = chunkTextForTts(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join(' ')).toBe(text);
  });

  it('hard-splits a single sentence longer than the cap at word boundaries', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '.';
    const chunks = chunkTextForTts(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join(' ')).toBe(long);
  });

  it('defaults to the research chunk cap', () => {
    expect(TTS_CHUNK_MAX_CHARS).toBe(800);
    const text = Array.from({ length: 100 }, () => 'A short spoken line here.').join(' ');
    for (const c of chunkTextForTts(text)) expect(c.length).toBeLessThanOrEqual(800);
  });
});

describe('estimateSpeechSeconds', () => {
  it('estimates at narration pace', () => {
    expect(estimateSpeechSeconds('')).toBe(0);
    expect(estimateSpeechSeconds(Array.from({ length: 150 }, () => 'word').join(' '))).toBe(60);
    expect(estimateSpeechSeconds('hello')).toBe(1);
  });
});

describe('encodeWavPcm16', () => {
  it('writes a valid 44-byte PCM header', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 0.25, -1]), 24000);
    expect(wav).toHaveLength(44 + 3 * 2);
    const ascii = (from: number, to: number) =>
      String.fromCharCode(...wav.slice(from, to));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 12)).toBe('WAVE');
    expect(ascii(12, 16)).toBe('fmt ');
    expect(ascii(36, 40)).toBe('data');
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(6); // data size
  });

  it('encodes samples as clamped little-endian int16', () => {
    const wav = encodeWavPcm16(new Float32Array([0.25, -1, 2]), 24000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getInt16(44, true)).toBe(8192); // round(0.25 × 32767)
    expect(view.getInt16(46, true)).toBe(-32767);
    expect(view.getInt16(48, true)).toBe(32767); // clamped from 2
  });
});

describe('voiceoverReducer', () => {
  const run = (events: Parameters<typeof voiceoverReducer>[1][]): VoiceoverEngineState =>
    events.reduce(voiceoverReducer, initialVoiceoverState);

  it('walks the happy path idle → loading → ready → generating → ready', () => {
    const s = run([
      { type: 'load-start' },
      { type: 'load-ok' },
      { type: 'generate-start', chunks: 3 },
      { type: 'generate-progress', done: 2 },
      { type: 'generate-ok' },
    ]);
    expect(s.phase).toBe('ready');
    expect(s.chunksDone).toBe(3);
    expect(s.chunksTotal).toBe(3);
    expect(s.errorCode).toBeNull();
  });

  it('records an init failure distinctly from a generation failure', () => {
    const init = run([{ type: 'load-start' }, { type: 'load-fail' }]);
    expect(init).toMatchObject({ phase: 'error', errorCode: 'init_failed' });
    const gen = run([
      { type: 'load-start' },
      { type: 'load-ok' },
      { type: 'generate-start', chunks: 2 },
      { type: 'generate-fail' },
    ]);
    expect(gen).toMatchObject({ phase: 'error', errorCode: 'generation_failed' });
    // A generation failure may be retried without reloading the model.
    const retry = voiceoverReducer(gen, { type: 'generate-start', chunks: 2 });
    expect(retry.phase).toBe('generating');
  });

  it('ignores events that do not apply to the current phase', () => {
    expect(voiceoverReducer(initialVoiceoverState, { type: 'load-ok' })).toBe(initialVoiceoverState);
    expect(voiceoverReducer(initialVoiceoverState, { type: 'generate-progress', done: 1 })).toBe(
      initialVoiceoverState
    );
    const generating = run([
      { type: 'load-start' },
      { type: 'load-ok' },
      { type: 'generate-start', chunks: 1 },
    ]);
    expect(voiceoverReducer(generating, { type: 'load-start' })).toBe(generating);
  });

  it('clamps progress to the chunk total and resets cleanly', () => {
    const s = run([
      { type: 'load-start' },
      { type: 'load-ok' },
      { type: 'generate-start', chunks: 2 },
      { type: 'generate-progress', done: 99 },
    ]);
    expect(s.chunksDone).toBe(2);
    expect(voiceoverReducer(s, { type: 'reset' })).toEqual(initialVoiceoverState);
  });
});
