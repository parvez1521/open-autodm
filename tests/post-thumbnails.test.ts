/**
 * Broken post thumbnails (2026-11-22).
 *
 * Root cause, proven in code: `automations.post_thumbnail_url` is a
 * snapshot written ONCE at creation ("UI snapshot, best-effort") and
 * never refreshed, while Instagram/Facebook CDN URLs expire within
 * days — so the list and the editor showed broken-image icons for
 * every automation older than a few days. The fix resolves a fresh
 * URL at render time: `/{media-id}` for own posts, and PostThumb's
 * onError fallback covers anything still dead. No database write:
 * `automations` has an `updated_at` trigger, so refreshing the stored
 * snapshot in place would silently rewrite every automation's
 * displayed date.
 *
 * Collab hard limit (2026-11-22): the first version fell back to
 * oEmbed for collab posts the token cannot read by ID (the Item 6
 * root cause) — but Meta removed `thumbnail_url` from Instagram
 * oEmbed responses on 2025-11-03, so oEmbed can NEVER return a
 * thumbnail. The oEmbed path was removed; a collab post owned by
 * another account (e.g. the Clone reel, owned by tech_hacks.ai)
 * resolves to null and the caller renders the clean placeholder.
 * The only route to a real thumbnail there is connecting the owning
 * account so its own token can read the media.
 *
 * Avatar follow-up (2026-11-22): the DM preview's CreatorAvatar and
 * the Facebook Page avatars rendered raw <img> of the stored
 * profile_picture_url — also an expiring Meta CDN link — so a dead
 * one showed a broken-image glyph. They now fall back on error, the
 * same pattern IgAvatar already used.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  normalizeInstagramMediaId,
  parseThumbnailIds,
  resolveInstagramThumbnail,
  type ThumbnailFetcher,
} from '@/lib/instagram/thumbnailRefresh';
import { groupThumbnailRequests } from '@/lib/automation/thumbnailRequests';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const GRAPH = 'https://graph.instagram.com/v23.0';

/** Stub fetcher: canned responses keyed by URL substring. */
function stubFetcher(
  routes: Array<{ match: string; ok: boolean; body: Record<string, unknown> }>,
  seen: string[] = [],
): ThumbnailFetcher {
  return async (url: string) => {
    seen.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return { ok: false, json: async () => ({}) };
    return { ok: route.ok, json: async () => route.body };
  };
}

describe('resolveInstagramThumbnail', () => {
  it('path A: own post returns the fresh thumbnail_url', async () => {
    const url = await resolveInstagramThumbnail(
      stubFetcher([{ match: '/4030232656907660594?', ok: true, body: { thumbnail_url: 'https://cdn.example/fresh.jpg' } }]),
      GRAPH,
      'TOKEN',
      '4030232656907660594',
    );
    expect(url).toBe('https://cdn.example/fresh.jpg');
  });

  it('path A: falls back to media_url when there is no thumbnail_url (image post)', async () => {
    const url = await resolveInstagramThumbnail(
      stubFetcher([{ match: '/1234567890123456789?', ok: true, body: { media_url: 'https://cdn.example/img.jpg' } }]),
      GRAPH,
      'TOKEN',
      '1234567890123456789',
    );
    expect(url).toBe('https://cdn.example/img.jpg');
  });

  it('collab post the token cannot read returns null WITHOUT calling oEmbed — Meta removed thumbnail_url from oEmbed responses on 2025-11-03', async () => {
    // Clone reel: media 4030232656907660594 ↔ shortcode DfuQz-VKO0y.
    // The oEmbed path is dead by Meta's field removal, not by an auth
    // failure: no App Review or token change can restore it, so the
    // resolver must not waste a call on it. The caller renders the
    // clean placeholder for this row instead of a broken image.
    const seen: string[] = [];
    const url = await resolveInstagramThumbnail(
      stubFetcher([{ match: '/4030232656907660594?', ok: false, body: {} }], seen),
      GRAPH,
      'TOKEN',
      '4030232656907660594',
    );
    expect(url).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen.some((u) => u.includes('instagram_oembed'))).toBe(false);
  });

  it('returns null when the media-by-id fetch fails — the caller renders the clean placeholder', async () => {
    const url = await resolveInstagramThumbnail(
      stubFetcher([{ match: '/4030232656907660594?', ok: false, body: {} }]),
      GRAPH,
      'TOKEN',
      '4030232656907660594',
    );
    expect(url).toBeNull();
  });

  it('returns null without fetching for a non-numeric id', async () => {
    const seen: string[] = [];
    const url = await resolveInstagramThumbnail(stubFetcher([], seen), GRAPH, 'TOKEN', 'not-an-id');
    expect(url).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('strips a trailing _{userId} suffix before resolving', async () => {
    const seen: string[] = [];
    await resolveInstagramThumbnail(
      stubFetcher([{ match: '/4030232656907660594?', ok: true, body: { thumbnail_url: 'https://cdn.example/x.jpg' } }], seen),
      GRAPH,
      'TOKEN',
      '4030232656907660594_123456789',
    );
    expect(seen[0]).toContain('/4030232656907660594?');
    expect(seen[0]).not.toContain('_123456789');
  });
});

describe('parseThumbnailIds', () => {
  it('trims, dedupes and caps at 20', () => {
    expect(parseThumbnailIds('a, b ,a,,c')).toEqual(['a', 'b', 'c']);
    expect(parseThumbnailIds(null)).toEqual([]);
    expect(parseThumbnailIds('')).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `id${i}`).join(',');
    expect(parseThumbnailIds(many)).toHaveLength(20);
  });
});

