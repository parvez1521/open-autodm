/**
 * Area — Instagram post resolve route (POST /api/instagram/posts/:accountId/resolve).
 *
 * Regression: the picker list comes from Graph API /{ig-user-id}/media,
 * which only returns posts the connected account OWNS. Collab posts
 * owned by the other account (e.g. the Nov 14 "Clone any tool" reel,
 * owned by tech_hacks.ai) never appear in the grid, so the picker
 * gained a paste-link path: oEmbed maps the public post URL to its
 * media ID, then /{media-id} fetches the post, mapped to the EXACT
 * post shape the list route returns.
 *
 * Auth, DB, crypto and env are mocked following
 * tests/ai-generate-route.test.ts / tests/instagram-posts-refresh.test.ts;
 * fetch is stubbed per test (oEmbed call, then media call).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeInstagramShortcode } from '@/lib/instagram/postUrl';

const USER = { id: 'resolve-test-user' };
const ACCOUNT_ID = 'resolve-test-account';

const IG_ACCOUNT = {
  id: ACCOUNT_ID,
  instagram_user_id: '17841400000000000',
  access_token_encrypted: 'enc-token',
};

const { mockSingle, mockFetch } = vi.hoisted(() => ({
  mockSingle: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: () => USER,
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.single = mockSingle;
      return chain;
    },
  }),
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: () => 'meta-access-token',
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'test-key' }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/tenancy/workspaceFlags', () => ({
  readWorkspaceFlags: () => ({ workspaceRuntimeEnabled: false }),
}));

import { POST } from '@/app/api/instagram/posts/[accountId]/resolve/route';

const SHORTCODE = 'DfuQz-VKO0y';
const POST_URL = `https://www.instagram.com/p/${SHORTCODE}/`;
const MEDIA_ID = '17841400000000001';

function metaMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ID,
    media_type: 'VIDEO',
    thumbnail_url: `https://cdn.example.com/${MEDIA_ID}.jpg`,
    media_url: `https://cdn.example.com/${MEDIA_ID}.mp4`,
    permalink: POST_URL,
    timestamp: '2026-11-14T13:00:00Z',
    caption: 'Clone any tool Comment "Guide" for the link',
    like_count: 42,
    comments_count: 7,
    ...overrides,
  };
}

function postRequest(url: string): Request {
  return new Request(`http://localhost/api/instagram/posts/${ACCOUNT_ID}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

const context = { params: Promise.resolve({ accountId: ACCOUNT_ID }) };

describe('POST /api/instagram/posts/[accountId]/resolve', () => {
  beforeEach(() => {
    mockSingle.mockResolvedValue({ data: IG_ACCOUNT, error: null });
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a pasted link via oEmbed and returns the list-route post shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ media_id: MEDIA_ID }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => metaMedia(),
    });

    const res = await POST(postRequest(POST_URL), context);
    const body = (await res.json()) as { post: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.post).toEqual({
      id: MEDIA_ID,
      type: 'reel',
      thumbnail_url: `https://cdn.example.com/${MEDIA_ID}.jpg`,
      media_url: `https://cdn.example.com/${MEDIA_ID}.mp4`,
      permalink: POST_URL,
      timestamp: '2026-11-14T13:00:00Z',
      caption: 'Clone any tool Comment "Guide" for the link',
      like_count: 42,
      comments_count: 7,
    });

    // First call is oEmbed (facebook graph, same API version as the
    // codebase) with the canonical post URL; second is media-by-id.
    const callUrl = (n: number): string => String(mockFetch.mock.calls[n]?.[0]);
    const oembedUrl = callUrl(0);
    expect(oembedUrl).toContain('graph.facebook.com/v23.0/instagram_oembed');
    expect(oembedUrl).toContain(`url=${encodeURIComponent(POST_URL)}`);
    const mediaUrl = callUrl(1);
    expect(mediaUrl).toContain(`graph.instagram.com/v23.0/${MEDIA_ID}`);
    expect(mediaUrl).toContain('fields=id,media_type,thumbnail_url');
  });

  it('falls back to shortcode decoding when oEmbed rejects the call', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => metaMedia({ id: decodeInstagramShortcode(SHORTCODE) }),
    });

    const res = await POST(postRequest(POST_URL), context);
    const body = (await res.json()) as { post: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.post.id).toBe(decodeInstagramShortcode(SHORTCODE));
    const mediaUrl = String(mockFetch.mock.calls[1]?.[0]);
    expect(mediaUrl).toContain(`graph.instagram.com/v23.0/${decodeInstagramShortcode(SHORTCODE)}`);
  });

  it('rejects a non-Instagram URL with 400 and never calls Meta', async () => {
    const res = await POST(postRequest('https://www.youtube.com/watch?v=abc'), context);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Instagram post ka link/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a missing/empty URL with 400', async () => {
    const res = await POST(postRequest('   '), context);
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 502 when the media itself cannot be fetched', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ media_id: MEDIA_ID }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => '{"error":{"message":"not found"}}',
    });

    const res = await POST(postRequest(POST_URL), context);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(502);
    expect(body.error).toMatch(/load nahi kar paye/);
  });

  it('returns 404 when the Instagram account is not found', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const res = await POST(postRequest(POST_URL), context);
    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
