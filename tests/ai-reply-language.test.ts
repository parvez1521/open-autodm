/**
 * Hinglish AI replies (2026-11-17) — src/lib/ai/workersAi.ts.
 *
 * Covers:
 *  (a) languageInstruction: empty for English/unset, a Roman-script
 *      Hinglish instruction (never Devanagari) for 'hinglish';
 *  (b) with language 'hinglish' and NO provider answering, every
 *      generator falls back to a Hinglish template pool (Roman script
 *      only — no Devanagari anywhere in the pools);
 *  (c) with language 'en' (or unset) the fallbacks stay English;
 *  (d) with a mocked provider, the Hinglish instruction reaches the
 *      system prompt — the provider, not the template, writes the text.
 *
 * The injectedAi seam mirrors tests/workers-ai.test.ts: when a binding
 * is injected, getAiBinding() is skipped, so no network is involved.
 */

import { describe, it, expect } from 'vitest';
import {
  languageInstruction,
  generateOpeningVariations,
  generatePublicReplies,
  generateResponseDraft,
  generateFollowUpDraft,
  DEFAULT_OPENING_VARIATIONS_HINGLISH,
  DEFAULT_PUBLIC_REPLIES_HINGLISH,
  DEFAULT_RESPONSE_DRAFTS_HINGLISH,
  DEFAULT_FOLLOW_UP_DRAFTS_HINGLISH,
  DEFAULT_OPENING_VARIATIONS,
  type WorkersAiBinding,
} from '@/lib/ai/workersAi';

const DEVANAGARI = /[\u0900-\u097F]/;

describe('languageInstruction', () => {
  it('is empty for English and unset', () => {
    expect(languageInstruction('en')).toBe('');
    expect(languageInstruction(undefined)).toBe('');
  });

  it('instructs Hinglish in Roman script for hinglish — never Devanagari', () => {
    const instruction = languageInstruction('hinglish');
    expect(instruction).toContain('Hinglish');
    expect(instruction).toContain('Roman');
    expect(instruction).not.toMatch(DEVANAGARI);
  });
});

describe('Hinglish template fallback pools', () => {
  it('every Hinglish pool entry is Roman script only', () => {
    for (const pool of [
      DEFAULT_OPENING_VARIATIONS_HINGLISH,
      DEFAULT_PUBLIC_REPLIES_HINGLISH,
      DEFAULT_RESPONSE_DRAFTS_HINGLISH,
      DEFAULT_FOLLOW_UP_DRAFTS_HINGLISH,
    ]) {
      expect(pool.length).toBeGreaterThanOrEqual(3);
      for (const line of pool) expect(line).not.toMatch(DEVANAGARI);
    }
  });
});

describe('generators with language hinglish and no provider', () => {
  // No injected binding and no Workers AI binding in the test runner →
  // runChatCompletion returns null → the template fallback serves.
  it('opening variations fall back to Hinglish lines', async () => {
    const result = await generateOpeningVariations('free guide', 3, { language: 'hinglish' });
    expect(result.status).toBe('fallback');
    expect(result.data).toHaveLength(3);
    for (const line of result.data) {
      expect(DEFAULT_OPENING_VARIATIONS_HINGLISH).toContain(line);
    }
  });

  it('public replies fall back to Hinglish lines', async () => {
    const result = await generatePublicReplies('warm vibe', 3, undefined, 'hinglish');
    expect(result.status).toBe('fallback');
    expect(result.data).toHaveLength(3);
    for (const line of result.data) {
      expect(DEFAULT_PUBLIC_REPLIES_HINGLISH).toContain(line);
    }
  });

  it('response drafts fall back to a Hinglish line', async () => {
    const result = await generateResponseDraft('deliver the guide', { language: 'hinglish' });
    expect(result.status).toBe('fallback');
    expect(DEFAULT_RESPONSE_DRAFTS_HINGLISH).toContain(result.data);
  });

  it('follow-up drafts fall back to a Hinglish line', async () => {
    const result = await generateFollowUpDraft('check in', { language: 'hinglish' });
    expect(result.status).toBe('fallback');
    expect(DEFAULT_FOLLOW_UP_DRAFTS_HINGLISH).toContain(result.data);
  });
});

describe('generators with language en (or unset) and no provider', () => {
  it('opening variations fall back to English lines', async () => {
    const result = await generateOpeningVariations('free guide', 3, { language: 'en' });
    expect(result.status).toBe('fallback');
    for (const line of result.data) {
      expect(DEFAULT_OPENING_VARIATIONS).toContain(line);
    }
  });

  it('an unset language behaves as English', async () => {
    const result = await generateOpeningVariations('free guide', 3, {});
    expect(result.status).toBe('fallback');
    for (const line of result.data) {
      expect(DEFAULT_OPENING_VARIATIONS).toContain(line);
    }
  });
});

describe('generators with a mocked provider', () => {
  it('the Hinglish instruction reaches the provider system prompt', async () => {
    const seen: Array<{ role: string; content: string }> = [];
    const binding: WorkersAiBinding = {
      run: async (_model, options) => {
        seen.push(...options.messages);
        return { response: '1. Hey {username}! Link bhej diya hai ✨\n2. Arre {username}, guide ready hai! 🚀' };
      },
    };
    const result = await generateOpeningVariations('free guide', 2, { language: 'hinglish' }, binding);
    expect(result.status).toBe('success');
    const system = seen.find((m) => m.role === 'system')!;
    expect(system.content).toContain('Hinglish');
    expect(system.content).toContain('Roman');
  });

  it('the English path sends no Hinglish instruction', async () => {
    const seen: Array<{ role: string; content: string }> = [];
    const binding: WorkersAiBinding = {
      run: async (_model, options) => {
        seen.push(...options.messages);
        return { response: '1. Hey {username}! Here is your guide ✨\n2. Thanks {username}, sending it now! 🚀' };
      },
    };
    await generateOpeningVariations('free guide', 2, { language: 'en' }, binding);
    const system = seen.find((m) => m.role === 'system')!;
    expect(system.content).not.toContain('Hinglish');
  });
});
