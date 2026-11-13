/**
 * GET /api/instagram/posts/:accountId - the creator's media grid.
 * Cursor-paginated from the Meta Graph API, with a short in-memory cache
 * (per warm serverless instance) so browsing the picker doesn't hammer Meta.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { META_API_VERSION } from '@/lib/instagram/api';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:posts');
const META_GRAPH_BASE = `https://graph.instagram.com/${META_API_VERSION}`;

interface MetaMediaItem {
  id: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  thumbnail_url?: string;
  media_url?: string;
  permalink: string;
  timestamp: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
}

interface MetaMediaResponse {
  data: MetaMediaItem[];
  paging?: { cursors?: { before: string; after: string }; next?: string };
}

interface PostsPage {
  posts: Array<{
    id: string;
    type: 'reel' | 'image' | 'carousel';
    thumbnail_url: string | null;
    media_url: string | null;
    permalink: string;
    timestamp: string;
    caption: string;
    like_count: number;
    comments_count: number;
  }>;
  nextCursor: string | null;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { value: PostsPage; at: number }>();

type RouteContext = { params: Promise<{ accountId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Posts(request, user, context);
  }

  const { accountId } = await context.params;
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 50);
  const after = url.searchParams.get('after');
  // `?refresh=1` (picker Refresh button) skips the cache READ so the
  // list goes back to Meta — the fresh result is still WRITTEN to the
  // cache below, so the next plain read is served from it.
  const refresh = url.searchParams.get('refresh') === '1';

  const db = createServiceClient();
  const { data: igAccount, error: igError } = await db
    .from('instagram_accounts')
    .select('id, instagram_user_id, access_token_encrypted')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single();

  if (igError || !igAccount) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  // Phase D1 (defense-in-depth): the cache key carries the authenticated
  // user's id, so two users asking for the same account id can never be
  // served each other's cached page — even if a future change loosens
  // the account-ownership query above, the cache stays per-user.
  const cacheKey = `${user.id}:${accountId}:${limit}:${after ?? 'first'}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json({ ...hit.value, cached: true });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(igAccount.access_token_encrypted as string, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection');
    return Response.json({ error: 'Failed to access Instagram account - please reconnect' }, { status: 500 });
  }

  const fields = 'id,media_type,thumbnail_url,media_url,permalink,timestamp,caption,like_count,comments_count';
  const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
  const mediaUrl = `${META_GRAPH_BASE}/${igAccount.instagram_user_id}/media?fields=${fields}&limit=${limit}${afterParam}&access_token=${accessToken}`;

  let metaResponse: MetaMediaResponse;
  try {
    const res = await fetch(mediaUrl);
    if (!res.ok) {
      const body = await res.text();
      // NEW-2 (Phase 10.5): never log the raw upstream body — sanitized
      // metadata only (status + length); the client response stays generic.
      logger.error({ accountId, status: res.status, bodyLength: body.length }, 'Meta media fetch failed');
      return Response.json({ error: 'Failed to fetch posts from Instagram' }, { status: 502 });
    }
    metaResponse = (await res.json()) as MetaMediaResponse;
  } catch (err) {
    logger.error({ err, accountId }, 'Network error fetching Instagram media');
    return Response.json({ error: 'Failed to reach Instagram API' }, { status: 502 });
  }

  const posts = (metaResponse.data ?? []).map((item) => ({
    id: item.id,
    type: (item.media_type === 'VIDEO' ? 'reel' : item.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'image') as
      | 'reel'
      | 'image'
      | 'carousel',
    thumbnail_url: item.thumbnail_url ?? item.media_url ?? null,
    media_url: item.media_url ?? null,
    permalink: item.permalink,
    timestamp: item.timestamp,
    caption: item.caption ?? '',
    like_count: item.like_count ?? 0,
    comments_count: item.comments_count ?? 0,
  }));

  const hasNextPage = !!metaResponse.paging?.next;
  const pageData: PostsPage = {
    posts,
    nextCursor: hasNextPage ? metaResponse.paging?.cursors?.after ?? null : null,
  };

  cache.set(cacheKey, { value: pageData, at: Date.now() });
  // Bound the per-instance cache
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return Response.json({ ...pageData, cached: false });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// PD-3 (read/management split): viewing posts exercises the account's
// Meta token, but per the Phase D instruction it is gated as a READ —
// workspace membership ('read', any member incl. viewer) plus the
// account bound to the ctx workspace (repository getByIdInWorkspace;
// foreign/unbound/inactive ⇒ 404, token never decrypted for such an
// account). Management actions stay 'accountAdmin' on their own routes.
//
// Cache safety: the legacy cache key is `${user.id}:…`. In workspace
// mode the key additionally carries ctx.workspaceId, so a page cached
// under one workspace can never be served under another workspace's
// context for the same user + account.
async function p18Posts(
  request: Request,
  user: { id: string },
  context: RouteContext,
): Promise<Response> {
  const { accountId } = await context.params;
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 50);
  const after = url.searchParams.get('after');
  // Same `?refresh=1` contract as the legacy branch above: skip the
  // cache READ, still write the fresh result into the cache.
  const refresh = url.searchParams.get('refresh') === '1';

  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0 ? header : url.searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  const ctx = resolved.ctx;
  const repo = createTenantRepository(db, ctx, 'read');

  let igAccount: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  try {
    igAccount = await repo.instagramAccounts.getByIdInWorkspace(accountId);
  } catch {
    igAccount = null;
  }
  if (!igAccount || igAccount['is_active'] === false) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  const cacheKey = `${ctx.workspaceId}:${user.id}:${accountId}:${limit}:${after ?? 'first'}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json({ ...hit.value, cached: true });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(igAccount['access_token_encrypted'] as string, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection (workspace mode)');
    return Response.json({ error: 'Failed to access Instagram account - please reconnect' }, { status: 500 });
  }

  const fields = 'id,media_type,thumbnail_url,media_url,permalink,timestamp,caption,like_count,comments_count';
  const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
  const mediaUrl = `${META_GRAPH_BASE}/${igAccount['instagram_user_id']}/media?fields=${fields}&limit=${limit}${afterParam}&access_token=${accessToken}`;

  let metaResponse: MetaMediaResponse;
  try {
    const res = await fetch(mediaUrl);
    if (!res.ok) {
      const body = await res.text();
      logger.error({ accountId, status: res.status, bodyLength: body.length }, 'Meta media fetch failed (workspace mode)');
      return Response.json({ error: 'Failed to fetch posts from Instagram' }, { status: 502 });
    }
    metaResponse = (await res.json()) as MetaMediaResponse;
  } catch (err) {
    logger.error({ err, accountId }, 'Network error fetching Instagram media (workspace mode)');
    return Response.json({ error: 'Failed to reach Instagram API' }, { status: 502 });
  }

  const posts = (metaResponse.data ?? []).map((item) => ({
    id: item.id,
    type: (item.media_type === 'VIDEO' ? 'reel' : item.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'image') as
      | 'reel'
      | 'image'
      | 'carousel',
    thumbnail_url: item.thumbnail_url ?? item.media_url ?? null,
    media_url: item.media_url ?? null,
    permalink: item.permalink,
    timestamp: item.timestamp,
    caption: item.caption ?? '',
    like_count: item.like_count ?? 0,
    comments_count: item.comments_count ?? 0,
  }));

  const hasNextPage = !!metaResponse.paging?.next;
  const pageData: PostsPage = {
    posts,
    nextCursor: hasNextPage ? metaResponse.paging?.cursors?.after ?? null : null,
  };

  cache.set(cacheKey, { value: pageData, at: Date.now() });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return Response.json({ ...pageData, cached: false });
}
