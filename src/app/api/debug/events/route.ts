/**
 * Debug panel API - recent automation events.
 * GET    → newest 200 events OWNED BY the authenticated user
 * DELETE → clear the authenticated user's own events
 *
 * Auth-gated and additionally hidden in the UI unless NEXT_PUBLIC_DEBUG=true.
 *
 * TENANT ISOLATION (security audit finding #6): events are scoped by the
 * debug_events.user_id column (migration 20260730000003). Rows with
 * user_id NULL - system events with no derivable owner - are hidden from
 * ordinary users rather than leaked instance-wide, and DELETE can only
 * remove the caller's own rows. The table itself stays service-role only
 * (RLS enabled, no user policies); scoping is enforced here.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18GetEvents(request, user);
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('debug_events')
    .select('id, created_at, service, level, event_type, status, message, metadata')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    return Response.json({ error: 'Failed to fetch debug events' }, { status: 500 });
  }
  return Response.json({ events: data ?? [] });
}

export async function DELETE(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18DeleteEvents(request, user);
  }

  const db = createServiceClient();
  const { error } = await db.from('debug_events').delete().eq('user_id', user.id);
  if (error) {
    return Response.json({ error: 'Failed to clear debug events' }, { status: 500 });
  }
  return Response.json({ success: true });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// PD-1 CONSERVATIVE DEFAULT: workspace mode keeps PER-USER scoping for
// debug events. A workspace member sees ONLY their own debug events,
// even inside a workspace they share with others — workspace membership
// is verified (a non-member gets nothing), but it does NOT widen event
// visibility to other members' events, and no workspace_id filter is
// applied that could do so. debug_events is deliberately NOT a tenant
// repository table (service-role-only system table), so the query here
// is the legacy per-user query, gated by the workspace resolution.
// Any workspace-wide log view requires the owner's PD-1 decision.
// DELETE additionally requires the 'write' capability (member+), still
// restricted to the caller's own rows.
function p18Selector(request: Request): string | null {
  const header = request.headers.get('x-workspace-id');
  if (header && header.trim().length > 0) return header;
  return new URL(request.url).searchParams.get('workspace');
}

async function p18GetEvents(
  request: Request,
  user: { id: string },
): Promise<Response> {
  const db = createServiceClient();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, p18Selector(request));
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }

  // Per-user filter retained verbatim (PD-1): NOT widened by workspace.
  const { data, error } = await db
    .from('debug_events')
    .select('id, created_at, service, level, event_type, status, message, metadata')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    return Response.json({ error: 'Failed to fetch debug events' }, { status: 500 });
  }
  return Response.json({ events: data ?? [] });
}

async function p18DeleteEvents(
  request: Request,
  user: { id: string },
): Promise<Response> {
  const db = createServiceClient();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, p18Selector(request));
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  try {
    requireCapability(resolved.ctx, 'write');
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return Response.json({ error: err.message, code: err.code }, { status: 403 });
    }
    return Response.json({ error: 'Workspace authorization failed' }, { status: 500 });
  }

  // Per-user filter retained verbatim (PD-1): only the caller's own rows.
  const { error } = await db.from('debug_events').delete().eq('user_id', user.id);
  if (error) {
    return Response.json({ error: 'Failed to clear debug events' }, { status: 500 });
  }
  return Response.json({ success: true });
}
