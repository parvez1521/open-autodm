/**
 * GET /api/facebook/posts/:pageId - the Page's post grid for the picker.
 * Cursor-paginated from the Graph API, with a short in-memory cache
 * (per warm serverless instance) so browsing the picker doesn't hammer
 * Meta. Mirrors /api/instagram/posts/:accountId.
 *
 * Post shape is the Facebook-native one (id "{pageId}_{storyId}",
 * message/story, full_picture, permalink_url) — the picker maps it to
 * its display shape client-side.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { listFacebookPosts, type FacebookPostsPage } from '@/lib/facebook/api';
import { getFacebookPageForRequest } from '@/lib/facebook/routeHelpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:facebook-posts');

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { value: FacebookPostsPage; at: number }>();

type RouteContext = { params: Promise<{ pageId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const { pageId } = await context.params;
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 50);
  const after = url.searchParams.get('after');
  // `?refresh=1` (picker Refresh button) skips the cache READ so the
  // list goes back to Meta — the fresh result is still WRITTEN to the
  // cache below, so the next plain read is served from it.
  const refresh = url.searchParams.get('refresh') === '1';

  const db = createServiceClient();
  const lookup = await getFacebookPageForRequest(db, user, request, pageId, 'read', true);
  if (!lookup.ok) return lookup.response;
  const page = lookup.page;

  const cacheKey = `${user.id}:${page.id}:${limit}:${after ?? 'first'}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json({ ...hit.value, cached: true });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(page.access_token_encrypted, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    logger.error({ pageId }, 'Failed to decrypt token - Page needs reconnection');
    return Response.json({ error: 'Failed to access Facebook Page - please reconnect' }, { status: 500 });
  }

  let pageData: FacebookPostsPage;
  try {
    pageData = await listFacebookPosts(page.facebook_page_id, accessToken, limit, after);
  } catch (err) {
    logger.error({ err, pageId }, 'Failed to fetch posts from Facebook');
    return Response.json({ error: 'Failed to fetch posts from Facebook' }, { status: 502 });
  }

  cache.set(cacheKey, { value: pageData, at: Date.now() });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return Response.json({ ...pageData, cached: false });
}
