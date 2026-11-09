/**
 * Programme 18 / Phase G — POST /api/workspaces/[workspaceId]/invitations.
 *
 * Requires canManageMembers (owner/admin) — pre-checked server-side
 * against a freshly resolved workspace context; a member/viewer gets
 * 403 and NO invitation row is written.
 *
 * Contract (migrations …000024 + …000031, read verbatim):
 *   workspace_invitations(workspace_id, email, role, token_hash,
 *   invited_by, expires_at, accepted_at, created_at) with
 *   `role <> 'owner'` CHECK and a UNIQUE index on token_hash; the
 *   table stores ONLY the hash — accept_workspace_invitation derives
 *   it as sha256-hex of the presented raw token.
 *
 * NO EMAIL IS EVER SENT. The raw token is returned ONCE in this
 * response together with a copyable accept link (local/mock flow);
 * there is deliberately no endpoint that can re-read it.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import {
  evaluateEntitlementGate,
  planLimitResponse,
  countWorkspaceMembers,
} from '@/lib/entitlements/guard';
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
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
} from '../../workspaceShared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ workspaceId: string }> };

const INVITABLE_ROLES = ['admin', 'member', 'viewer'] as const;

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const disabled = workspaceDisabledResponse();
  if (disabled) return disabled;

  const { workspaceId } = await context.params;
  const db = createServiceClient();

  const resolved = await resolveRouteWorkspaceContext(db, user.id, workspaceId);
  if (!resolved.ok) return resolutionFailure(resolved);
  try {
    requireCapability(resolved.ctx, 'manageMembers');
  } catch (err) {
    return capabilityFailure(err);
  }

  const body = await readJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const email = stringField(body, 'email').toLowerCase();
  const role = stringField(body, 'role') || 'member';
  if (!email || !email.includes('@')) {
    return Response.json({ error: 'A valid invited email is required' }, { status: 400 });
  }
  if (!(INVITABLE_ROLES as readonly string[]).includes(role)) {
    return Response.json(
      { error: "Invited role must be one of: admin, member, viewer (owner cannot be invited)" },
      { status: 400 },
    );
  }

  // Trial/workspace farming fix (2026-11-09): an invitation that is
  // accepted consumes one of the plan's `teamSeats`. Gate the CREATE
  // here (and the accept in /api/workspaces/accept) so a workspace
  // cannot grow past its plan's seats by invitation. Flag off ⇒
  // pass-through, zero behaviour change (lib/entitlements/guard.ts).
  const gate = await evaluateEntitlementGate(db, {
    dimension: 'teamSeats',
    resolveContext: async () => ({
      workspaceId: resolved.ctx.workspaceId,
      usage: { teamSeatsUsed: await countWorkspaceMembers(db, resolved.ctx.workspaceId) },
    }),
  });
  if (gate.blocked) return planLimitResponse(gate);

  const token = generateInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();

  const { data, error } = await db
    .from('workspace_invitations')
    .insert({
      workspace_id: resolved.ctx.workspaceId,
      email,
      role,
      token_hash: tokenHash,
      invited_by: user.id,
      expires_at: expiresAt,
    })
    .select('id, workspace_id, email, role, expires_at, created_at')
    .maybeSingle();

  if (error) {
    return Response.json({ error: 'Failed to create invitation' }, { status: 500 });
  }

  const origin = new URL(request.url).origin;
  const acceptLink = `${origin}/settings/workspace?inviteToken=${token}`;
  const invitation = (data ?? {}) as Record<string, unknown>;

  return Response.json(
    {
      invitation: {
        id: typeof invitation['id'] === 'string' ? invitation['id'] : null,
        workspaceId: resolved.ctx.workspaceId,
        email,
        role,
        expires_at: expiresAt,
      },
      // Returned ONCE — only the sha256 hash was stored.
      token,
      acceptLink,
    },
    { status: 201 },
  );
}
