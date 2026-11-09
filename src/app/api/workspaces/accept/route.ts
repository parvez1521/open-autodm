/**
 * Programme 18 / Phase G — POST /api/workspaces/accept  { token }.
 *
 * Delegates entirely to the accept_workspace_invitation RPC
 * (migration …000031): it hashes the presented token (sha256-hex),
 * verifies the invitation is live (not accepted, not expired), and
 * verifies the caller's VERIFIED auth.users email matches the invited
 * email inside the definer function before creating the membership.
 * This route adds no email check of its own and reads no profile
 * metadata — the authenticated identity from getAuthenticatedUser is
 * the only identity it supplies, and the RPC is the enforcement.
 *
 * RPC failures (expired / already accepted / mismatched / not found)
 * surface faithfully as 4xx via rpcErrorResponse; no membership is
 * created by this route itself on any path.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createUserRpcClient } from '@/lib/supabase/userClient';
import { createServiceClient } from '@/lib/supabase/service';
import {
  evaluateEntitlementGate,
  planLimitResponse,
  countWorkspaceMembers,
} from '@/lib/entitlements/guard';
import {
  workspaceDisabledResponse,
  readJsonBody,
  stringField,
  rpcErrorResponse,
  hashInvitationToken,
} from '../workspaceShared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const disabled = workspaceDisabledResponse();
  if (disabled) return disabled;

  const body = await readJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const token = stringField(body, 'token');
  if (!token) {
    return Response.json({ error: 'An invitation token is required' }, { status: 400 });
  }

  // Trial/workspace farming fix (2026-11-09): accepting consumes
  // one of the target workspace's `teamSeats` — gate BEFORE the RPC
  // creates the membership (the invitations route gates creation
  // the same way). The target workspace is read from the invitation
  // row by token hash (service role; the row carries no secret —
  // only the hash is stored). The lookup runs ONLY inside the
  // gate's context thunk, so with ENTITLEMENTS_ENFORCED off the
  // route performs no extra read and behaves exactly as before.
  // An unknown/expired/already-accepted token resolves no live
  // invitation → no gate → the RPC below reports it faithfully.
  const gateDb = () => createServiceClient();
  const gate = await evaluateEntitlementGate(gateDb(), {
    dimension: 'teamSeats',
    resolveContext: async () => {
      const db = gateDb();
      const { data } = await db
        .from('workspace_invitations')
        .select('workspace_id, accepted_at, expires_at')
        .eq('token_hash', hashInvitationToken(token))
        .maybeSingle();
      const inv = data as { workspace_id?: unknown; accepted_at?: unknown; expires_at?: unknown } | null;
      const live =
        inv &&
        typeof inv.workspace_id === 'string' &&
        !inv.accepted_at &&
        typeof inv.expires_at === 'string' &&
        Date.parse(inv.expires_at) > Date.now();
      if (!live) return { workspaceId: null, usage: { teamSeatsUsed: 0 } };
      const workspaceId = inv.workspace_id as string;
      return {
        workspaceId,
        usage: { teamSeatsUsed: await countWorkspaceMembers(db, workspaceId) },
      };
    },
  });
  if (gate.blocked) return planLimitResponse(gate);

  // F-J1 (Programme 19): accept_workspace_invitation derives its actor
  // (and the verified-email match) from auth.uid(), which is NULL under
  // the service role — the RPC must run through the caller's own
  // user-JWT client (see userClient.ts). (The service client above is
  // used ONLY for the entitlement gate's read-only seat check.)
  const rpcClient = await createUserRpcClient(request, user.id);
  if (!rpcClient.ok) {
    return Response.json({ error: rpcClient.error }, { status: rpcClient.status });
  }
  const db = rpcClient.client;
  const { data, error } = await db.rpc('accept_workspace_invitation', { p_token: token });
  if (error) return rpcErrorResponse(error, 'Failed to accept invitation');

  const workspaceId = typeof data === 'string' ? data : null;
  return Response.json({ success: true, workspaceId });
}
