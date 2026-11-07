/**
 * Programme 18 / Phase G — GET /api/workspaces/[workspaceId]/members.
 *
 * Member-list visibility DECISION (recorded in the Phase G staging
 * note): readable by ALL members of the workspace, including viewers —
 * it follows the Phase B read rule ("reads: any member incl. viewer").
 * A non-member gets the resolution failure (403 not-a-member) and no
 * member data.
 *
 * Emails: workspace_memberships (…000024) stores no email column, so
 * `email` is the value as stored on the membership row when present
 * and null otherwise — it is never derived from user-editable profile
 * metadata. `joined_at` is the membership row's created_at (the
 * table's only join timestamp).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { workspaceDisabledResponse, resolutionFailure } from '../../workspaceShared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const disabled = workspaceDisabledResponse();
  if (disabled) return disabled;

  const { workspaceId } = await context.params;

  // Programme 30 (AA-6): the context resolution and the member-list
  // read run on the caller's own user-scoped client (the F-J1
  // factory), not the service role. RLS permits exactly these reads
  // for any member of the workspace (…000024:
  // memberships_select_member — a member may read the membership rows
  // of their own workspaces), and a non-member's row is invisible
  // under RLS, which the resolver already maps to the same
  // 403 not-a-member outcome the service-client read produced. The
  // queries and the response shape are unchanged.
  const rpcClient = await createUserRpcClient(request, user.id);
  if (!rpcClient.ok) {
    return Response.json({ error: rpcClient.error }, { status: rpcClient.status });
  }
  const db = rpcClient.client;

  const resolved = await resolveRouteWorkspaceContext(db, user.id, workspaceId);
  if (!resolved.ok) return resolutionFailure(resolved);

  const { data, error } = await db
    .from('workspace_memberships')
    .select('user_id, role, created_at')
    .eq('workspace_id', resolved.ctx.workspaceId)
    .order('created_at', { ascending: true });

  if (error) {
    return Response.json({ error: 'Failed to list workspace members' }, { status: 500 });
  }

  const members = (Array.isArray(data) ? data : []).map((row) => {
    const r = row as Record<string, unknown>;
    const joinedAt = typeof r['created_at'] === 'string' ? r['created_at'] : null;
    return {
      userId: typeof r['user_id'] === 'string' ? r['user_id'] : null,
      user_id: typeof r['user_id'] === 'string' ? r['user_id'] : null,
      email: typeof r['email'] === 'string' ? r['email'] : null,
      role: typeof r['role'] === 'string' ? r['role'] : null,
      joined_at: joinedAt,
      created_at: joinedAt,
    };
  });

  return Response.json({
    workspaceId: resolved.ctx.workspaceId,
    callerRole: resolved.ctx.role,
    members,
  });
}
