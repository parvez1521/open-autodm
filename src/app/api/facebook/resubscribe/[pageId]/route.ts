/**
 * POST /api/facebook/resubscribe/:pageId - re-run the per-Page webhook
 * field subscription ("Fix Webhooks" button). Use when comments or DMs
 * stop arriving. Mirrors /api/instagram/resubscribe/:accountId.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { subscribePageToWebhookFields, FB_WEBHOOK_SUBSCRIBED_FIELDS } from '@/lib/facebook/api';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { getFacebookPageForRequest } from '@/lib/facebook/routeHelpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ pageId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const { pageId } = await context.params;
  const db = createServiceClient();

  const lookup = await getFacebookPageForRequest(db, user, request, pageId, 'accountAdmin', true);
  if (!lookup.ok) return lookup.response;
  const page = lookup.page;

  let accessToken: string;
  try {
    accessToken = decrypt(page.access_token_encrypted, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    return Response.json({ error: 'Failed to decrypt token' }, { status: 500 });
  }

  const result = await subscribePageToWebhookFields(page.facebook_page_id, accessToken);
  if (!result.ok) {
    return Response.json(
      { error: 'resubscription_failed', message: `Meta API error: ${result.body.slice(0, 300)}` },
      { status: 502 }
    );
  }

  return Response.json({ success: true, subscribedFields: FB_WEBHOOK_SUBSCRIBED_FIELDS, meta: result.body });
}
