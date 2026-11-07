/**
 * Programme 18 / Phase G — member role change + removal.
 *
 *   PATCH  /api/workspaces/[workspaceId]/members/[userId] { role }
 *   DELETE /api/workspaces/[workspaceId]/members/[userId]
 *
 * Both require canManageMembers (owner/admin), pre-checked server-side
 * against a freshly resolved context — a member/viewer gets 403 and
 * the RPC is never called. The mutations themselves go through the
 * …000031 RPCs (change_member_role / remove_member), which enforce
 * the last-owner guard, the admin-cannot-touch-owner rules, and the
 * self-change rules. Those guards are NOT reimplemented here; RPC
 * errors surface faithfully (last-owner ⇒ 409).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import {
  resolveRouteWorkspaceContext,
  requireCapability,
} from '@/lib/tenancy/routeContext';
import {
  workspaceDisabledResponse,
  resolutionFailure,
  capabilityFailure,
  readJsonBody,
  stringField,
  rpcErrorResponse,
} from '../../../workspaceShared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ workspaceId: string; userId: string }> };

const ASSIGNABLE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const disabled = workspaceDisabledResponse();
  if (disabled) return disabled;

  const { workspaceId, userId: targetUserId } = await context.params;

  // F-J1 (Programme 19): the …000031 RPCs derive their actor from
  // auth.uid() (NULL under the service role) — run the RPC through the
  // caller's own user-JWT client.
  // Programme 30 (AA-6): the fresh context resolution now runs on
  // that SAME user-scoped client instead of the service role, so the
  // factory is consulted once, before resolution. RLS permits the
  // resolution read for a member (…000024: memberships_select_member);
  // a non-member's row is invisible under RLS and the resolver maps
  // that to the same 403 not-a-member outcome as before. The
  // capability gate still runs before the RPC — a non-manager gets
  // 403 and the RPC is never called.
  const rpcClient = await createUserRpcClient(request, user.id);
  if (!rpcClient.ok) {
    return Response.json({ error: rpcClient.error }, { status: rpcClient.status });
  }
  const db = rpcClient.client;

  const resolved = await resolveRouteWorkspaceContext(db, user.id, workspaceId);
  if (!resolved.ok) return resolutionFailure(resolved);
  try {
    requireCapability(resolved.ctx, 'manageMembers');
  } catch (err) {
    return capabilityFailure(err);
  }

  const body = await readJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const role = stringField(body, 'role');
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    return Response.json(
      { error: 'Role must be one of: owner, admin, member, viewer' },
      { status: 400 },
    );
  }

  const { error } = await rpcClient.client.rpc('change_member_role', {
    p_workspace_id: resolved.ctx.workspaceId,
    p_target_user_id: targetUserId,
    p_new_role: role,
  });
  if (error) return rpcErrorResponse(error, 'Failed to change member role');

  return Response.json({ success: true, workspaceId: resolved.ctx.workspaceId, userId: targetUserId, role });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const disabled = workspaceDisabledResponse();
  if (disabled) return disabled;

  const { workspaceId, userId: targetUserId } = await context.params;

  // F-J1 (Programme 19) + Programme 30 (AA-6): see PATCH — one
  // user-scoped factory client per request carries the fresh context
  // resolution AND the RPC; the service role is not used in this
  // route at all, and the capability gate still precedes the RPC.
  const rpcClient = await createUserRpcClient(request, user.id);
  if (!rpcClient.ok) {
    return Response.json({ error: rpcClient.error }, { status: rpcClient.status });
  }
  const db = rpcClient.client;

  const resolved = await resolveRouteWorkspaceContext(db, user.id, workspaceId);
  if (!resolved.ok) return resolutionFailure(resolved);
  try {
    requireCapability(resolved.ctx, 'manageMembers');
  } catch (err) {
    return capabilityFailure(err);
  }

  const { error } = await rpcClient.client.rpc('remove_member', {
    p_workspace_id: resolved.ctx.workspaceId,
    p_target_user_id: targetUserId,
  });
  if (error) return rpcErrorResponse(error, 'Failed to remove member');

  return Response.json({ success: true, workspaceId: resolved.ctx.workspaceId, userId: targetUserId });
}
