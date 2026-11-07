/**
 * Area — Creator Studio free-AI route, slide_polish task (Programme S3).
 *
 * Mirrors the script_polish route test: unauthenticated → 401, invalid
 * bullet counts → 400, no GROQ_API_KEY → typed not_configured, mocked
 * Groq success → polished lines labelled free-ai, blank Groq output →
 * ai_unavailable, all-models-limited → typed quota_reached. Auth and
 * the logger are mocked; global fetch is stubbed; unique user per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from '@/app/api/studio/generate/route';

const ORIGINAL_KEY = process.env['GROQ_API_KEY'];
let userSeq = 0;

function authedUser() {
  userSeq += 1;
  return { id: `deck-user-${userSeq}`, email: `d${userSeq}@example.test` };
}

function request(body: unknown) {
  return new Request('http://localhost/api/studio/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  task: 'slide_polish',
  topic: 'getting started with home workouts',
  audience: 'busy parents',
  slideTitle: 'The problem',
  bullets: ['Workouts feel too long.', 'Advice is confusing.'],
};

function groqText(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

beforeEach(() => {
  mockGetAuthenticatedUser.mockReset();
  delete process.env['GROQ_API_KEY'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env['GROQ_API_KEY'];
  else process.env['GROQ_API_KEY'] = ORIGINAL_KEY;
});

describe('POST /api/studio/generate — slide_polish', () => {
  it('rejects unauthenticated requests with 401', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('rejects invalid bodies with 400 (0 bullets and 9 bullets)', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const zero = await POST(request({ ...VALID_BODY, bullets: [] }));
    expect(zero.status).toBe(400);
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const nine = await POST(
      request({ ...VALID_BODY, bullets: Array.from({ length: 9 }, (_, i) => `Bullet ${i + 1}`) })
    );
    expect(nine.status).toBe(400);
  });

  it('returns the typed not_configured response when no Groq key is set', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: 'not_configured', engine: 'built-in' });
  });

  it('returns the polished bullets on a mocked Groq success', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        groqText('Workouts feel longer than they are.\nAdvice is clearer in steps.\nStart small and finish.')
      )
    );
    const res = await POST(
      request({ ...VALID_BODY, topic: 'home workouts deck success case' })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      engine: string;
      provider: string;
      model: string;
      text: string;
    };
    expect(body.ok).toBe(true);
    expect(body.engine).toBe('free-ai');
    expect(body.provider).toBe('groq');
    expect(typeof body.model).toBe('string');
    expect(body.text).toContain('Workouts feel longer than they are.');
    expect(body.text).toContain('Advice is clearer in steps.');
    expect(body.text).toContain('Start small and finish.');
    expect(body.text.split('\n')).toHaveLength(3);
  });

  it('returns ai_unavailable when Groq returns blank output', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => groqText('   ')));
    const res = await POST(
      request({ ...VALID_BODY, topic: 'home workouts deck blank case', bullets: ['A unique bullet for blank.'] })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: 'ai_unavailable', engine: 'built-in' });
  });

  it('returns the typed quota_reached degradation when every model is limited', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    const res = await POST(
      request({ ...VALID_BODY, topic: 'home workouts deck quota case', bullets: ['A unique bullet for quota.'] })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: 'quota_reached', engine: 'built-in' });
  });
});
