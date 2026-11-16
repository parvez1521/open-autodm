/**
 * Media-ID paste in the post picker (2026-11-17) — POST
 * /api/instagram/posts/:accountId/resolve accepts a pure-numeric
 * Instagram media ID, and src/lib/instagram/postUrl.ts detects it.
 *
 * This is the proper fix for collab reels whose media the token cannot
 * read (e.g. the Nov 14 "Clone any tool" reel, owned by tech_hacks.ai):
 * creating by media ID is the established workaround, and the engine
 * only ever matches on the ID.
 *
 * Covers:
 *  (a) isMediaIdInput: digits only, 8+ digits; URLs, short numbers and
 *      alphanumeric strings are rejected;
 *  (b) a pasted media ID whose Graph API fetch SUCCEEDS returns the real post;
 *  (c) a pasted media ID whose Graph API fetch FAILS (the collab case)
 *      still returns a 200 with an ID-only post instead of an error —
 *      the automation can be created from the ID alone;
 *  (d) a short numeric string and a non-Instagram string are rejected
 *      with a 400 (no Meta call is made);
 *  (e) a pasted URL still resolves through the unchanged URL path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isMediaIdInput, decodeInstagramShortcode } from '@/lib/instagram/postUrl';

const USER = { id: 'media-id-test-user' };
const ACCOUNT_ID = 'media-id-test-account';

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

const MEDIA_ID = '4030232656907660594'; // the Clone reel's media ID
const SHORTCODE = 'DfuQz-VKO0y';
const POST_URL = `https://www.instagram.com/p/${SHORTCODE}/`;

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

function postRequest(input: string): Request {
  return new Request(`http://localhost/api/instagram/posts/${ACCOUNT_ID}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: input }),
  });
}

const context = { params: Promise.resolve({ accountId: ACCOUNT_ID }) };

describe('isMediaIdInput', () => {
  it('accepts a real numeric media ID, with surrounding whitespace', () => {
    expect(isMediaIdInput(MEDIA_ID)).toBe(true);
    expect(isMediaIdInput(`  ${MEDIA_ID}  `)).toBe(true);
  });

  it('rejects URLs, short numbers and alphanumeric strings', () => {
    expect(isMediaIdInput(POST_URL)).toBe(false);
    expect(isMediaIdInput('123')).toBe(false);
    expect(isMediaIdInput('4030232656907660594x')).toBe(false);
    expect(isMediaIdInput('')).toBe(false);
    expect(isMediaIdInput('instagram.com')).toBe(false);
  });

  it('the Clone reel shortcode round-trips to its media ID', () => {
    expect(decodeInstagramShortcode(SHORTCODE)).toBe(MEDIA_ID);
  });
});

describe('POST resolve with a media ID', () => {
  beforeEach(() => {
    mockSingle.mockResolvedValue({ data: IG_ACCOUNT, error: null });
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the real post when the Graph API can read the media ID', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => metaMedia(),
    });

    const res = await POST(postRequest(MEDIA_ID), context);
    const body = (await res.json()) as { post: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.post.id).toBe(MEDIA_ID);
    expect(body.post.type).toBe('reel');
    expect(body.post.caption).toBe('Clone any tool Comment "Guide" for the link');
    // One Meta call only: no oEmbed for a media ID.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain(`/${MEDIA_ID}?fields=`);
  });

  it('returns an ID-only post (200) when the Graph API cannot read the media ID — the collab case', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Unsupported get request',
    });

    const res = await POST(postRequest(MEDIA_ID), context);
    const body = (await res.json()) as { post: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.post.id).toBe(MEDIA_ID);
    expect(body.post.type).toBe('reel');
    expect(body.post.thumbnail_url).toBeNull();
    expect(body.post.caption).toBe('');
    expect(body.post.permalink).toBe(POST_URL);
  });

  it('rejects a short numeric string with a 400 and makes no Meta call', async () => {
    const res = await POST(postRequest('123'), context);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/media ID|post link/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-Instagram string with a 400 and makes no Meta call', async () => {
    const res = await POST(postRequest('hello world'), context);
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a pasted URL still resolves through the unchanged URL path', async () => {
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
    expect(body.post.id).toBe(MEDIA_ID);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
