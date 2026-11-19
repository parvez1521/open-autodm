/**
 * DELETE /api/facebook/disconnect/:pageId - disconnect a connected Page.
 *
 * Preserve-on-disconnect (owner decision 2026-11-15, same contract as
 * Instagram): disconnecting must NOT delete the Page's automations.
 * The Page row is kept and soft-disconnected (is_active=false,
 * disconnected_at set) and its ACTIVE automations are auto-paused with
 * paused_by_disconnect=true. Reconnecting the SAME Page (matched by
 * facebook_page_id) reactivates exactly those automations (see the
 * OAuth callback). The old behaviour would have deleted the row and
 * the FK ON DELETE CASCADE would have wiped automations, jobs, logs
 * and sessions.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { getFacebookPageForRequest } from '@/lib/facebook/routeHelpers';
import { pauseFacebookAutomationsForDisconnect } from '@/lib/automation/disconnectPreservation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:facebook-disconnect');

type RouteContext = { params: Promise<{ pageId: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const { pageId } = await context.params;
  const db = createServiceClient();

  const lookup = await getFacebookPageForRequest(db, user, request, pageId, 'accountAdmin', false);
  if (!lookup.ok) return lookup.response;
  const page = lookup.page;

  // Idempotent: already soft-disconnected — the row stays and the
  // automations were already paused by the first disconnect.
  if (page.is_active === false) {
    return Response.json({ success: true, pausedAutomations: 0 });
  }

  // Pause the Page's automations FIRST (only the ones currently
  // active — manually-paused ones keep their own state). If this fails
  // nothing is mutated: the Page stays connected.
  let pausedIds: string[];
  try {
    pausedIds = await pauseFacebookAutomationsForDisconnect(db, page.id, { userId: user.id });
  } catch (err) {
    logger.error({ err, pageId }, 'Failed to pause automations for Facebook disconnect');
    return Response.json({ error: 'Failed to disconnect Page' }, { status: 500 });
  }

  // Soft-disconnect: keep the row (FKs + automations survive) so a
  // reconnect of the same Page can restore it in place.
  const { error: updateError } = await db
    .from('facebook_pages')
    .update({ is_active: false, disconnected_at: new Date().toISOString() })
    .eq('id', page.id);

  if (updateError) {
    logger.error({ err: updateError, pageId }, 'Failed to disconnect Facebook Page');
    return Response.json({ error: 'Failed to disconnect Page' }, { status: 500 });
  }

  logger.info(
    { userId: user.id, pageName: page.name, pausedAutomations: pausedIds.length },
    'Facebook Page disconnected - automations paused, not deleted',
  );
  return Response.json({ success: true, pausedAutomations: pausedIds.length });
}
