/**
 * GET /api/instagram/posts/:accountId/thumbnails?ids=<csv> — fresh
 * thumbnail URLs for the given media IDs.
 *
 * Why this exists (2026-11-22): `automations.post_thumbnail_url` is a
 * snapshot written once at creation and never refreshed, and Instagram
 * CDN URLs expire within days — so the automations list and the editor
 * showed broken-image icons for every automation older than a few
 * days. The list/editor call this endpoint at render time and use the
 * fresh URL (falling back to the stored snapshot, then to a clean
 * placeholder). No database write: `automations` has an `updated_at`
 * trigger, so refreshing the stored snapshot in place would silently
 * rewrite every automation's displayed date.
 *
 * Auth / account lookup / token decryption mirror the posts list
 * route (posts/[accountId]/route.ts) in both the legacy and the
 * workspace-mode (P18) branches. The refresh itself lives in
 * lib/instagram/thumbnailRefresh: `/{media-id}` for own posts, oEmbed
 * over the rebuilt permalink for collab posts the token cannot read
 * by ID.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { META_API_VERSION } from '@/lib/instagram/api';
import {
  parseThumbnailIds,
  resolveInstagramThumbnail,
} from '@/lib/instagram/thumbnailRefresh';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:posts:thumbnails');
const META_GRAPH_BASE = `https://graph.instagram.com/${META_API_VERSION}`;
const META_FACEBOOK_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

type RouteContext = { params: Promise<{ accountId: string }> };
type Db = ReturnType<typeof createServiceClient>;

async function resolveAccessToken(
  db: Db,
  user: { id: string },
  request: Request,
  accountId: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; response: Response }> {
  const decryptFailure = () =>
    Response.json({ error: 'Failed to access Instagram account - please reconnect' }, { status: 500 });

  if (!readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    const { data: igAccount, error: igError } = await db
      .from('instagram_accounts')
      .select('id, instagram_user_id, access_token_encrypted')
      .eq('id', accountId)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();
    if (igError || !igAccount) {
      return { ok: false, response: Response.json({ error: 'Instagram account not found' }, { status: 404 }) };
    }
    try {
      return {
        ok: true,
        accessToken: decrypt(igAccount.access_token_encrypted as string, getEnv().TOKEN_ENCRYPTION_KEY),
      };
    } catch {
      logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection');
      return { ok: false, response: decryptFailure() };
    }
  }

  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0 ? header : new URL(request.url).searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return {
      ok: false,
      response: Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status }),
    };
  }
  const repo = createTenantRepository(db, resolved.ctx, 'read');
  let igAccount: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  try {
    igAccount = await repo.instagramAccounts.getByIdInWorkspace(accountId);
  } catch {
    igAccount = null;
  }
  if (!igAccount || igAccount['is_active'] === false) {
    return { ok: false, response: Response.json({ error: 'Instagram account not found' }, { status: 404 }) };
  }
  try {
    return {
      ok: true,
      accessToken: decrypt(igAccount['access_token_encrypted'] as string, getEnv().TOKEN_ENCRYPTION_KEY),
    };
  } catch {
    logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection (workspace mode)');
    return { ok: false, response: decryptFailure() };
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const { accountId } = await context.params;
  const ids = parseThumbnailIds(new URL(request.url).searchParams.get('ids'));
  if (ids.length === 0) return Response.json({ thumbnails: {} });

  const db = createServiceClient();
  const resolved = await resolveAccessToken(db, user, request, accountId);
  if (!resolved.ok) return resolved.response;

  const entries = await Promise.all(
    ids.map(async (id) => {
      const url = await resolveInstagramThumbnail(
        fetch,
        META_GRAPH_BASE,
        META_FACEBOOK_BASE,
        resolved.accessToken,
        id,
      );
      return [id, url] as const;
    }),
  );
  return Response.json({ thumbnails: Object.fromEntries(entries) });
}
