/**
 * Area — Creator Studio free-AI route (/api/studio/generate, S1).
 *
 * Pins the typed degradation contract the client relies on:
 *  - unauthenticated → 401 (the app's standard unauthorized response)
 *  - invalid body → 400
 *  - no GROQ_API_KEY configured → 200 { code: 'not_configured' }
 *  - mocked Groq success → 200 { ok: true, engine: 'free-ai', ideas }
 *  - every model at its free limit → 200 { code: 'quota_reached' }
 *  - the route's own per-user limiter → 429 { code: 'rate_limited' }
 * Auth and the logger are mocked; global fetch is stubbed. No real key
 * exists in this environment and none is needed.
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
  return { id: `studio-user-${userSeq}`, email: `u${userSeq}@example.test` };
}

function request(body: unknown) {
  return new Request('http://localhost/api/studio/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  task: 'video_ideas',
  topic: 'home workouts',
  category: 'Fitness',
  mode: 'proven',
  count: 3,
};

function groqOk(titles: string[]) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(
              titles.map((title) => ({ title, format: 'F', whyItWorks: 'W.' }))
            ),
          },
        },
      ],
    }),
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

describe('POST /api/studio/generate', () => {
  it('rejects unauthenticated requests with 401', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid body with 400', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await POST(request({ task: 'video_ideas', topic: '', category: 'Fitness', mode: 'proven' }));
    expect(res.status).toBe(400);
  });

  it('returns the typed not_configured response when no Groq key is set', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: 'not_configured', engine: 'built-in' });
  });

  it('returns free-ai ideas on a mocked Groq success', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => groqOk(['AI idea one', 'AI idea two'])));
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      engine: string;
      provider: string;
      ideas: { title: string; engine: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.engine).toBe('free-ai');
    expect(body.provider).toBe('groq');
    expect(body.ideas.map((i) => i.title)).toContain('AI idea one');
    expect(body.ideas.every((i) => i.engine === 'free-ai')).toBe(true);
  });

  it('returns the typed quota_reached degradation when every model is limited', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    const res = await POST(request({ ...VALID_BODY, topic: 'a completely different topic for quota' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: 'quota_reached', engine: 'built-in' });
  });

  it('throttles a single user with 429 rate_limited after the per-minute cap', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    const user = authedUser();
    mockGetAuthenticatedUser.mockResolvedValue(user);
    vi.stubGlobal('fetch', vi.fn(async () => groqOk(['Spam idea'])));
    let lastStatus = 0;
    let lastBody: { code?: string } = {};
    for (let i = 0; i < 11; i++) {
      const res = await POST(request({ ...VALID_BODY, topic: `spam topic ${i}` }));
      lastStatus = res.status;
      lastBody = (await res.json()) as { code?: string };
    }
    expect(lastStatus).toBe(429);
    expect(lastBody.code).toBe('rate_limited');
  });
});
