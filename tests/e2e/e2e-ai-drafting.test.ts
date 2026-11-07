/**
 * Phase 10.3 E2E (Area 11) — AI drafting: all four actions for the
 * owner, and the negative guarantee that drafting can NEVER send.
 *
 * tests/ai-generate-route.test.ts proves each action and the F-1/F-2/
 * F-3/F-4 details individually; tests/ai-mixed-scope-negative.test.ts
 * proves no runtime-AI code exists in source. This file EXTENDS both
 * with the runtime journey staging Area 12 needs locally: ONE owner
 * session performs all four drafting actions against a mocked Workers
 * AI binding, the usage log is checked as a SET (exactly the four
 * truthful feature values, metadata-only rows), and — the negative
 * assertion — every Meta send mock in the harness AND the fetch guard
 * must record ZERO calls: a drafting request has no path to a DM or a
 * public reply.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import { createFetchGuard, stubFetchGuard, type FetchGuard } from './helpers/harness';

const fake = new FakeSupabase();

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/instagram/api', () => ({
  sendInstagramDm: vi.fn(async () => 'must-never-be-called'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'must-never-be-called'),
  sendInstagramCardDm: vi.fn(async () => 'must-never-be-called'),
  sendAskToFollowDm: vi.fn(async () => 'must-never-be-called'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
}));

import { POST } from '@/app/api/ai/generate/route';
import {
  sendInstagramDm,
  sendInstagramLinkButtonDm,
  sendInstagramCardDm,
  sendAskToFollowDm,
  replyToComment,
  getAudienceProfile,
} from '@/lib/instagram/api';

const sendMocks = [
  vi.mocked(sendInstagramDm),
  vi.mocked(sendInstagramLinkButtonDm),
  vi.mocked(sendInstagramCardDm),
  vi.mocked(sendAskToFollowDm),
  vi.mocked(replyToComment),
  vi.mocked(getAudienceProfile),
];

const OWNER = { id: 'owner-user-id', email: 'owner@example.com' };
const OTHER = { id: 'other-user-id', email: 'other@example.com' };
const ENV_KEYS = ['OWNER_USER_ID', 'OWNER_EMAIL'] as const;
let savedEnv: Record<string, string | undefined> = {};
let guard: FetchGuard;

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/ai/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installAiBinding(): void {
  (globalThis as any).__WORKERS_AI_BINDING = {
    run: vi.fn().mockResolvedValue({
      response:
        'Alpha draft one here\nBeta draft two here\nGamma draft three here\nDelta draft four here\nEpsilon draft five here',
    }),
  };
}

function expectZeroSends(): void {
  for (const mock of sendMocks) expect(mock).not.toHaveBeenCalled();
  expect(guard.metaAttempts).toHaveLength(0);
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env['OWNER_USER_ID'] = OWNER.id;
  mockGetAuthenticatedUser.mockReset();
  fake.calls.length = 0;
  fake.replaceRows('ai_usage_log', []);
  for (const mock of sendMocks) mock.mockClear();
  guard = createFetchGuard();
  stubFetchGuard(guard);
  delete (globalThis as any).__WORKERS_AI_BINDING;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete (globalThis as any).__WORKERS_AI_BINDING;
  vi.unstubAllGlobals();
});

describe('the owner drafting journey — four actions, four truthful usage rows, zero sends', () => {
  it('all four actions return drafts; usage log holds exactly the four feature values; send mocks untouched', async () => {
    installAiBinding();

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const opening = await POST(postRequest({ action: 'opening_variations', prompt: 'Warm welcome', count: 5 }));
    expect(opening.status).toBe(200);
    const openingJson = (await opening.json()) as { variations: string[] };
    expect(openingJson.variations.length).toBe(5);

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const replies = await POST(postRequest({ action: 'public_replies', prompt: 'Friendly + emojis', count: 5 }));
    expect(replies.status).toBe(200);
    const repliesJson = (await replies.json()) as { variations: string[]; options: string[] };
    expect(repliesJson.variations.length).toBe(5);
    expect(repliesJson.options).toEqual(repliesJson.variations);

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const response = await POST(postRequest({ action: 'response_draft', prompt: 'Explain the program' }));
    expect(response.status).toBe(200);
    expect(typeof ((await response.json()) as { draft: string }).draft).toBe('string');

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const followUp = await POST(postRequest({ action: 'follow_up_draft', prompt: 'Polite check-in' }));
    expect(followUp.status).toBe(200);
    expect(typeof ((await followUp.json()) as { draft: string }).draft).toBe('string');

    // Usage log as a SET: one row per action, truthful feature names —
    // response_draft (NOT runtime_response, F-2) and follow_up_draft
    // (the value the 000021 CHECK upgrade admits, F-1) — metadata only.
    const rows = fake.rows('ai_usage_log');
    expect(rows.map((r) => r['feature'])).toEqual([
      'opening_variations',
      'public_reply_draft',
      'response_draft',
      'follow_up_draft',
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        expect.arrayContaining(['feature', 'model', 'status', 'user_id'])
      );
      expect(JSON.stringify(row)).not.toContain('Warm welcome');
      expect(row['user_id']).toBe(OWNER.id);
    }

    // THE NEGATIVE: four drafting calls, zero Meta sends of any kind.
    expectZeroSends();
  });

  it('binding unavailable: drafting degrades honestly (fallbacks / 503 for public_replies) — still zero sends', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const opening = await POST(postRequest({ action: 'opening_variations', prompt: 'Hi', count: 3 }));
    expect(opening.status).toBe(200);
    expect(((await opening.json()) as { variations: string[] }).variations.length).toBe(3);

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const replies = await POST(postRequest({ action: 'public_replies', prompt: 'Hi' }));
    expect(replies.status).toBe(503); // never fabricates a "generated" reply

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const draft = await POST(postRequest({ action: 'response_draft', prompt: 'Hi' }));
    expect(draft.status).toBe(200);

    expectZeroSends();
  });

  it('non-owner: all four actions refused 403, no usage rows written, zero sends', async () => {
    installAiBinding();
    for (const action of ['opening_variations', 'public_replies', 'response_draft', 'follow_up_draft']) {
      mockGetAuthenticatedUser.mockResolvedValue(OTHER);
      const res = await POST(postRequest({ action, prompt: 'Hi' }));
      expect(res.status).toBe(403);
    }
    expect(fake.rows('ai_usage_log')).toHaveLength(0);
    expectZeroSends();
  });
});