describe('normalizeInstagramMediaId', () => {
  it('returns plain ids unchanged and strips a _{userId} suffix', () => {
    expect(normalizeInstagramMediaId('4030232656907660594')).toBe('4030232656907660594');
    expect(normalizeInstagramMediaId('4030232656907660594_123')).toBe('4030232656907660594');
  });
});

describe('groupThumbnailRequests', () => {
  it('groups by channel+account, dedupes post IDs, skips items without an account', () => {
    const groups = groupThumbnailRequests([
      { postId: '111', channel: 'instagram', accountId: 'acc-1' },
      { postId: '222', channel: 'instagram', accountId: 'acc-1' },
      { postId: '111', channel: 'instagram', accountId: 'acc-1' },
      { postId: '333', channel: 'instagram', accountId: 'acc-2' },
      { postId: '444', channel: 'facebook', accountId: 'page-1' },
      { postId: '555', channel: 'instagram', accountId: null },
      { postId: '', channel: 'instagram', accountId: 'acc-1' },
    ]);
    expect(groups).toEqual([
      { channel: 'instagram', accountId: 'acc-1', postIds: ['111', '222'] },
      { channel: 'instagram', accountId: 'acc-2', postIds: ['333'] },
      { channel: 'facebook', accountId: 'page-1', postIds: ['444'] },
    ]);
  });
});

describe('thumbnails routes (source pins)', () => {
  it('IG route resolves via the thumbnail helper and never writes the automations table', () => {
    const route = readSrc('app/api/instagram/posts/[accountId]/thumbnails/route.ts');
    expect(route).toContain('resolveInstagramThumbnail');
    expect(route).toContain('parseThumbnailIds');
    expect(route).toContain('{ thumbnails:');
    // No DB write: `automations` has an `updated_at` trigger, so
    // refreshing the stored snapshot in place would silently rewrite
    // every automation's displayed date. Fresh URLs live in memory.
    expect(route).not.toContain("from('automations')");
    expect(route).not.toContain('.update(');
  });

  it('FB route resolves via getFacebookPost full_picture and never writes the automations table', () => {
    const route = readSrc('app/api/facebook/posts/[pageId]/thumbnails/route.ts');
    expect(route).toContain('getFacebookPost');
    expect(route).toContain('full_picture');
    expect(route).toContain('getFacebookPageForRequest');
    expect(route).toContain('{ thumbnails:');
    expect(route).not.toContain("from('automations')");
    expect(route).not.toContain('.update(');
  });
});

