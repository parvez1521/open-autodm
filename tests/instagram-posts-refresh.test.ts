/**
 * Area — Instagram posts route refresh (GET /api/instagram/posts/:accountId).
 *
 * Regression: the picker had no way to reload its list — the route's
 * 5-minute in-memory cache outlived even a hard refresh, so the user
 * kept seeing the same stale page. `?refresh=1` skips the cache READ
 * (the fresh result is still WRITTEN to the cache) in both the legacy
 * and the workspace-mode (P18) branches.
 *
 * This file pins the legacy branch: plain reads hit the cache, a
 * refresh read goes back to Meta, and the next plain read serves the
 * freshly cached page. Auth, DB, crypto and env are mocked following
 * tests/ai-generate-route.test.ts; the cache under test is the REAL
 * module-level Map in the route.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const USER = { id: 'refresh-test-user' };
const ACCOUNT_ID = 'refresh-test-account';

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

import { GET } from '@/app/api/instagram/posts/[accountId]/route';

function metaPage(posts: Array<{ id: string; caption: string }>) {
  return {
    data: posts.map((p) => ({
      id: p.id,
      media_type: 'IMAGE',
      media_url: `https://cdn.example.com/${p.id}.jpg`,
      permalink: `https://instagram.com/p/${p.id}`,
      timestamp: '2026-11-12T10:00:00Z',
      caption: p.caption,
      like_count: 3,
      comments_count: 1,
    })),
    paging: {},
  };
}

function getRequest(refresh: boolean): Request {
  const url = `http://localhost/api/instagram/posts/${ACCOUNT_ID}?limit=20${refresh ? '&refresh=1' : ''}`;
  return new Request(url, { method: 'GET' });
}

const context = { params: Promise.resolve({ accountId: ACCOUNT_ID }) };

describe('GET /api/instagram/posts/[accountId] ?refresh=1', () => {
  beforeEach(() => {
    mockSingle.mockResolvedValue({ data: IG_ACCOUNT, error: null });
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves the cache on plain reads, skips it on refresh, and caches the fresh page', async () => {
    // First plain read: Meta returns page A, served fresh.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => metaPage([{ id: 'post-a', caption: 'First page' }]),
    });
    const first = await GET(getRequest(false), context);
    const firstBody = (await first.json()) as { posts: Array<{ id: string }>; cached: boolean };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.posts.map((p) => p.id)).toEqual(['post-a']);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second plain read: cache hit — same page, Meta NOT called again.
    const second = await GET(getRequest(false), context);
    const secondBody = (await second.json()) as { posts: Array<{ id: string }>; cached: boolean };
    expect(secondBody.cached).toBe(true);
    expect(secondBody.posts.map((p) => p.id)).toEqual(['post-a']);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Refresh read: cache skipped — Meta called again, new page B served fresh.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => metaPage([{ id: 'post-b', caption: 'Fresh page' }]),
    });
    const refreshed = await GET(getRequest(true), context);
    const refreshedBody = (await refreshed.json()) as { posts: Array<{ id: string }>; cached: boolean };
    expect(refreshedBody.cached).toBe(false);
    expect(refreshedBody.posts.map((p) => p.id)).toEqual(['post-b']);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Next plain read: the fresh page was written into the cache.
    const fourth = await GET(getRequest(false), context);
    const fourthBody = (await fourth.json()) as { posts: Array<{ id: string }>; cached: boolean };
    expect(fourthBody.cached).toBe(true);
    expect(fourthBody.posts.map((p) => p.id)).toEqual(['post-b']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
