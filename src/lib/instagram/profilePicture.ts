/**
 * Fresh Instagram profile pictures, resolved at render time
 * (UI polish, 2026-11-25).
 *
 * Root cause of the mixed avatars in the account switcher: the
 * `profile_picture_url` stored at connect time is a Meta CDN link
 * whose signature expires within days (same class as the post
 * thumbnails fixed 2026-11-22). The account connected most
 * recently (@parvez_edits.mov, Nov 24) still showed its photo,
 * while @_caption.it (Nov 15) and @beyond_the.feed (Nov 12) had
 * fallen back to bare letter tiles — one real photo next to plain
 * "C" / "B" tiles looks unfinished.
 *
 * The fix mirrors the thumbnails pattern: the client resolves a
 * fresh URL per account through a batch endpoint at render time
 * (React Query, 10-minute staleTime) and falls back to the stored
 * URL, then to the glyph tile in IgAvatar. Deliberately NO
 * database write: refreshing the stored snapshot in place would
 * churn the row for no benefit — the fresh URL lives only in
 * memory.
 *
 * Kept in a plain .ts module (no JSX, no server deps) so the
 * node-environment Vitest suite can import it. The fetcher is
 * injected so tests can stub Meta without network.
 */

/** Minimal fetch shape — the global `fetch` satisfies this structurally. */
export type ProfilePictureFetcher = (url: string) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

/**
 * Resolve one fresh profile picture URL for an Instagram account.
 *
 * `/{ig-user-id}?fields=profile_picture_url` with the account's
 * own token returns a fresh CDN URL. Returns null when Meta cannot
 * serve one (dead token, revoked access) — the caller falls back
 * to the stored URL, then to the glyph tile.
 */
export async function resolveInstagramProfilePicture(
  fetcher: ProfilePictureFetcher,
  graphBase: string,
  accessToken: string,
  igUserId: string,
): Promise<string | null> {
  const trimmed = igUserId.trim();
  if (!trimmed) return null;
  let res: Awaited<ReturnType<ProfilePictureFetcher>>;
  try {
    res = await fetcher(
      `${graphBase}/${encodeURIComponent(trimmed)}?fields=profile_picture_url&access_token=${encodeURIComponent(accessToken)}`,
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
  const url = (parsed as { profile_picture_url?: unknown } | null)?.profile_picture_url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/** Parse the `?ids=` query param: comma-separated, trimmed, deduped, capped. */
export function parseProfilePictureIds(raw: string | null | undefined, max = 20): string[] {
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
