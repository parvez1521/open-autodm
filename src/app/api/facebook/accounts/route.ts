/**
 * GET /api/facebook/accounts - connected Facebook Pages with pause status.
 * The token itself is never returned. Page tokens from a long-lived user
 * token do not expire, so token_status is always 'valid' (mirrors the
 * IG accounts route shape so the Settings UI can share its rendering).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { listFacebookPagesForRequest } from '@/lib/facebook/routeHelpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:facebook-accounts');

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const db = createServiceClient();
  const result = await listFacebookPagesForRequest(db, user, request);
  if ('response' in result) {
    logger.error({ userId: user.id }, 'Failed to fetch Facebook Pages');
    return result.response;
  }

  const pages = result.rows.map((page) => {
    const pausedUntil = page.paused_until;
    const isPaused = !!pausedUntil && new Date(pausedUntil).getTime() > Date.now();
    return {
      id: page.id,
      facebook_page_id: page.facebook_page_id,
      name: page.name,
      username: page.username,
      profile_picture_url: page.profile_picture_url,
      is_active: page.is_active,
      token_expires_at: page.token_expires_at,
      paused_until: isPaused ? pausedUntil : null,
      pause_reason: isPaused ? page.pause_reason : null,
      created_at: page.created_at,
      user_id: page.user_id,
      connected_by_user_id: page.connected_by_user_id,
      workspace_id: page.workspace_id,
      // Page tokens obtained via a long-lived user token do not expire.
      token_status: 'valid',
      token_days_remaining: null,
      is_paused: isPaused,
    };
  });

  return Response.json({ pages });
}
