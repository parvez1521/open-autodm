/**
 * Area — AI Generate API Route (/api/ai/generate, Phase 7).
 *
 * Adapted from release-prep src/app/api/ai/ai-generate.test.ts (9 tests).
 * The release-prep test pinning feature 'runtime_response' is UPDATED, not
 * ported as-is (F-2: the route now logs the truthful 'response_draft').
 * New tests marked ◆ cover the proposal §6 plan: the F-4 owner gate
 * (403 non-owner / 403 unconfigured), usage-logging payloads per action
 * (F-1/F-2), the F-3 checked-insert warning, and the builder-payload
 * contract (top-level fields only — a nested `context` object must not
 * smuggle a caption into the provider call).
 *
 * Auth is mocked; the owner guard under test is the REAL src/lib/owner.ts
 * (env-driven, as in tests/setup-route.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetAuthenticatedUser, mockFrom, mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
  mockFrom: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockFrom,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));

vi.mock('@/lib/debugLog', () => ({
  debugLog: vi.fn(),
}));

import { POST } from '@/app/api/ai/generate/route';

const OWNER = { id: 'owner-user-id', email: 'owner@example.com' };
const OTHER = { id: 'other-user-id', email: 'other@example.com' };

const ENV_KEYS = ['OWNER_USER_ID', 'OWNER_EMAIL'] as const;
let savedEnv: Record<string, string | undefined> = {};

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/ai/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AI Generate API Route (/api/ai/generate)', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockGetAuthenticatedUser.mockReset();
    mockFrom.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockFrom.mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    });
    delete (globalThis as any).__WORKERS_AI_BINDING;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    delete (globalThis as any).__WORKERS_AI_BINDING;
  });

  it('rejects unauthenticated requests with 401', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ action: 'opening_variations' }));
    expect(res.status).toBe(401);
  });

  it('◆ rejects an authenticated NON-owner with 403 (F-4)', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OTHER);
    const res = await POST(postRequest({ action: 'opening_variations' }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe('Forbidden');
  });

  it('◆ rejects EVERYONE with 403 when no owner is configured (F-4 fail-closed)', async () => {
    delete process.env['OWNER_USER_ID'];
    delete process.env['OWNER_EMAIL'];
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const res = await POST(postRequest({ action: 'opening_variations' }));
    expect(res.status).toBe(403);
  });

  it('rejects invalid action with 400', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const res = await POST(postRequest({ action: 'invalid_action_xyz' }));
    expect(res.status).toBe(400);
  });

  it('handles opening_variations in custom mode and returns 5 variations', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const res = await POST(postRequest({
      action: 'opening_variations',
      prompt: 'Make it super friendly and casual',
      mode: 'custom',
      count: 5,
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(Array.isArray(json.variations)).toBe(true);
    expect(json.variations.length).toBe(5);
  });

  it('handles opening_variations in auto mode with empty prompt safely', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const res = await POST(postRequest({
      action: 'opening_variations',
      prompt: '',
      mode: 'auto',
      postCaption: 'Free fitness diet guide link in bio',
      automationName: 'Diet Guide Funnel',
      count: 5,
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.variations.length).toBe(5);
  });

  it('handles public_replies with active AI binding and returns genuinely generated variations', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    (globalThis as any).__WORKERS_AI_BINDING = {
      run: vi.fn().mockResolvedValue({
        response: `Just sent you a DM with the VIP link! 🚀
Check your message requests for access! ✨
Sent to your inbox right now! 📬
All details are in your DMs! 📩
Messaged you the secret link! 🙌`,
      }),
    };

    const res = await POST(postRequest({
      action: 'public_replies',
      prompt: 'Short friendly reply with emojis',
      mode: 'custom',
      count: 5,
    }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBe('success');
    expect(json.variations.length).toBe(5);
    expect(json.variations[0]).toBe('Just sent you a DM with the VIP link! 🚀');
    expect(Array.isArray(json.options)).toBe(true);
    expect(json.options[0]).toBe('Just sent you a DM with the VIP link! 🚀');
  });

  it('supports public_replies via type alias (comment_reply_options / public_reply) with context', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    (globalThis as any).__WORKERS_AI_BINDING = {
      run: vi.fn().mockResolvedValue({
        response: `Sent the guide to your inbox! 📥
Check your requests! ✨
All workout details sent! 🚀
Just messaged you! 📬
Check your DMs! 🙌`,
      }),
    };

    const res = await POST(postRequest({
      type: 'comment_reply_options',
      prompt: 'Friendly reply confirming DM sent',
      automationName: 'Free Guide Funnel',
      postCaption: 'Comment GUIDE for full workout',
      count: 5,
    }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBe('success');
    expect(Array.isArray(json.variations)).toBe(true);
    expect(json.variations.length).toBe(5);
    expect(json.variations[0]).toBe('Sent the guide to your inbox! 📥');
  });

  it('◆ maps the remaining legacy type aliases (opening_variations / response_draft / follow_up_draft)', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const resOpening = await POST(postRequest({ type: 'opening_variations', prompt: 'Hi', count: 2 }));
    expect(resOpening.status).toBe(200);

    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const resResponse = await POST(postRequest({ type: 'response_draft', prompt: 'Explain the program' }));
    expect(resResponse.status).toBe(200);
    const jsonResponse = (await resResponse.json()) as any;
    expect(typeof jsonResponse.draft).toBe('string');

    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const resFollowUp = await POST(postRequest({ type: 'follow_up_draft', prompt: 'Check in' }));
    expect(resFollowUp.status).toBe(200);
    const jsonFollowUp = (await resFollowUp.json()) as any;
    expect(typeof jsonFollowUp.draft).toBe('string');
  });

  it('returns a clear 503 failure and does NOT fabricate static defaults when AI binding is unavailable', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);

    const res = await POST(postRequest({
      action: 'public_replies',
      prompt: 'Short friendly reply with emojis',
    }));
    expect(res.status).toBe(503);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.status).toBe('fallback');
    expect(json.error).toContain('AI generation is currently unavailable');
    expect(json.variations).toBeUndefined();
  });

  it('returns a clear 503 failure when AI provider execution errors or times out', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    (globalThis as any).__WORKERS_AI_BINDING = {
      run: vi.fn().mockRejectedValue(new Error('Rate limit: 10,000 Neurons/day quota exceeded')),
    };

    const res = await POST(postRequest({
      action: 'public_replies',
      prompt: 'Short friendly reply with emojis',
    }));

    expect(res.status).toBe(503);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.status).toBe('fallback');
    expect(json.error).toContain('AI generation is currently unavailable');
  });

  it('handles response_draft generation and logs under the truthful response_draft feature (F-2)', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertMock });

    const res = await POST(postRequest({
      action: 'response_draft',
      prompt: 'Explain what is inside the workout program',
      mode: 'custom',
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(typeof json.draft).toBe('string');
    expect(json.draft.length).toBeGreaterThan(0);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: OWNER.id,
        feature: 'response_draft',
      })
    );
    expect(insertMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'runtime_response' })
    );
  });

  it('◆ logs follow_up_draft under its own feature name (F-1 — the value the old CHECK rejected)', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertMock });

    const res = await POST(postRequest({
      action: 'follow_up_draft',
      prompt: 'Polite check-in',
      automationName: 'Guide Funnel',
    }));
    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: OWNER.id,
        feature: 'follow_up_draft',
      })
    );
  });

  it('◆ logs every action with only { user_id, feature, model, status } — no prompt, caption, or generated text', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertMock });
    (globalThis as any).__WORKERS_AI_BINDING = {
      run: vi.fn().mockResolvedValue({
        response: `Reply one here! 📥\nReply two here! ✨\nReply three! 🚀\nReply four! 📬\nReply five! 🙌`,
      }),
    };

    const res = await POST(postRequest({
      action: 'public_replies',
      prompt: 'TOP-SECRET-PROMPT',
      postCaption: 'TOP-SECRET-CAPTION',
      count: 5,
    }));
    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const payload = insertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['feature', 'model', 'status', 'user_id']);
    expect(payload['feature']).toBe('public_reply_draft');
    expect(JSON.stringify(payload)).not.toContain('TOP-SECRET');
  });

  it('◆ an insert returning { error } warns via the logger and the generation still succeeds (F-3)', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const insertMock = vi.fn().mockResolvedValue({ error: new Error('CHECK constraint violated') });
    mockFrom.mockReturnValue({ insert: insertMock });

    const res = await POST(postRequest({
      action: 'response_draft',
      prompt: 'Explain the program',
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(String(mockLoggerWarn.mock.calls[0]?.[1] ?? '')).toContain('Failed to record AI usage log');
  });

  it('◆ builder-payload contract: top-level postCaption reaches the provider; a nested context object does not', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const run = vi.fn().mockResolvedValue({
      response: '1. Hey {username}! Your guide is waiting 👇\n2. Thanks for commenting — link sent ✨\n3. Got it! Check your DMs 📬\n4. Sent! Your free guide is in your inbox 🚀\n5. Here it is {username}! Check your messages 🙌',
    });
    (globalThis as any).__WORKERS_AI_BINDING = { run };

    // Top-level fields, as ConfigureStep sends them.
    const res = await POST(postRequest({
      action: 'opening_variations',
      prompt: 'Warm welcome for the diet guide',
      postCaption: 'Comment DIET for the free guide',
      automationName: 'Diet Guide Funnel',
      count: 5,
    }));
    expect(res.status).toBe(200);
    const userContent = (run.mock.calls[0]![1] as any).messages
      .map((m: any) => m.content)
      .join('\n');
    expect(userContent).toContain('Comment DIET for the free guide');
    expect(userContent).toContain('Warm welcome for the diet guide');

    // Stale RP-client shape: caption only inside a nested `context` object.
    // The zod schema strips unknown fields, so the caption must NOT reach AI.
    run.mockClear();
    mockGetAuthenticatedUser.mockResolvedValueOnce(OWNER);
    const resStale = await POST(postRequest({
      action: 'opening_variations',
      prompt: '',
      context: { creatorHandle: 'parvez', triggerKeyword: 'GUIDE', postCaption: 'SECRET-CAPTION-MUST-NOT-LEAK' },
      automationName: 'Guide Funnel',
      count: 5,
    }));
    expect(resStale.status).toBe(200);
    const staleContent = (run.mock.calls[0]![1] as any).messages
      .map((m: any) => m.content)
      .join('\n');
    expect(staleContent).not.toContain('SECRET-CAPTION-MUST-NOT-LEAK');
    expect(staleContent).not.toContain('parvez');
  });
});
