/**
 * GET /api/facebook/posts/:pageId/thumbnails?ids=<csv> — fresh
 * `full_picture` URLs for the given Page post IDs.
 *
 * Facebook mirror of the Instagram thumbnails route (2026-11-22):
 * `automations.post_thumbnail_url` is a snapshot written once at
 * creation and never refreshed, and Facebook CDN picture URLs expire
 * too — so FB automations showed the same broken-image icons. The
 * list/editor call this endpoint at render time and use the fresh URL
 * (falling back to the stored snapshot, then to a clean placeholder).
 * No database write: `automations` has an `updated_at` trigger, so
 * refreshing the stored snapshot in place would silently rewrite
 * every automation's displayed date.
 *
 * Page lookup reuses getFacebookPageForRequest (both legacy and
 * workspace mode, 'read' gate); a single post is fetched with the
 * existing getFacebookPost helper, which returns null on any failure
 * instead of throwing.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { getFacebookPost } from '@/lib/facebook/api';
import { getFacebookPageForRequest } from '@/lib/facebook/routeHelpers';
import { parseThumbnailIds } from '@/lib/instagram/thumbnailRefresh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:facebook-posts:thumbnails');

type RouteContext = { params: Promise<{ pageId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const { pageId } = await context.params;
  const ids = parseThumbnailIds(new URL(request.url).searchParams.get('ids'));
  if (ids.length === 0) return Response.json({ thumbnails: {} });

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

  const entries = await Promise.all(
    ids.map(async (id) => {
      const post = await getFacebookPost(id, accessToken);
      return [id, post?.full_picture ?? null] as const;
    }),
  );
  return Response.json({ thumbnails: Object.fromEntries(entries) });
}
