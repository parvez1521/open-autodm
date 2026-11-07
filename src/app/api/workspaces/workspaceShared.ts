/**
 * Programme 18 / Phase G — shared helpers for the NEW workspace routes
 * under src/app/api/workspaces/**. This file is NOT a route (Next only
 * treats route.ts files as handlers); it exists so every workspace
 * route applies the exact same gate, selector, and error mapping.
 *
 * Gate order in every handler (per the Phase G brief):
 *   1. authenticate via getAuthenticatedUser (401 first),
 *   2. workspace-runtime flag gate (503 'workspace-runtime-disabled'),
 *   3. fresh workspace-context resolution per request — no caching.
 *
 * Invitation token contract (from migrations …000024 + …000031, read
 * verbatim before writing this code):
 *   - workspace_invitations stores ONLY `token_hash` (TEXT, unique);
 *     the raw token is never persisted.
 *   - accept_workspace_invitation hashes the presented token as
 *     `encode(extensions.digest(p_token, 'sha256'), 'hex')` and looks
 *     the invitation up by that hash — so the app layer must store
 *     sha256-hex(raw token) in token_hash.
 *   - Tokens are generated with node:crypto randomBytes — never with
 *     any predictable PRNG.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  readWorkspaceFlags,
  assertWorkspaceRouteEnabled,
} from '@/lib/tenancy/workspaceFlags';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

/** 503 response when WORKSPACE_RUNTIME_ENABLED is off, else null. */
export function workspaceDisabledResponse(): Response | null {
  const gate = assertWorkspaceRouteEnabled(readWorkspaceFlags(process.env));
  if (gate.ok) return null;
  return Response.json(
    {
      error: gate.reason,
      code: gate.reason,
      reason: gate.reason,
      message: 'Workspace runtime is not enabled on this instance.',
    },
    { status: gate.status },
  );
}

/** The Phase D selector convention: x-workspace-id header wins over ?workspace=. */
export function workspaceSelector(request: Request): string | null {
  const header = request.headers.get('x-workspace-id');
  if (header && header.trim().length > 0) return header;
  return new URL(request.url).searchParams.get('workspace');
}

export function resolutionFailure(res: {
  status: number;
  code: string;
  message: string;
}): Response {
  return Response.json({ error: res.message, code: res.code }, { status: res.status });
}

export function capabilityFailure(err: unknown): Response {
  if (err instanceof WorkspaceAccessError) {
    return Response.json({ error: err.message, code: err.code }, { status: 403 });
  }
  return Response.json({ error: 'Workspace authorization failed' }, { status: 500 });
}

/**
 * Map a membership-RPC error (…000031) onto an HTTP status. The RPCs
 * raise generic, non-sensitive messages; expected domain failures are
 * client errors (4xx) — never a 500 and never a partial success.
 * The last-owner guard surfaces as 409 (conflict with current state).
 */
export function rpcErrorResponse(error: { message?: string } | null, fallback = 'Workspace operation failed'): Response {
  const message = error?.message ?? fallback;
  const lower = message.toLowerCase();
  let status = 400;
  if (lower.includes('last owner')) status = 409;
  else if (lower.includes('already accepted')) status = 409;
  else if (lower.includes('expired')) status = 410;
  else if (lower.includes('not found')) status = 404;
  else if (
    lower.includes('does not match') ||
    lower.includes('only an owner') ||
    lower.includes('only an owner or admin') ||
    lower.includes('may not modify') ||
    lower.includes('may not remove') ||
    lower.includes('not a member')
  ) {
    status = 403;
  }
  return Response.json({ error: message, code: 'workspace-rpc-error' }, { status });
}

/** Raw invitation token: 32 bytes of crypto randomness, base64url. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256-hex of the raw token — the ONLY form stored (see header). */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Invitation lifetime applied by the invitations route (7 days). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}
