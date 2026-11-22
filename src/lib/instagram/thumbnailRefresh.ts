/**
 * Fresh post thumbnails, resolved at render time (2026-11-22).
 *
 * Root cause of the broken thumbnails: `automations.post_thumbnail_url`
 * is a snapshot written ONCE at creation ("UI snapshot, best-effort" in
 * the core schema) and never refreshed. Instagram CDN URLs
 * (scontent.cdninstagram.com) and Facebook `full_picture` CDN URLs
 * carry expiring signatures that go stale within days — so every
 * automation older than a few days shows a broken-image icon in the
 * list and in the editor. The posts API itself always fetches fresh
 * URLs from Meta, but the list/editor never re-fetch.
 *
 * Collab hard limit (2026-11-22): the connected account's token cannot
 * read a tech_hacks.ai-owned collab post by list OR by media ID (the
 * Item 6 root cause), so `/{media-id}` fails for exactly those posts
 * (Clone, AI Slop, Higgsfield, Don't mae). The first version of this
 * module fell back to oEmbed for those — but Meta removed
 * `thumbnail_url` (and `thumbnail_width`, `thumbnail_height`,
 * `author_name`) from Instagram oEmbed responses on 2025-11-03, so
 * oEmbed can NEVER return a thumbnail any more, for any post. The
 * oEmbed path was therefore removed: it only ever returned null and
 * wasted a Meta call. There is no Meta API available to this app that
 * can return a fresh thumbnail for a collab post owned by another
 * account — the only route to a real thumbnail there is connecting the
 * owning account (tech_hacks.ai) so its own token can read the media.
 * Until then the caller renders the clean placeholder for those rows.
 *
 * Deliberately NO database write here: `automations` has an
 * `updated_at` trigger, so refreshing the stored snapshot in place
 * would silently rewrite every automation's displayed date. The fresh
 * URL lives only in memory (React Query, 10-minute staleTime).
 *
 * Kept in a plain .ts module (no JSX, no server deps) so the
 * node-environment Vitest suite can import it. The fetcher is
 * injected so tests can stub Meta without network.
 */

/** Minimal fetch shape — the global `fetch` satisfies this structurally. */
export type ThumbnailFetcher = (url: string) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

const MEDIA_FIELDS = 'id,media_type,thumbnail_url,media_url';

/**
 * Media IDs are stored plain numeric, but tolerate a trailing
 * `_{userId}` suffix if one ever shows up.
 */
export function normalizeInstagramMediaId(postId: string): string {
  const trimmed = postId.trim();
  const m = /^(\d+)_\d+$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

/**
 * Parse the `?ids=` query param: comma-separated, trimmed, deduped,
 * capped (default 20 — the list never shows more distinct posts).
 */
export function parseThumbnailIds(raw: string | null | undefined, max = 20): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * Resolve one fresh thumbnail URL for an Instagram media ID.
 *
 * Single path — `/{media-id}` with the account token returns a fresh
 * `thumbnail_url` (or `media_url` for images). Returns null when the
 * token cannot read the post: collab posts owned by another account
 * (the Item 6 root cause) are unreadable by ID, and there is no
 * fallback — oEmbed no longer returns `thumbnail_url` (Meta removed
 * the field on 2025-11-03), so a former oEmbed fallback could only
 * ever return null. The caller renders the clean placeholder for
 * those rows instead of a broken image.
 */
export async function resolveInstagramThumbnail(
  fetcher: ThumbnailFetcher,
  graphBase: string,
  accessToken: string,
  postId: string,
): Promise<string | null> {
  const mediaId = normalizeInstagramMediaId(postId);
  if (!/^\d+$/.test(mediaId)) return null;

  try {
    const res = await fetcher(
      `${graphBase}/${mediaId}?fields=${MEDIA_FIELDS}&access_token=${accessToken}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { thumbnail_url?: string; media_url?: string };
      const url = data.thumbnail_url ?? data.media_url ?? null;
      if (url) return url;
    }
  } catch {
    // Fall through to null — the caller renders the placeholder.
  }
  return null;
}
