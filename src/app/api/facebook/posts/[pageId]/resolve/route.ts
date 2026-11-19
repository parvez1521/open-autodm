/**
 * POST /api/facebook/posts/:pageId/resolve - resolve one Page post from a
 * pasted link or post ID. Mirrors /api/instagram/posts/:accountId/resolve.
 *
 * The picker's list comes from GET /{page-id}/posts, which only returns
 * posts the Page token can read. A pasted link (or a pasted composite
 * "{pageId}_{storyId}" / bare story id) goes around the list: the id is
 * extracted locally, then /{post-id} fetches the post itself.
 *
 * Post-ID fallback (mirrors the IG media-ID path): when the token cannot
 * read the post, a minimal synthetic post carrying the ID is returned
 * instead of an error — the engine only ever matches on the ID, so the
 * automation works; only the list thumbnail/caption is missing.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { getFacebookPost, type FacebookPost } from '@/lib/facebook/api';
import { extractFacebookPostId, isFacebookPostUrl } from '@/lib/facebook/postUrl';
import { getFacebookPageForRequest } from '@/lib/facebook/routeHelpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:facebook-posts:resolve');

const INVALID_URL_ERROR =
  'Could not understand this link — paste a Facebook post link (facebook.com/<page>/posts/...) or a post ID.';
const UNRESOLVABLE_ERROR =
  'Could not load this post — check the link and make sure the post is public.';

type RouteContext = { params: Promise<{ pageId: string }> };

function parseUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const url = (body as { url?: unknown }).url;
  return typeof url === 'string' && url.trim().length > 0 ? url : null;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const { pageId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: INVALID_URL_ERROR }, { status: 400 });
  }
  const url = parseUrl(body);
  if (!url) {
    return Response.json({ error: INVALID_URL_ERROR }, { status: 400 });
  }

  const db = createServiceClient();
  const lookup = await getFacebookPageForRequest(db, user, request, pageId, 'read', true);
  if (!lookup.ok) return lookup.response;
  const page = lookup.page;

  let accessToken: string;
  try {
    accessToken = decrypt(page.access_token_encrypted, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    logger.error({ pageId }, 'Failed to decrypt token - Page needs reconnection');
    return Response.json({ error: 'Failed to access Facebook Page - please reconnect' }, { status: 500 });
  }

  const postId = extractFacebookPostId(url, page.facebook_page_id);
  if (!postId) {
    return Response.json({ error: INVALID_URL_ERROR }, { status: 400 });
  }

  const post = await getFacebookPost(postId, accessToken);
  if (post) {
    return Response.json({ post });
  }

  // A pasted LINK that Meta cannot read is a hard failure (502) — the
  // link may be wrong or the post may not be public. A pasted bare ID
  // gets the lenient fallback instead: return the ID-only synthetic
  // post (engine matches on the ID; thumbnail/caption stay empty).
  if (isFacebookPostUrl(url)) {
    logger.warn({ pageId, postId }, 'Facebook post fetch failed for pasted link');
    return Response.json({ error: UNRESOLVABLE_ERROR }, { status: 502 });
  }
  logger.warn({ pageId, postId }, 'Facebook post-by-id fetch failed for pasted ID - returning ID-only post');
  const synthetic: FacebookPost = {
    id: postId,
    message: '',
    permalink_url: isFacebookPostUrl(url) ? url : '',
    created_time: new Date().toISOString(),
  };
  return Response.json({ post: synthetic });
}
