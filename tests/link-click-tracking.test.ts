/**
 * Link click tracking (2026-11-17) — src/lib/automation/linkTracking.ts
 * with a FakeSupabase-backed service client.
 *
 * Covers:
 *  (a) trackLink creates one tracked_links row per (automation, URL)
 *      and returns the same short URL on repeat calls;
 *  (b) non-http(s) and empty destinations pass through untracked;
 *  (c) an already-short /r/ URL is never nested inside another tracked link;
 *  (d) rewriteResponseLinks rewrites buttonLink and card button links,
 *      leaving link-less responses untouched;
 *  (e) recordLinkClick logs the click, bumps click_count, and returns
 *      the destination — unknown codes return null;
 *  (f) getLinkClickCounts sums click_count per automation, and returns
 *      an empty map (never throws) when the table is missing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import {
  generateShortCode,
  isTrackableUrl,
  trackLink,
  rewriteResponseLinks,
  recordLinkClick,
  getLinkClickCounts,
} from '@/lib/automation/linkTracking';
import type { DMResponse } from '@/lib/types';
import { GET } from '@/app/r/[code]/route';

void (fake as unknown as SupabaseClient);

const DB = fake as unknown as SupabaseClient;
const APP_URL = 'https://opendm.in';
const AUTO_ID = 'auto-1';
const ACCT_ID = 'acct-1';

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('tracked_links', []);
  fake.replaceRows('link_clicks', []);
  // The migration's atomic counter RPC: emulate it against the fake rows.
  fake.setRpcHandler('increment_tracked_link_clicks', async (params) => {
    const row = fake.rows('tracked_links').find((r) => r['id'] === params['p_tracked_link_id']);
    if (row) row['click_count'] = ((row['click_count'] as number) ?? 0) + 1;
    return { data: null, error: null };
  });
});

async function track(destination: string): Promise<string> {
  return trackLink(DB, {
    automationId: AUTO_ID,
    instagramAccountId: ACCT_ID,
    destinationUrl: destination,
    appUrl: APP_URL,
  });
}

describe('generateShortCode / isTrackableUrl', () => {
  it('generates distinct 7-char base62 codes', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateShortCode()));
    expect(codes.size).toBe(20);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9]{7}$/);
  });

  it('only http(s) destinations are trackable', () => {
    expect(isTrackableUrl('https://example.com/guide')).toBe(true);
    expect(isTrackableUrl('http://example.com')).toBe(true);
    expect(isTrackableUrl('ftp://example.com')).toBe(false);
    expect(isTrackableUrl('mailto:a@b.com')).toBe(false);
    expect(isTrackableUrl('')).toBe(false);
    expect(isTrackableUrl(undefined)).toBe(false);
    expect(isTrackableUrl('not a url')).toBe(false);
  });
});

describe('trackLink', () => {
  it('creates one row per (automation, URL) and returns a stable short URL', async () => {
    const first = await track('https://example.com/guide');
    const second = await track('https://example.com/guide');
    expect(first).toBe(second);
    expect(first).toMatch(/^https:\/\/opendm\.in\/r\/[A-Za-z0-9]{7}$/);
    expect(fake.rows('tracked_links')).toHaveLength(1);
    expect(fake.rows('tracked_links')[0]).toMatchObject({
      automation_id: AUTO_ID,
      destination_url: 'https://example.com/guide',
      click_count: 0,
    });
  });

  it('different destinations get different codes', async () => {
    const a = await track('https://example.com/a');
    const b = await track('https://example.com/b');
    expect(a).not.toBe(b);
    expect(fake.rows('tracked_links')).toHaveLength(2);
  });

  it('non-trackable destinations pass through unchanged and create no row', async () => {
    expect(await track('not a url')).toBe('not a url');
    expect(await track('')).toBe('');
    expect(fake.rows('tracked_links')).toHaveLength(0);
  });

  it('an already-short /r/ URL is never nested', async () => {
    const short = await track('https://example.com/guide');
    expect(await track(short)).toBe(short);
    expect(fake.rows('tracked_links')).toHaveLength(1);
  });
});

describe('rewriteResponseLinks', () => {
  it('rewrites buttonLink and card button links, leaves link-less responses alone', async () => {
    const responses: DMResponse[] = [
      { id: 'r1', type: 'text', content: 'Here it is', buttonTitle: 'Open', buttonLink: 'https://example.com/guide' },
      { id: 'r2', type: 'text', content: 'Just text' },
      {
        id: 'r3', type: 'card', content: 'Card', cardTitle: 'Guide',
        cardButtons: [{ id: 'b1', title: 'Get it', link: 'https://example.com/card' }],
      },
    ];
    const rewritten = await rewriteResponseLinks(DB, {
      automationId: AUTO_ID,
      instagramAccountId: ACCT_ID,
      responses,
      appUrl: APP_URL,
    });
    expect(rewritten[0]!.buttonLink).toMatch(/^https:\/\/opendm\.in\/r\//);
    expect(rewritten[1]!.buttonLink).toBeUndefined();
    expect(rewritten[2]!.cardButtons![0]!.link).toMatch(/^https:\/\/opendm\.in\/r\//);
    expect(fake.rows('tracked_links')).toHaveLength(2);
  });
});

describe('recordLinkClick / getLinkClickCounts', () => {
  it('records the click, bumps the count, and returns the destination', async () => {
    const short = await track('https://example.com/guide');
    const code = short.split('/r/')[1]!;
    const destination = await recordLinkClick(DB, code, 'test-agent');
    expect(destination).toBe('https://example.com/guide');
    expect(fake.rows('link_clicks')).toHaveLength(1);
    expect(fake.rows('tracked_links')[0]!['click_count']).toBe(1);

    await recordLinkClick(DB, code, 'test-agent');
    expect(fake.rows('link_clicks')).toHaveLength(2);
    expect(fake.rows('tracked_links')[0]!['click_count']).toBe(2);
  });

  it('an unknown code returns null and logs nothing', async () => {
    expect(await recordLinkClick(DB, 'NOPE123', null)).toBeNull();
    expect(fake.rows('link_clicks')).toHaveLength(0);
  });

  it('counts sum per automation across its links', async () => {
    const a = await track('https://example.com/a');
    const b = await track('https://example.com/b');
    await recordLinkClick(DB, a.split('/r/')[1]!, null);
    await recordLinkClick(DB, a.split('/r/')[1]!, null);
    await recordLinkClick(DB, b.split('/r/')[1]!, null);
    const counts = await getLinkClickCounts(DB, [AUTO_ID, 'auto-other']);
    expect(counts.get(AUTO_ID)).toBe(3);
    expect(counts.get('auto-other')).toBeUndefined();
  });
});

describe('GET /r/[code] redirect route', () => {
  it('redirects to the destination and records the click', async () => {
    const short = await track('https://example.com/guide');
    const code = short.split('/r/')[1]!;
    const res = await GET(new Request(`http://localhost/r/${code}`), {
      params: Promise.resolve({ code }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/guide');
    expect(fake.rows('link_clicks')).toHaveLength(1);
    expect(fake.rows('tracked_links')[0]!['click_count']).toBe(1);
  });

  it('returns 404 for an unknown code', async () => {
    const res = await GET(new Request('http://localhost/r/NOPE123'), {
      params: Promise.resolve({ code: 'NOPE123' }),
    });
    expect(res.status).toBe(404);
    expect(fake.rows('link_clicks')).toHaveLength(0);
  });
});
