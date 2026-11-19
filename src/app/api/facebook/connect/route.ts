/**
 * GET /api/facebook/connect - build the Facebook Login URL for Page connect.
 * Returns { url }; the frontend navigates the browser there.
 *
 * Mirrors /api/instagram/connect: an optional `?workspace=<id>` query
 * param starts a workspace-bound connect (owner/admin verified
 * server-side). Without it, workspace mode resolves the caller's
 * default workspace; the legacy flow is unchanged when the flag is off.
 * Failure is closed: a redirect to /settings with facebook_error, and
 * NO OAuth URL is issued.
 *
 * The dialog lets the user pick which Pages to grant (pages_show_list);
 * the callback connects every Page granted there (usually one).
 * business_management is requested too: without it, Pages owned by a
 * Business Portfolio never appear in /me/accounts, so the callback
 * sees no Pages at all (proven live 2026-11-19).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { isAdminEmail } from '@/lib/admin/panel';
import { getMetaSettings } from '@/lib/settings';
import { signOAuthState } from '@/lib/instagram/oauth';
import { buildFacebookOAuthUrl } from '@/lib/facebook/oauth';
import { createServiceClient } from '@/lib/supabase/service';
import {
  resolveWorkspaceContext,
  requireWorkspaceRole,
  listMembershipsForUser,
} from '@/lib/tenancy/context';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { getAppUrl } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const settings = await getMetaSettings();
  if (!settings) {
    const message = isAdminEmail(user.email, process.env)
      ? 'Complete the Setup Wizard (Meta App ID + Secret) before connecting Facebook.'
      : 'Facebook cannot connect yet — the platform setup is not complete.';
    return Response.json({ error: 'setup_required', message }, { status: 409 });
  }

  const workspaceParam = new URL(request.url).searchParams.get('workspace');
  let workspaceId: string | undefined;
  if (workspaceParam) {
    try {
      const ctx = await resolveWorkspaceContext(createServiceClient(), user.id, workspaceParam);
      requireWorkspaceRole(ctx, ['owner', 'admin']);
      workspaceId = ctx.workspaceId;
    } catch {
      return Response.redirect(
        `${getAppUrl(request)}/settings?facebook_error=workspace_not_authorized`,
        302
      );
    }
  } else if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    try {
      const db = createServiceClient();
      const memberships = await listMembershipsForUser(db, user.id);
      if (memberships.length !== 1) {
        throw new Error('No unique default workspace for workspace-mode connect');
      }
      const ctx = await resolveWorkspaceContext(db, user.id, memberships[0]!.workspaceId);
      requireWorkspaceRole(ctx, ['owner', 'admin']);
      workspaceId = ctx.workspaceId;
    } catch {
      return Response.redirect(
        `${getAppUrl(request)}/settings?facebook_error=workspace_not_authorized`,
        302
      );
    }
  }

  const state = await signOAuthState(user.id, workspaceId);
  const redirectUri = `${getAppUrl(request)}/api/facebook/callback`;
  const url = buildFacebookOAuthUrl(settings.metaAppId, redirectUri, state);

  return Response.json({ url });
}
