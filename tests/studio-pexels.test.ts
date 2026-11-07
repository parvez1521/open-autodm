/**
 * Area — Creator Studio Pexels stock client + route (Programme S3).
 *
 * Client: fixture mapping for one image + one video (every field,
 * including credits), the video-file choice (mp4 preferred, largest
 * width ≤ 1920), and the error mapping (429 → quota, 5xx →
 * unavailable, garbage → bad_response).
 * Route: auth gate, validation, the typed not_configured state when
 * no PEXELS_API_KEY is set, a mocked success, and an upstream 429
 * surfacing as quota_reached. Auth/logger mocked; fetch stubbed.
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

import { PexelsError, createPexelsClient } from '@/lib/studio/pexels';
import { GET } from '@/app/api/studio/pexels/route';

const IMAGE_BODY = {
  total_results: 132,
  page: 1,
  per_page: 15,
  next_page: 'https://api.pexels.com/v1/search?page=2',
  photos: [
    {
      id: 12345,
      width: 4000,
      height: 3000,
      url: 'https://www.pexels.com/photo/12345/',
      photographer: 'Jane Doe',
      photographer_url: 'https://www.pexels.com/@jane-doe',
      alt: 'A tidy desk setup',
      src: {
        original: 'https://images.pexels.com/photos/12345/original.jpg',
        large: 'https://images.pexels.com/photos/12345/large.jpg',
        medium: 'https://images.pexels.com/photos/12345/medium.jpg',
        small: 'https://images.pexels.com/photos/12345/small.jpg',
      },
    },
  ],
};

const VIDEO_BODY = {
  total_results: 42,
  page: 1,
  per_page: 15,
  videos: [
    {
      id: 6789,
      width: 1920,
      height: 1080,
      url: 'https://www.pexels.com/video/6789/',
      image: 'https://images.pexels.com/videos/6789/preview.jpg',
      duration: 12,
      user: { name: 'John Clip', url: 'https://www.pexels.com/@john-clip' },
      video_files: [
        { file_type: 'video/webm', width: 1920, link: 'https://videos.pexels.com/6789/webm-1920.webm' },
        { file_type: 'video/mp4', width: 3840, link: 'https://videos.pexels.com/6789/mp4-3840.mp4' },
        { file_type: 'video/mp4', width: 1920, link: 'https://videos.pexels.com/6789/mp4-1920.mp4' },
        { file_type: 'video/mp4', width: 1280, link: 'https://videos.pexels.com/6789/mp4-1280.mp4' },
      ],
    },
  ],
};

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createPexelsClient — images', () => {
  it('maps every photo field including the credit fields', async () => {
    const seen: { url?: string; auth?: string } = {};
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.auth = (init.headers as Record<string, string>)['Authorization'];
      return jsonRes(IMAGE_BODY);
    });
    const client = createPexelsClient({ apiKey: 'test-key', fetchFn });
    const result = await client.searchImages({ query: 'desk setup' });

    expect(seen.url).toContain('https://api.pexels.com/v1/search?');
    expect(seen.url).toContain('query=desk+setup');
    expect(seen.url).toContain('per_page=15');
    expect(seen.auth).toBe('test-key');

    expect(result.totalResults).toBe(132);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(15);
    expect(result.hasNext).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: '12345',
      media: 'image',
      title: 'A tidy desk setup',
      pageUrl: 'https://www.pexels.com/photo/12345/',
      creator: 'Jane Doe',
      creatorUrl: 'https://www.pexels.com/@jane-doe',
      previewUrl: 'https://images.pexels.com/photos/12345/medium.jpg',
      assetUrl: 'https://images.pexels.com/photos/12345/large.jpg',
      width: 4000,
      height: 3000,
    });
  });

  it('clamps perPage into 1..40 and defaults to 15', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonRes({ total_results: 0, photos: [] });
    });
    const client = createPexelsClient({ apiKey: 'k', fetchFn });
    await client.searchImages({ query: 'x', perPage: 500 });
    expect(urls[0]).toContain('per_page=40');
    const small = await client.searchImages({ query: 'x', perPage: 0 });
    expect(urls[1]).toContain('per_page=1');
    expect(small.perPage).toBe(1);
  });
});

describe('createPexelsClient — videos', () => {
  it('maps every video field and picks the best mp4 at or under 1920 wide', async () => {
    const fetchFn = vi.fn(async () => jsonRes(VIDEO_BODY));
    const client = createPexelsClient({ apiKey: 'test-key', fetchFn });
    const result = await client.searchVideos({ query: 'ocean' });

    expect(result.totalResults).toBe(42);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: '6789',
      media: 'video',
      title: 'Video by John Clip',
      pageUrl: 'https://www.pexels.com/video/6789/',
      creator: 'John Clip',
      creatorUrl: 'https://www.pexels.com/@john-clip',
      previewUrl: 'https://images.pexels.com/videos/6789/preview.jpg',
      assetUrl: 'https://videos.pexels.com/6789/mp4-1920.mp4',
      width: 1920,
      height: 1080,
      durationSec: 12,
    });
  });

  it('falls back to the largest file when no mp4 is at or under 1920', async () => {
    const body = {
      total_results: 1,
      videos: [
        {
          id: 1,
          url: 'https://www.pexels.com/video/1/',
          image: 'https://images.pexels.com/videos/1/preview.jpg',
          duration: 5,
          user: { name: 'A', url: 'https://www.pexels.com/@a' },
          video_files: [
            { file_type: 'video/mp4', width: 3840, link: 'https://videos.pexels.com/1/mp4-3840.mp4' },
            { file_type: 'video/mp4', width: 2560, link: 'https://videos.pexels.com/1/mp4-2560.mp4' },
          ],
        },
      ],
    };
    const client = createPexelsClient({ apiKey: 'k', fetchFn: vi.fn(async () => jsonRes(body)) });
    const result = await client.searchVideos({ query: 'x' });
    expect(result.items[0]!.assetUrl).toBe('https://videos.pexels.com/1/mp4-3840.mp4');
  });
});

describe('createPexelsClient — errors', () => {
  it('maps 429 to a quota PexelsError', async () => {
    const client = createPexelsClient({
      apiKey: 'k',
      fetchFn: vi.fn(async () => new Response('{}', { status: 429 })),
    });
    await expect(client.searchImages({ query: 'x' })).rejects.toMatchObject({
      name: 'PexelsError',
      code: 'quota',
    });
    await expect(client.searchImages({ query: 'x' })).rejects.toBeInstanceOf(PexelsError);
  });

  it('maps other non-ok statuses to unavailable', async () => {
    const client = createPexelsClient({
      apiKey: 'k',
      fetchFn: vi.fn(async () => new Response('{}', { status: 500 })),
    });
    await expect(client.searchVideos({ query: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('maps garbage JSON and a missing array to bad_response', async () => {
    const garbage = createPexelsClient({
      apiKey: 'k',
      fetchFn: vi.fn(async () => new Response('this is not json', { status: 200 })),
    });
    await expect(garbage.searchImages({ query: 'x' })).rejects.toMatchObject({ code: 'bad_response' });

    const noArray = createPexelsClient({
      apiKey: 'k',
      fetchFn: vi.fn(async () => jsonRes({ total_results: 3 })),
    });
    await expect(noArray.searchImages({ query: 'x' })).rejects.toMatchObject({ code: 'bad_response' });
    await expect(noArray.searchVideos({ query: 'x' })).rejects.toMatchObject({ code: 'bad_response' });
  });
});

// ── Route ──────────────────────────────────────────────────────────

const ORIGINAL_KEY = process.env['PEXELS_API_KEY'];
let userSeq = 0;

function authedUser() {
  userSeq += 1;
  return { id: `pexels-user-${userSeq}`, email: `p${userSeq}@example.test` };
}

function getReq(qs: string) {
  return new Request(`http://localhost/api/studio/pexels?${qs}`);
}

beforeEach(() => {
  mockGetAuthenticatedUser.mockReset();
  delete process.env['PEXELS_API_KEY'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env['PEXELS_API_KEY'];
  else process.env['PEXELS_API_KEY'] = ORIGINAL_KEY;
});

describe('GET /api/studio/pexels', () => {
  it('rejects unauthenticated requests with 401', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const res = await GET(getReq('media=image&q=desk'));
    expect(res.status).toBe(401);
  });

  it('rejects media=audio with 400', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await GET(getReq('media=audio&q=desk'));
    expect(res.status).toBe(400);
  });

  it('rejects a missing q with 400', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await GET(getReq('media=image'));
    expect(res.status).toBe(400);
  });

  it('returns 200 not_configured when no PEXELS_API_KEY is set', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await GET(getReq('media=image&q=desk'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: 'not_configured' });
  });

  it('returns ok items carrying creator + pageUrl on a mocked success', async () => {
    process.env['PEXELS_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(IMAGE_BODY)));
    const res = await GET(getReq('media=image&q=desk'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      provider: string;
      providerUrl: string;
      licenseUrl: string;
      totalResults: number;
      hasNext: boolean;
      items: { creator: string; pageUrl: string; title: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('pexels');
    expect(body.providerUrl).toBe('https://www.pexels.com');
    expect(body.licenseUrl).toBe('https://www.pexels.com/license/');
    expect(body.totalResults).toBe(132);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.creator).toBe('Jane Doe');
    expect(body.items[0]!.pageUrl).toBe('https://www.pexels.com/photo/12345/');
  });

  it('maps an upstream 429 to 200 quota_reached', async () => {
    process.env['PEXELS_API_KEY'] = 'test-key-not-real';
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    const res = await GET(getReq('media=video&q=ocean'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: 'quota_reached' });
  });
});
