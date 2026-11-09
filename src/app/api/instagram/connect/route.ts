/**
 * GET /api/instagram/connect - build the Instagram Business Login URL.
 * Returns { url }; the frontend navigates the browser there.
 *
 * Phase D1: an optional `?workspace=<id>` query param starts a
 * workspace-bound connect. The caller must be owner/admin of that
 * workspace — verified server-side against workspace_memberships via
 * resolveWorkspaceContext + requireWorkspaceRole (the service client is
 * memberships-capable; a client-supplied id alone is never trusted).
 * Failure is closed: a redirect to /settings with instagram_error,
 * mirroring the callback's error surface, and NO OAuth URL is issued.
 * Without the param the legacy single-owner flow is byte-for-byte
 * unchanged.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { isAdminEmail } from '@/lib/admin/panel';
import { getMetaSettings } from '@/lib/settings';
import { buildOAuthUrl, signOAuthState } from '@/lib/instagram/oauth';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveWorkspaceContext, requireWorkspaceRole } from '@/lib/tenancy/context';
import { getAppUrl } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const settings = await getMetaSettings();
  if (!settings) {
    // Owner directive (2026-11-10, Task F addendum): the Setup
    // Wizard is platform-admin only, so the wizard pointer is a
    // dead end for customers. Admins keep it; customers get the
    // honest state — the same copy the settings page uses for the
    // setup_required banner. Every consumer of this route (the
    // account switcher's Add account flow, the settings Connect
    // button) renders `message` verbatim, so the role split lives
    // here, once.
    const message = isAdminEmail(user.email, process.env)
      ? 'Complete the Setup Wizard (Meta App ID + Secret) before connecting Instagram.'
      : 'Instagram cannot connect yet — the platform setup is not complete.';
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
        `${getAppUrl(request)}/settings?instagram_error=workspace_not_authorized`,
        302
      );
    }
  }

  const state = await signOAuthState(user.id, workspaceId);
  const redirectUri = `${getAppUrl(request)}/api/instagram/callback`;
  const url = buildOAuthUrl(settings.metaAppId, redirectUri, state);

  return Response.json({ url });
}
