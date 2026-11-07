/**
 * Area — Creator Studio Groq free-tier provider lib (Programme S1).
 *
 * Pins the zero-cost contract: model rotation within the published
 * free models, quota dominance when every model is limited, defensive
 * parsing, response caching (identical inputs → one provider call),
 * and the per-user limiter's minute/day windows. Fetch is stubbed —
 * no network, no key.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GROQ_MODELS,
  GroqError,
  createGroqIdeasClient,
  createPerUserRateLimiter,
} from '@/lib/studio/groq';
import type { StudioCategory } from '@/lib/studio/types';

const INPUT = { topic: 'home workouts', category: 'Fitness' as StudioCategory, mode: 'proven' as const, count: 3 };

function groqOk(titles: string[]) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(
              titles.map((title) => ({ title, format: 'Test format', whyItWorks: 'Because it works.' }))
            ),
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function statusRes(status: number) {
  return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createGroqIdeasClient', () => {
  it('returns parsed ideas labelled free-ai on success', async () => {
    const fetchFn = vi.fn(async () => groqOk(['Idea one', 'Idea two', 'Idea three']));
    const client = createGroqIdeasClient({ apiKey: 'test-key', fetchFn });
    const result = await client.generateIdeas(INPUT);
    expect(result.ideas.map((i) => i.title)).toEqual(['Idea one', 'Idea two', 'Idea three']);
    expect(result.ideas.every((i) => i.engine === 'free-ai')).toBe(true);
    expect(GROQ_MODELS).toContain(result.model);
    expect(result.cached).toBe(false);
  });

  it('rotates to the next model when the first is at its free limit (429)', async () => {
    const seenModels: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      seenModels.push(body.model);
      return seenModels.length === 1 ? statusRes(429) : groqOk(['Rotated idea']);
    });
    const client = createGroqIdeasClient({ apiKey: 'test-key', fetchFn });
    const result = await client.generateIdeas(INPUT);
    expect(seenModels).toHaveLength(2);
    expect(seenModels[0]).not.toBe(seenModels[1]);
    expect(result.model).toBe(seenModels[1]);
    expect(result.ideas[0]!.title).toBe('Rotated idea');
  });

  it('throws a quota GroqError when every model is limited', async () => {
    const fetchFn = vi.fn(async () => statusRes(429));
    const client = createGroqIdeasClient({ apiKey: 'test-key', fetchFn });
    await expect(client.generateIdeas(INPUT)).rejects.toMatchObject({
      name: 'GroqError',
      code: 'quota',
    });
    expect(fetchFn).toHaveBeenCalledTimes(GROQ_MODELS.length);
  });

  it('throws unavailable when the provider errors with 5xx on all models', async () => {
    const fetchFn = vi.fn(async () => statusRes(503));
    const client = createGroqIdeasClient({ apiKey: 'test-key', fetchFn });
    await expect(client.generateIdeas(INPUT)).rejects.toBeInstanceOf(GroqError);
    await expect(client.generateIdeas(INPUT)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('throws bad_response for unparseable model output', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'no json here' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const client = createGroqIdeasClient({ apiKey: 'test-key', fetchFn });
    await expect(client.generateIdeas(INPUT)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('caches identical inputs — the provider is called once', async () => {
    const fetchFn = vi.fn(async () => groqOk(['Cached idea']));
    const client = createGroqIdeasClient({ apiKey: 'test-key', fetchFn });
    const first = await client.generateIdeas(INPUT);
    const second = await client.generateIdeas({ ...INPUT });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.ideas).toEqual(first.ideas);

    // A different topic is a different cache entry.
    await client.generateIdeas({ ...INPUT, topic: 'yoga for beginners' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('never sends the request anywhere but the Groq endpoint, with the key as Bearer', async () => {
    const fetchFn = vi.fn(async () => groqOk(['X']));
    const client = createGroqIdeasClient({ apiKey: 'test-key', fetchFn });
    await client.generateIdeas(INPUT);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });
});

describe('createPerUserRateLimiter', () => {
  it('allows up to the per-minute cap, then refuses as rate_limited', () => {
    let t = 1_000_000;
    const limiter = createPerUserRateLimiter({ perMinute: 3, perDay: 100, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('u1')).toBeNull();
      limiter.record('u1');
    }
    expect(limiter.check('u1')).toBe('rate_limited');
    // A different user is unaffected.
    expect(limiter.check('u2')).toBeNull();
    // After the minute passes, requests flow again.
    t += 61_000;
    expect(limiter.check('u1')).toBeNull();
  });

  it('refuses as daily_quota_reached at the per-day cap', () => {
    let t = Date.UTC(2026, 10, 7, 12, 0, 0);
    const limiter = createPerUserRateLimiter({ perMinute: 1000, perDay: 2, now: () => t });
    limiter.record('u1');
    limiter.record('u1');
    expect(limiter.check('u1')).toBe('daily_quota_reached');
    // Next UTC day resets the daily window.
    t = Date.UTC(2026, 10, 8, 0, 0, 1);
    expect(limiter.check('u1')).toBeNull();
  });
});
