/**
 * Programme 18 / Phase G — workspace list + creation.
 *
 *   GET  /api/workspaces — the authenticated user's workspaces,
 *        membership-derived ONLY (listUserWorkspaces queries
 *        workspace_memberships filtered by the caller's user_id, so
 *        it can never enumerate workspaces the caller is not in),
 *        enriched with the workspace row's name/created_at.
 *   POST /api/workspaces — create via the create_workspace RPC from
 *        migration …000031 (atomically creates the workspace AND the
 *        creator's owner membership; there is no direct table insert).
 *
 * Both handlers are flag-gated: authentication first (401), then the
 * workspace-runtime gate (503 'workspace-runtime-disabled' while
 * WORKSPACE_RUNTIME_ENABLED is off — the default).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import { listUserWorkspaces } from '@/lib/tenancy/routeContext';
import {
  workspaceDisabledResponse,
  readJsonBody,
  stringField,
  rpcErrorResponse,
} from './workspaceShared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const disabled = workspaceDisabledResponse();
  if (disabled) return disabled;

  // Programme 30 (AA-6): the list + name-enrichment reads run on the
  // caller's own user-scoped client (the F-J1 factory), not the
  // service role. RLS permits exactly these reads for a member
  // (…000024: memberships_select_member / workspaces_select_member),
  // the queries are unchanged, and the id set still derives
  // exclusively from the caller's own memberships above — the service
  // role is no longer involved in this read path at all.
  const rpcClient = await createUserRpcClient(request, user.id);
  if (!rpcClient.ok) {
    return Response.json({ error: rpcClient.error }, { status: rpcClient.status });
  }
  const db = rpcClient.client;
  const memberships = await listUserWorkspaces(db, user.id);

  // Enrich with names/created_at for the selector UI. The id list comes
  // exclusively from the caller's own memberships above.
  const names = new Map<string, { name: string | null; created_at: string | null }>();
  if (memberships.length > 0) {
    const { data } = await db
      .from('workspaces')
      .select('id, name, created_at')
      .in(
        'id',
        memberships.map((m) => m.workspaceId),
      );
    if (Array.isArray(data)) {
      for (const row of data as Array<Record<string, unknown>>) {
        if (typeof row['id'] === 'string') {
          names.set(row['id'], {
            name: typeof row['name'] === 'string' ? row['name'] : null,
            created_at: typeof row['created_at'] === 'string' ? row['created_at'] : null,
          });
        }
      }
    }
  }

  const workspaces = memberships.map((m) => ({
    id: m.workspaceId,
    workspaceId: m.workspaceId,
    name: names.get(m.workspaceId)?.name ?? null,
    role: m.role,
    created_at: names.get(m.workspaceId)?.created_at ?? null,
  }));
  return Response.json({ workspaces });
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const disabled = workspaceDisabledResponse();
  if (disabled) return disabled;

  const body = await readJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const name = stringField(body, 'name');
  if (!name) {
    return Response.json({ error: 'A non-blank workspace name is required' }, { status: 400 });
  }

  // F-J1 (Programme 19): create_workspace derives its actor from
  // auth.uid(), which is NULL under the service role — the RPC must run
  // through the caller's own user-JWT client (see userClient.ts).
  // Programme 30 (AA-6): the GET list path above now uses the same
  // factory, so this file no longer imports the service client at all.
  const rpcClient = await createUserRpcClient(request, user.id);
  if (!rpcClient.ok) {
    return Response.json({ error: rpcClient.error }, { status: rpcClient.status });
  }
  const db = rpcClient.client;
  const { data, error } = await db.rpc('create_workspace', { p_name: name });
  if (error) return rpcErrorResponse(error, 'Failed to create workspace');

  const workspaceId = typeof data === 'string' ? data : null;
  return Response.json(
    { workspace: { id: workspaceId, workspaceId, name, role: 'owner' } },
    { status: 201 },
  );
}
