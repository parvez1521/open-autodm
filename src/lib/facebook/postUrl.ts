/**
 * Facebook post URL / ID resolution — offline, no Meta calls.
 *
 * Facebook post ids are COMPOSITE: "{pageId}_{storyId}". Feed webhooks
 * report post_id in exactly that format, so the picker and the engine
 * must agree on it. Inputs the owner may paste:
 *
 *  - https://www.facebook.com/<page>/posts/<storyId>
 *  - https://www.facebook.com/permalink.php?story_fbid=<storyId>&id=<pageId>
 *  - https://www.facebook.com/<pageId>/posts/<storyId>
 *  - a raw composite id "<pageId>_<storyId>" (used as-is)
 *  - a bare numeric story id (prefixed with the Page id)
 *
 * A bare video/reel id (facebook.com/reel/<id>, /watch/?v=<id>) cannot
 * be mapped to a post id offline — the resolve route tries it as a
 * Graph object id instead, and falls back to an ID-only post when Meta
 * cannot read it (same fail-open as the Instagram resolver).
 */

/** Extracts a composite "{pageId}_{storyId}" post id from a URL or raw id, or null. */
export function extractFacebookPostId(input: string, pageId: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already composite: "{pageId}_{storyId}"
  if (/^\d+_\d+$/.test(trimmed)) return trimmed;

  // Bare numeric story id → prefix with the Page id.
  if (/^\d+$/.test(trimmed)) return `${pageId}_${trimmed}`;

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('facebook.com') && !host.endsWith('fb.com') && !host.endsWith('fb.watch')) return null;

  // permalink.php?story_fbid=<storyId>&id=<pageId>
  if (url.pathname.toLowerCase().includes('permalink.php')) {
    const storyId = url.searchParams.get('story_fbid');
    const ownerPageId = url.searchParams.get('id');
    if (storyId && /^\d+$/.test(storyId)) {
      return `${ownerPageId && /^\d+$/.test(ownerPageId) ? ownerPageId : pageId}_${storyId}`;
    }
    return null;
  }

  // /<page>/posts/<storyId> — the story id is the last numeric path segment.
  const segments = url.pathname.split('/').filter(Boolean);
  const postsIdx = segments.findIndex((s) => s.toLowerCase() === 'posts');
  if (postsIdx >= 0 && segments[postsIdx + 1] && /^\d+$/.test(segments[postsIdx + 1]!)) {
    return `${pageId}_${segments[postsIdx + 1]!}`;
  }

  // /watch/?v=<videoId> or /reel/<id>: no offline post-id mapping.
  return null;
}

export function isFacebookPostUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/^\d+(_\d+)?$/.test(trimmed)) return true;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    return (
      (host.endsWith('facebook.com') || host.endsWith('fb.com')) &&
      (url.pathname.toLowerCase().includes('/posts/') || url.pathname.toLowerCase().includes('permalink.php'))
    );
  } catch {
    return false;
  }
}
