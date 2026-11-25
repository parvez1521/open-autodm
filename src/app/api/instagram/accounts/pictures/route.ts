/**
 * GET /api/instagram/accounts/pictures?ids=<csv> — fresh profile
 * picture URLs for the given connected Instagram accounts.
 *
 * Why this exists (UI polish, 2026-11-25): the stored
 * `profile_picture_url` is a snapshot written once at connect time
 * and never refreshed, and Instagram CDN URLs expire within days —
 * so the account switcher showed a real photo for the most
 * recently connected account and bare letter tiles for the older
 * ones. The switcher calls this endpoint at render time and uses
 * the fresh URL (falling back to the stored URL, then to the glyph
 * tile in IgAvatar). No database write: refreshing the stored
 * snapshot in place would churn the row for no benefit.
 *
 * Auth / account lookup / token decryption mirror the posts
 * thumbnails route (posts/[accountId]/thumbnails/route.ts) in both
 * the legacy and the workspace-mode (P18) branches. The refresh
 * itself lives in lib/instagram/profilePicture:
 * `/{ig-user-id}?fields=profile_picture_url` with the account's
 * own token.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { META_API_VERSION } from '@/lib/instagram/api';
import {
  parseProfilePictureIds,
  resolveInstagramProfilePicture,
} from '@/lib/instagram/profilePicture';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:accounts:pictures');
const META_GRAPH_BASE = `https://graph.instagram.com/${META_API_VERSION}`;

type Db = ReturnType<typeof createServiceClient>;

async function resolveAccount(
  db: Db,
  user: { id: string },
  request: Request,
  accountId: string,
): Promise<
  | { ok: true; accessToken: string; instagramUserId: string }
  | { ok: false; response: Response }
> {
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
        instagramUserId: igAccount.instagram_user_id as string,
      };
    } catch {
      logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection');
      return { ok: false, response: Response.json({ error: 'Failed to access Instagram account - please reconnect' }, { status: 500 }) };
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
      instagramUserId: igAccount['instagram_user_id'] as string,
    };
  } catch {
    logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection (workspace mode)');
    return { ok: false, response: Response.json({ error: 'Failed to access Instagram account - please reconnect' }, { status: 500 }) };
  }
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const ids = parseProfilePictureIds(new URL(request.url).searchParams.get('ids'));
  if (ids.length === 0) return Response.json({ pictures: {} });

  const db = createServiceClient();
  const entries = await Promise.all(
    ids.map(async (id) => {
      const resolved = await resolveAccount(db, user, request, id);
      if (!resolved.ok) return [id, null] as const;
      const url = await resolveInstagramProfilePicture(
        fetch,
        META_GRAPH_BASE,
        resolved.accessToken,
        resolved.instagramUserId,
      );
      return [id, url] as const;
    }),
  );
  return Response.json({ pictures: Object.fromEntries(entries) });
}
