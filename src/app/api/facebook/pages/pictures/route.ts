/**
 * GET /api/facebook/pages/pictures?ids=<csv> — fresh profile picture
 * URLs for the given connected Facebook Pages.
 *
 * Facebook mirror of the Instagram accounts pictures route (UI
 * polish, 2026-11-25): the stored `profile_picture_url` on
 * facebook_pages is a snapshot written once at connect time and
 * never refreshed, and Facebook CDN picture URLs expire too — so
 * older Pages fall back to the glyph tile while newer ones still
 * show a photo. The switcher calls this endpoint at render time
 * and uses the fresh URL (falling back to the stored URL, then to
 * the glyph tile). No database write.
 *
 * Page lookup reuses getFacebookPageForRequest (both legacy and
 * workspace mode, 'read' gate); the picture itself is fetched with
 * the new resolveFacebookPagePicture helper, which returns null on
 * any failure instead of throwing.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { FB_GRAPH_BASE } from '@/lib/facebook/api';
import { getFacebookPageForRequest } from '@/lib/facebook/routeHelpers';
import { resolveFacebookPagePicture } from '@/lib/facebook/pagePicture';
import { parseProfilePictureIds } from '@/lib/instagram/profilePicture';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:facebook-pages:pictures');

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const ids = parseProfilePictureIds(new URL(request.url).searchParams.get('ids'));
  if (ids.length === 0) return Response.json({ pictures: {} });

  const db = createServiceClient();
  const entries = await Promise.all(
    ids.map(async (id) => {
      const lookup = await getFacebookPageForRequest(db, user, request, id, 'read', true);
      if (!lookup.ok) return [id, null] as const;
      const page = lookup.page;
      let accessToken: string;
      try {
        accessToken = decrypt(page.access_token_encrypted, getEnv().TOKEN_ENCRYPTION_KEY);
      } catch {
        logger.error({ pageId: id }, 'Failed to decrypt token - Page needs reconnection');
        return [id, null] as const;
      }
      const url = await resolveFacebookPagePicture(
        fetch,
        FB_GRAPH_BASE,
        accessToken,
        page.facebook_page_id as string,
      );
      return [id, url] as const;
    }),
  );
  return Response.json({ pictures: Object.fromEntries(entries) });
}