describe('list + editor use the fresh thumbnail (source pins)', () => {
  it('AutomationsList resolves fresh thumbnails and renders PostThumb', () => {
    const list = readSrc('components/automations/AutomationsList.tsx');
    expect(list).toContain('usePostThumbnails');
    expect(list).toContain('freshThumbnails');
    expect(list).toContain('PostThumb');
    // Fresh first, stored snapshot second.
    expect(list).toContain('freshThumbnails[automation.post_id!] ?? automation.post_thumbnail_url');
  });

  it('PostThumb swaps to its fallback on image error and resets when src changes', () => {
    const thumb = readSrc('components/automations/PostThumb.tsx');
    expect(thumb).toContain('onError');
    expect(thumb).toContain('setFailed(true)');
    expect(thumb).toContain('useEffect');
    expect(thumb).toContain('fallback');
  });

  it('ConfigureStep takes the fresh URL as a render-only prop and uses it in the Post section + phone preview', () => {
    const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');
    expect(step).toContain('freshThumbnailUrl');
    expect(step).toContain('postThumbUrl = freshThumbnailUrl ?? data.postThumbnailUrl');
    expect(step).toContain('postThumbnailUrl={postThumbUrl}');
    expect(step).toContain('PostThumb');
  });

  it('NewAutomationModal passes the fresh URL to ConfigureStep without writing it into flowData', () => {
    const modal = readSrc('components/automations/new-flow/NewAutomationModal.tsx');
    expect(modal).toContain('usePostThumbnails');
    expect(modal).toContain('freshThumbnailUrl={freshThumbnailUrl}');
    // Writing it into flowData would mark the form dirty (isDirty
    // compares flowData to the saved snapshot) with no user change.
    expect(modal).not.toContain('postThumbnailUrl: freshThumbnailUrl');
  });

  it('the picker and the phone preview use PostThumb too', () => {
    expect(readSrc('components/automations/new-flow/steps/SelectPostStep.tsx')).toContain('PostThumb');
    expect(readSrc('components/automations/new-flow/steps/PhoneComponents.tsx')).toContain('PostThumb');
  });
});

describe('oEmbed fallback is gone + avatars fall back on error (2026-11-22)', () => {
  it('thumbnailRefresh never calls oEmbed — Meta removed thumbnail_url from oEmbed responses on 2025-11-03', () => {
    const refresh = readSrc('lib/instagram/thumbnailRefresh.ts');
    expect(refresh).not.toContain('instagram_oembed');
    expect(refresh).not.toContain('facebookBase');
    // The hard limit is documented where the next reader will find it.
    expect(refresh).toContain('2025-11-03');
    const route = readSrc('app/api/instagram/posts/[accountId]/thumbnails/route.ts');
    expect(route).not.toContain('instagram_oembed');
    expect(route).not.toContain('META_FACEBOOK_BASE');
  });

  it('CreatorAvatar falls back to the Lightning tile when the stored profile picture fails', () => {
    const phones = readSrc('components/automations/new-flow/steps/PhoneComponents.tsx');
    expect(phones).toContain('function CreatorAvatar');
    expect(phones).toContain('onError={() => setFailed(true)}');
    expect(phones).toContain('useEffect(() => {');
  });

  it('Facebook Page avatars fall back to the Facebook mark when the stored picture fails', () => {
    const switcher = readSrc('components/dashboard/AccountSwitcher.tsx');
    expect(switcher).toContain('function FacebookPageAvatar');
    expect(switcher).toContain('onError={() => setFailed(true)}');
    const settings = readSrc('app/(main)/settings/page.tsx');
    expect(settings).toContain('function FacebookPageAvatar');
    // Settings passes the fresh render-time picture (UI polish
    // 2026-11-25) into the same avatar with its onError fallback.
    expect(settings).toContain('<FacebookPageAvatar page={{ ...page, profile_picture_url: pictures[page.id] ?? page.profile_picture_url }} />');
    expect(settings).toContain('onError={() => setFailed(true)}');
  });
});
