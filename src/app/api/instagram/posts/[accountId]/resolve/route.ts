/**
 * POST /api/instagram/posts/:accountId/resolve - resolve one Instagram
 * post from a pasted link.
 *
 * Why this exists (2026-11-15): the picker's list comes from the Graph
 * API `/{ig-user-id}/media`, which returns ONLY posts where the
 * connected account is the collaboration OWNER (first-named in the
 * collab header). Collab posts owned by the other account — e.g. the
 * Nov 14 "Clone any tool" reel, owned by tech_hacks.ai with
 * @beyond_the.feed as collaborator — never appear in the grid, no
 * matter how often the user hits Refresh. Resolving by URL goes
 * around the list: oEmbed maps the public post URL to its media ID,
 * then `/{media-id}` fetches the post itself, and the picker selects
 * it through the exact same path as a tile click.
 *
 * Auth / account lookup / token decryption follow the list route
 * (posts/[accountId]/route.ts) in both the legacy and the workspace-
 * mode (P18) branches.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { META_API_VERSION } from '@/lib/instagram/api';
import {
  decodeInstagramShortcode,
  extractInstagramShortcode,
  normalizeInstagramPostUrl,
} from '@/lib/instagram/postUrl';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:posts:resolve');
const META_GRAPH_BASE = `https://graph.instagram.com/${META_API_VERSION}`;
const META_FACEBOOK_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

const INVALID_URL_ERROR =
  'Is link ko samajh nahi paye — Instagram post ka link paste karo (instagram.com/p/... ya /reel/...).';
const UNRESOLVABLE_ERROR =
  'Is post ko load nahi kar paye — link check karo, post public hona chahiye.';

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

export interface ResolvedInstagramPost {
  id: string;
  type: 'reel' | 'image' | 'carousel';
  thumbnail_url: string | null;
  media_url: string | null;
  permalink: string;
  timestamp: string;
  caption: string;
  like_count: number;
  comments_count: number;
}

/** The EXACT post shape the list route returns — same fields, same mapping. */
function mapMetaMediaItem(item: MetaMediaItem): ResolvedInstagramPost {
  return {
    id: item.id,
    type: (item.media_type === 'VIDEO'
      ? 'reel'
      : item.media_type === 'CAROUSEL_ALBUM'
        ? 'carousel'
        : 'image') as 'reel' | 'image' | 'carousel',
    thumbnail_url: item.thumbnail_url ?? item.media_url ?? null,
    media_url: item.media_url ?? null,
    permalink: item.permalink,
    timestamp: item.timestamp,
    caption: item.caption ?? '',
    like_count: item.like_count ?? 0,
    comments_count: item.comments_count ?? 0,
  };
}

type ResolveResult =
  | { ok: true; post: ResolvedInstagramPost }
  | { ok: false; status: number; error: string };

const MEDIA_FIELDS =
  'id,media_type,thumbnail_url,media_url,permalink,timestamp,caption,like_count,comments_count';

/**
 * Shortcode → media object, using the account's Meta token.
 *
 * Primary path: Instagram oEmbed maps the public post URL to its
 * media ID. Fallback: the shortcode IS the media ID in base-64
 * (alphabet A-Za-z0-9-_); decoding it avoids oEmbed entirely when
 * Meta rejects the oEmbed call for this token.
 */
async function resolvePostByUrl(accessToken: string, rawUrl: string): Promise<ResolveResult> {
  const shortcode = extractInstagramShortcode(rawUrl);
  if (!shortcode) {
    return { ok: false, status: 400, error: INVALID_URL_ERROR };
  }

  let mediaId: string | null = null;
  try {
    const oembedUrl = `${META_FACEBOOK_BASE}/instagram_oembed?url=${encodeURIComponent(
      normalizeInstagramPostUrl(shortcode),
    )}&access_token=${accessToken}`;
    const res = await fetch(oembedUrl);
    if (res.ok) {
      const data = (await res.json()) as { media_id?: string };
      if (typeof data.media_id === 'string' && data.media_id.length > 0) {
        mediaId = data.media_id;
      }
    } else {
      // NEW-2 (Phase 10.5): never log the raw upstream body — sanitized
      // metadata only (status); the client response stays generic.
      logger.warn({ status: res.status }, 'oEmbed lookup failed - trying shortcode decode fallback');
    }
  } catch (err) {
    logger.warn({ err }, 'oEmbed lookup network error - trying shortcode decode fallback');
  }

  if (!mediaId) {
    mediaId = decodeInstagramShortcode(shortcode);
  }
  if (!mediaId) {
    return { ok: false, status: 502, error: UNRESOLVABLE_ERROR };
  }

  let media: MetaMediaItem;
  try {
    const res = await fetch(
      `${META_GRAPH_BASE}/${mediaId}?fields=${MEDIA_FIELDS}&access_token=${accessToken}`,
    );
    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, bodyLength: body.length }, 'Meta media-by-id fetch failed');
      return { ok: false, status: 502, error: UNRESOLVABLE_ERROR };
    }
    media = (await res.json()) as MetaMediaItem;
  } catch (err) {
    logger.error({ err }, 'Network error fetching Instagram media by id');
    return { ok: false, status: 502, error: UNRESOLVABLE_ERROR };
  }

  return { ok: true, post: mapMetaMediaItem(media) };
}

type RouteContext = { params: Promise<{ accountId: string }> };

function parseUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const url = (body as { url?: unknown }).url;
  return typeof url === 'string' && url.trim().length > 0 ? url : null;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Resolve(request, user, context);
  }

  const { accountId } = await context.params;
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

  let accessToken: string;
  try {
    accessToken = decrypt(igAccount.access_token_encrypted as string, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection');
    return Response.json({ error: 'Failed to access Instagram account - please reconnect' }, { status: 500 });
  }

  const result = await resolvePostByUrl(accessToken, url);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ post: result.post });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Same resolve core as the legacy branch above; only the account lookup
// differs (repository getByIdInWorkspace, 'read' gate — viewing a post
// exercises the account's Meta token but is gated as a READ, exactly
// like the list route's p18Posts).
async function p18Resolve(
  request: Request,
  user: { id: string },
  context: RouteContext,
): Promise<Response> {
  const { accountId } = await context.params;
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
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0 ? header : new URL(request.url).searchParams.get('workspace');
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

  let accessToken: string;
  try {
    accessToken = decrypt(igAccount['access_token_encrypted'] as string, getEnv().TOKEN_ENCRYPTION_KEY);
  } catch {
    logger.error({ accountId }, 'Failed to decrypt token - account needs reconnection (workspace mode)');
    return Response.json({ error: 'Failed to access Instagram account - please reconnect' }, { status: 500 });
  }

  const result = await resolvePostByUrl(accessToken, url);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ post: result.post });
}
