/**
 * Fresh Facebook Page profile pictures, resolved at render time
 * (UI polish, 2026-11-25).
 *
 * Facebook mirror of lib/instagram/profilePicture: the stored
 * `profile_picture_url` on facebook_pages is a Meta CDN link whose
 * signature expires, so older Pages fall back to the glyph tile
 * while newer ones still show a photo. The client resolves a fresh
 * URL per Page through a batch endpoint at render time (React
 * Query, 10-minute staleTime) and falls back to the stored URL,
 * then to the glyph tile. Deliberately NO database write.
 *
 * Kept in a plain .ts module (no JSX, no server deps) so the
 * node-environment Vitest suite can import it. The fetcher is
 * injected so tests can stub Meta without network.
 */

import type { ProfilePictureFetcher } from '@/lib/instagram/profilePicture';

/**
 * Resolve one fresh profile picture URL for a Facebook Page.
 *
 * `/{page-id}?fields=picture.type(large){url}` with the Page token
 * returns `{ picture: { data: { url } } }`. Returns null when Meta
 * cannot serve one — the caller falls back to the stored URL, then
 * to the glyph tile.
 */
export async function resolveFacebookPagePicture(
  fetcher: ProfilePictureFetcher,
  graphBase: string,
  pageAccessToken: string,
  pageId: string,
): Promise<string | null> {
  const trimmed = pageId.trim();
  if (!trimmed) return null;
  let res: Awaited<ReturnType<ProfilePictureFetcher>>;
  try {
    res = await fetcher(
      `${graphBase}/${encodeURIComponent(trimmed)}?fields=picture.type(large){url}&access_token=${encodeURIComponent(pageAccessToken)}`,
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  const url = (parsed as { picture?: { data?: { url?: unknown } } } | null)?.picture?.data?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}
