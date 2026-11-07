/**
 * Area — Creator Studio free-AI route, script_polish task (Programme S2).
 *
 * Same degradation contract as the S1 video_ideas task (which keeps
 * its own test file): unauthenticated → 401, invalid body → 400, no
 * GROQ_API_KEY → typed not_configured, mocked Groq success → the
 * polished text labelled free-ai with its model, all-models-limited
 * → typed quota_reached. Auth/logger mocked; fetch stubbed; no real
 * key exists in this environment.
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
  return { id: `polish-user-${userSeq}`, email: `p${userSeq}@example.test` };
}

function request(body: unknown) {
  return new Request('http://localhost/api/studio/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  task: 'script_polish',
  topic: 'free AI video tools',
  format: 'reel30',
  tone: 'energetic',
  sectionKind: 'hook',
  sectionHeading: 'Hook',
  sectionText: 'Today we will look at some tools.',
};

beforeEach(() => {
  mockGetAuthenticatedUser.mockReset();
  delete process.env['GROQ_API_KEY'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env['GROQ_API_KEY'];
  else process.env['GROQ_API_KEY'] = ORIGINAL_KEY;
});

describe('POST /api/studio/generate — script_polish', () => {
  it('rejects unauthenticated requests with 401', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid polish body with 400', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await POST(request({ ...VALID_BODY, sectionText: '' }));
    expect(res.status).toBe(400);
    const badTask = await POST(request({ ...VALID_BODY, task: 'unknown_task' }));
    expect(badTask.status).toBe(400);
  });

  it('returns the typed not_configured response when no Groq key is set', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: 'not_configured', engine: 'built-in' });
  });

  it('returns the polished section on a mocked Groq success', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Stop scrolling — these tools are free.' } }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    const res = await POST(request(VALID_BODY));
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
    expect(body.text).toBe('Stop scrolling — these tools are free.');
    expect(typeof body.model).toBe('string');
  });

  it('returns the typed quota_reached degradation when every model is limited', async () => {
    process.env['GROQ_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    const res = await POST(request({ ...VALID_BODY, sectionText: 'A unique section body for quota.' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: 'quota_reached', engine: 'built-in' });
  });
});
