/**
 * Shared request helpers for the Facebook Page API routes.
 *
 * The tenant repository (src/lib/tenancy/repository.ts) has no
 * facebookPages accessor — extending it is a follow-up. Until then,
 * workspace mode scopes Facebook Pages with direct service-client
 * queries on facebook_pages.workspace_id (the same scoping the
 * repository applies to instagram_accounts), and the legacy path
 * (workspace flag OFF — the live path) scopes by user_id. Both modes
 * re-resolve the workspace per request and fail closed; a caller
 * supplied id is never trusted on its own.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { WorkspaceAccessError, listMembershipsForUser } from '@/lib/tenancy/context';
import type { FacebookPageRow } from '@/lib/types';

export type FbRouteCapability = 'read' | 'accountAdmin';

export type FbPageLookup =
  | { ok: true; page: FacebookPageRow; workspaceId: string | null }
  | { ok: false; response: Response };

/**
 * Loads one Facebook Page row for the caller, scoped to their ownership
 * (legacy) or their resolved workspace (workspace mode). `requireActive`
 * false is for the disconnect route, which must find already-disconnected
 * rows to answer idempotently.
 */
export async function getFacebookPageForRequest(
  db: SupabaseClient,
  user: { id: string },
  request: Request,
  pageId: string,
  capability: FbRouteCapability = 'read',
  requireActive = true
): Promise<FbPageLookup> {
  const notFound = () => Response.json({ error: 'Facebook Page not found' }, { status: 404 });

  if (!readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    const { data: page, error } = await db
      .from('facebook_pages')
      .select('*')
      .eq('id', pageId)
      .eq('user_id', user.id)
      .maybeSingle<FacebookPageRow>();
    if (error || !page) return { ok: false, response: notFound() };
    if (requireActive && !page.is_active) return { ok: false, response: notFound() };
    return { ok: true, page, workspaceId: page.workspace_id };
  }

  // Workspace mode: resolve the caller's workspace, enforce the
  // capability, then scope by workspace_id. Bare calls (no selector)
  // resolve the single-membership default, mirroring the IG routes.
  const header = request.headers.get('x-workspace-id');
  let selector =
    header && header.trim().length > 0
      ? header
      : new URL(request.url).searchParams.get('workspace');
  if (!selector) {
    const memberships = await listMembershipsForUser(db, user.id);
    if (memberships.length === 1) selector = memberships[0]!.workspaceId;
  }
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return {
      ok: false,
      response: Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status }),
    };
  }
  try {
    if (capability === 'accountAdmin') requireCapability(resolved.ctx, 'accountAdmin');
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return { ok: false, response: Response.json({ error: err.message, code: err.code }, { status: 403 }) };
    }
    return { ok: false, response: Response.json({ error: 'Workspace authorization failed' }, { status: 500 }) };
  }
  const { data: page, error } = await db
    .from('facebook_pages')
    .select('*')
    .eq('id', pageId)
    .eq('workspace_id', resolved.ctx.workspaceId)
    .maybeSingle<FacebookPageRow>();
  if (error || !page) return { ok: false, response: notFound() };
  if (requireActive && !page.is_active) return { ok: false, response: notFound() };
  return { ok: true, page, workspaceId: resolved.ctx.workspaceId };
}

/** Lists the caller's connected Pages (legacy: by user; workspace: by workspace). */
export async function listFacebookPagesForRequest(
  db: SupabaseClient,
  user: { id: string },
  request: Request
): Promise<{ rows: FacebookPageRow[] } | { response: Response }> {
  if (!readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    const { data, error } = await db
      .from('facebook_pages')
      .select('id, facebook_page_id, name, username, profile_picture_url, access_token_encrypted, token_expires_at, is_active, paused_until, pause_reason, created_at, updated_at, user_id, connected_by_user_id, workspace_id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) return { response: Response.json({ error: 'Failed to fetch Pages' }, { status: 500 }) };
    return { rows: (data ?? []) as FacebookPageRow[] };
  }

  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0
      ? header
      : new URL(request.url).searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return { response: Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status }) };
  }
  const { data, error } = await db
    .from('facebook_pages')
    .select('id, facebook_page_id, name, username, profile_picture_url, access_token_encrypted, token_expires_at, is_active, paused_until, pause_reason, created_at, updated_at, user_id, connected_by_user_id, workspace_id')
    .eq('workspace_id', resolved.ctx.workspaceId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) return { response: Response.json({ error: 'Failed to fetch Pages' }, { status: 500 }) };
  return { rows: (data ?? []) as FacebookPageRow[] };
}
