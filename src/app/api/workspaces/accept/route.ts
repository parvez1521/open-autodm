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
import {
  workspaceDisabledResponse,
  readJsonBody,
  stringField,
  rpcErrorResponse,
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

  // F-J1 (Programme 19): accept_workspace_invitation derives its actor
  // (and the verified-email match) from auth.uid(), which is NULL under
  // the service role — the RPC must run through the caller's own
  // user-JWT client (see userClient.ts). This route no longer uses the
  // service client at all.
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
