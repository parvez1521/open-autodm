/**
 * Area — Creator Studio Openverse audio client, quota guard + route
 * (Programme S3).
 *
 * Pins the binding licence discipline: the search URL always locks
 * license_type=commercial and callers cannot widen it; NC items are
 * excluded twice (query lock + post-filter); durations convert from
 * milliseconds; the app-global daily cap flips at its cap and resets
 * on the next UTC day; the route surfaces an upstream 429 as the
 * shared-quota message.
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

import {
  buildOpenverseSearchUrl,
  createOpenverseClient,
  isCommerciallyUsableLicense,
  licenseLabel,
} from '@/lib/studio/openverse';
import { createPerInstanceDailyCap } from '@/lib/studio/openverseQuota';
import { GET } from '@/app/api/studio/openverse/route';

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const AUDIO_BODY = {
  result_count: 2,
  page_count: 1,
  results: [
    {
      id: 'ov-1',
      title: 'Rain loop',
      creator: 'Alice Sounds',
      creator_url: 'https://example.test/alice',
      foreign_landing_url: 'https://example.test/tracks/rain-loop',
      detail_url: 'https://api.openverse.org/v1/audio/ov-1/',
      url: 'https://cdn.example.test/rain.mp3',
      license: 'by',
      license_version: '4.0',
      license_url: 'https://creativecommons.org/licenses/by/4.0/',
      duration: 65400,
      thumbnail: 'https://example.test/thumbs/rain.jpg',
    },
    {
      id: 'ov-2',
      title: 'NC jingle',
      creator: 'Bob Beats',
      creator_url: 'https://example.test/bob',
      foreign_landing_url: 'https://example.test/tracks/nc-jingle',
      detail_url: 'https://api.openverse.org/v1/audio/ov-2/',
      url: 'https://cdn.example.test/jingle.mp3',
      license: 'by-nc',
      license_version: '4.0',
      license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
      duration: 30000,
    },
  ],
};

describe('buildOpenverseSearchUrl', () => {
  it('always locks license_type=commercial with the dead-link filter off', () => {
    const url = buildOpenverseSearchUrl({ query: 'lofi beat', page: 2, pageSize: 10 });
    expect(url).toContain('https://api.openverse.org/v1/audio/?');
    expect(url).toContain('q=lofi+beat');
    expect(url).toContain('license_type=commercial');
    expect(url).toContain('filter_dead=false');
    expect(url).toContain('page=2');
    expect(url).toContain('page_size=10');
  });

  it('cannot be widened by a caller — an extra licence property is ignored', () => {
    const sneaky = { query: 'jazz', license_type: 'all', license: 'by-nc' } as unknown as {
      query: string;
      page?: number;
      pageSize?: number;
    };
    const url = buildOpenverseSearchUrl(sneaky);
    expect(url).toContain('license_type=commercial');
    expect(url).not.toContain('license_type=all');
    expect(url).not.toContain('by-nc');
  });

  it('defaults page_size to 20 and clamps it to 1..50', () => {
    expect(buildOpenverseSearchUrl({ query: 'x' })).toContain('page_size=20');
    expect(buildOpenverseSearchUrl({ query: 'x', pageSize: 500 })).toContain('page_size=50');
    expect(buildOpenverseSearchUrl({ query: 'x', pageSize: 0 })).toContain('page_size=1');
  });
});

describe('licenseLabel', () => {
  it('maps the known licences to their display labels', () => {
    expect(licenseLabel('by', '4.0')).toBe('CC BY 4.0');
    expect(licenseLabel('by')).toBe('CC BY');
    expect(licenseLabel('by-sa', '3.0')).toBe('CC BY-SA 3.0');
    expect(licenseLabel('cc0')).toBe('CC0 1.0');
    expect(licenseLabel('pdm')).toBe('Public Domain Mark');
    expect(licenseLabel('sampling+')).toBe('Sampling Plus');
  });

  it('upper-cases unknown licences verbatim', () => {
    expect(licenseLabel('by-nd', '4.0')).toBe('BY-ND');
  });
});

describe('isCommerciallyUsableLicense', () => {
  it('excludes every NC variant and the empty licence', () => {
    expect(isCommerciallyUsableLicense('by-nc')).toBe(false);
    expect(isCommerciallyUsableLicense('by-nc-sa')).toBe(false);
    expect(isCommerciallyUsableLicense('by-nc-nd')).toBe(false);
    expect(isCommerciallyUsableLicense('BY-NC')).toBe(false);
    expect(isCommerciallyUsableLicense('')).toBe(false);
    expect(isCommerciallyUsableLicense('   ')).toBe(false);
  });

  it('allows commercial licences', () => {
    expect(isCommerciallyUsableLicense('by')).toBe(true);
    expect(isCommerciallyUsableLicense('by-sa')).toBe(true);
    expect(isCommerciallyUsableLicense('cc0')).toBe(true);
    expect(isCommerciallyUsableLicense('pdm')).toBe(true);
  });
});

describe('createOpenverseClient', () => {
  it('maps fields, rounds ms durations to seconds, and EXCLUDES the NC item', async () => {
    const seen: { url?: string; hasAuth?: boolean } = {};
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.hasAuth = 'Authorization' in ((init.headers as Record<string, string>) ?? {});
      return jsonRes(AUDIO_BODY);
    });
    const client = createOpenverseClient({ fetchFn });
    const result = await client.searchAudio({ query: 'rain' });

    expect(seen.url).toContain('license_type=commercial');
    expect(seen.hasAuth).toBe(false); // keyless — no auth header is sent

    // The by-nc item is dropped by the post-filter even though the
    // fixture's result_count still counts it upstream.
    expect(result.items).toHaveLength(1);
    expect(result.items.map((i) => i.id)).toEqual(['ov-1']);
    expect(result.items[0]).toEqual({
      id: 'ov-1',
      title: 'Rain loop',
      creator: 'Alice Sounds',
      creatorUrl: 'https://example.test/alice',
      pageUrl: 'https://example.test/tracks/rain-loop',
      assetUrl: 'https://cdn.example.test/rain.mp3',
      licenseName: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      durationSec: 65, // 65,400 ms rounded to seconds
      thumbnailUrl: 'https://example.test/thumbs/rain.jpg',
    });
    expect(result.resultCount).toBe(2);
    expect(result.pageCount).toBe(1);
  });

  it('maps 429 to quota and a malformed body to bad_response', async () => {
    const limited = createOpenverseClient({
      fetchFn: vi.fn(async () => new Response('{}', { status: 429 })),
    });
    await expect(limited.searchAudio({ query: 'x' })).rejects.toMatchObject({
      name: 'OpenverseError',
      code: 'quota',
    });
    const broken = createOpenverseClient({
      fetchFn: vi.fn(async () => jsonRes({ nope: true })),
    });
    await expect(broken.searchAudio({ query: 'x' })).rejects.toMatchObject({ code: 'bad_response' });
  });
});

// Programme 34 (2026-11-07, Iteration-10 terminology correction): the
// helper was renamed createDailyGlobalCap → createPerInstanceDailyCap
// — the counter is in-memory state in ONE server process, and the old
// "global" name invited reading it as deployment-wide enforcement.
// Behaviour is unchanged; only the name and comments moved.
describe('createPerInstanceDailyCap', () => {
  it('flips at the cap and resets on the next UTC day', () => {
    let t = Date.UTC(2026, 10, 7, 23, 59, 0);
    const cap = createPerInstanceDailyCap({ cap: 2, now: () => t });
    expect(cap.check()).toBe(true);
    cap.record();
    expect(cap.check()).toBe(true);
    cap.record();
    expect(cap.check()).toBe(false);
    cap.record();
    expect(cap.check()).toBe(false);
    // Next UTC day: the counter resets.
    t = Date.UTC(2026, 10, 8, 0, 0, 1);
    expect(cap.check()).toBe(true);
  });
});

// ── Route ──────────────────────────────────────────────────────────

let userSeq = 0;

function authedUser() {
  userSeq += 1;
  return { id: `openverse-user-${userSeq}`, email: `o${userSeq}@example.test` };
}

function getReq(qs: string) {
  return new Request(`http://localhost/api/studio/openverse?${qs}`);
}

beforeEach(() => {
  mockGetAuthenticatedUser.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/studio/openverse', () => {
  it('succeeds with a mocked fetch and needs no API key', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(AUDIO_BODY)));
    const res = await GET(getReq('q=rain'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      provider: string;
      providerUrl: string;
      resultCount: number;
      items: { id: string; licenseName: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('openverse');
    expect(body.providerUrl).toBe('https://openverse.org');
    // NC item excluded by the client post-filter.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.licenseName).toBe('CC BY 4.0');
  });

  it('maps an upstream 429 to quota_reached with the shared-quota message', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    const res = await GET(getReq('q=jazz'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('quota_reached');
    // P32 dated note (2026-11-07): the message copy changed under the
    // §4 quota-precision sweep — the old wording claimed the allowance
    // was enforced "across the whole app", which the per-instance
    // in-memory cap does not do. The provider fact (≈200/day shared
    // pool) is retained; the enforcement claim is gone.
    expect(body.message).toContain('free stock-audio quota is used up');
    expect(body.message).toContain('about 200 requests a day');
    expect(body.message).not.toContain('across the whole app');
  });
});
