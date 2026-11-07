/**
 * Area — Creator Studio Groq generic text client (Programme S2).
 *
 * The sibling of the S1 ideas client, used by the Script Builder's
 * section polish: same model rotation, quota-dominance and response
 * cache discipline, proven here with a stubbed fetch.
 */

import { describe, it, expect, vi } from 'vitest';
import { createGroqTextClient, GroqError, GROQ_MODELS } from '@/lib/studio/groq';

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const INPUT = { system: 'sys', user: 'polish this', cacheKey: 'k-1' };

describe('createGroqTextClient', () => {
  it('returns text + model on success and rotates the cursor', async () => {
    const models: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      models.push((JSON.parse(String(init.body)) as { model: string }).model);
      return okResponse('Polished text.');
    });
    const client = createGroqTextClient({ apiKey: 'test-key', fetchFn });
    const first = await client.generateText(INPUT);
    expect(first).toMatchObject({ text: 'Polished text.', cached: false });
    expect(first.model).toBe(GROQ_MODELS[0]);
    const second = await client.generateText({ ...INPUT, cacheKey: 'k-2' });
    expect(second.model).toBe(GROQ_MODELS[1]);
    expect(models).toEqual([GROQ_MODELS[0], GROQ_MODELS[1]]);
  });

  it('serves an identical request from the cache without a second fetch', async () => {
    const fetchFn = vi.fn(async () => okResponse('Cached text.'));
    const client = createGroqTextClient({ apiKey: 'test-key', fetchFn });
    const a = await client.generateText(INPUT);
    const b = await client.generateText(INPUT);
    expect(a.cached).toBe(false);
    expect(b).toMatchObject({ text: 'Cached text.', cached: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rotates past a 429 and reports quota only when every model is limited', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      if (model === GROQ_MODELS[0]) return new Response('{}', { status: 429 });
      return okResponse('Recovered.');
    });
    const client = createGroqTextClient({ apiKey: 'test-key', fetchFn });
    const out = await client.generateText(INPUT);
    expect(out.text).toBe('Recovered.');
    expect(out.model).toBe(GROQ_MODELS[1]);

    const allLimited = createGroqTextClient({
      apiKey: 'test-key',
      fetchFn: vi.fn(async () => new Response('{}', { status: 429 })),
    });
    await expect(allLimited.generateText(INPUT)).rejects.toMatchObject({
      name: 'GroqError',
      code: 'quota',
    });
  });

  it('maps a 5xx to unavailable and empty content to bad_response', async () => {
    const fivexx = createGroqTextClient({
      apiKey: 'test-key',
      fetchFn: vi.fn(async () => new Response('{}', { status: 503 })),
    });
    await expect(fivexx.generateText(INPUT)).rejects.toMatchObject({ code: 'unavailable' });

    const empty = createGroqTextClient({
      apiKey: 'test-key',
      fetchFn: vi.fn(async () => okResponse('   ')),
    });
    await expect(empty.generateText(INPUT)).rejects.toBeInstanceOf(GroqError);
    await expect(
      createGroqTextClient({ apiKey: 'test-key', fetchFn: vi.fn(async () => okResponse('x')) })
        .generateText(INPUT)
    ).resolves.toMatchObject({ text: 'x' });
  });
});
