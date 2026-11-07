import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { resumeAccountAutomations } from '@/lib/trafficGuard/tracker';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ResumeSchema = z.object({
  accountId: z.string().uuid(),
  incidentId: z.string().uuid(),
});

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Resume(request, user);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ResumeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const { accountId, incidentId } = parsed.data;
  const db = createServiceClient();

  const { data: account, error: accountError } = await db
    .from('instagram_accounts')
    .select('id, user_id, traffic_guard_paused, traffic_guard_paused_incident_id')
    .eq('id', accountId)
    .single();

  if (accountError || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  if (account.user_id !== user.id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Resume the incident that owns the current pause, not necessarily the
  // latest traffic incident. A newer spike may arrive while this pause remains.
  if (
    account.traffic_guard_paused !== true ||
    account.traffic_guard_paused_incident_id !== incidentId
  ) {
    return Response.json(
      { error: 'This incident is no longer the active paused incident' },
      { status: 409 }
    );
  }

  const { data: incident, error: incidentError } = await db
    .from('comment_traffic_incidents')
    .select('id, paused_at, resumed_at')
    .eq('id', incidentId)
    .eq('instagram_account_id', accountId)
    .single();

  if (
    incidentError ||
    !incident ||
    !incident.paused_at ||
    incident.resumed_at
  ) {
    return Response.json(
      { error: 'This incident is not awaiting resumption' },
      { status: 409 }
    );
  }

  try {
    const result = await resumeAccountAutomations(accountId, incidentId);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resume account automations';
    const isConflict = /incident|paused/i.test(message);
    return Response.json({ error: message }, { status: isConflict ? 409 : 500 });
  }
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// PD-4 interim rule (Phase B role matrix §3.2): resume is a routine
// operation at member+ — the 'write' capability — pending the owner's
// PD-4 decision. BOTH verifications run before the privileged resume
// RPC: (1) workspace membership + capability, and (2) account ownership
// in workspace terms — the account bound to the ctx workspace, loaded
// through the repository's getByIdInWorkspace (foreign/unbound ⇒ 404;
// the loaded row also carries the pause state, so the legacy 409
// stale-incident semantics are preserved verbatim). The incident check
// is a direct query scoped to the ctx workspace in addition to the
// legacy incident↔account pair (composite check; filter value is the
// server-derived ctx.workspaceId, never a client value).
async function p18Resume(
  request: Request,
  user: { id: string },
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = ResumeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }
  const { accountId, incidentId } = parsed.data;

  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0
      ? header
      : new URL(request.url).searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  const ctx = resolved.ctx;
  try {
    requireCapability(ctx, 'write');
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return Response.json({ error: err.message, code: err.code }, { status: 403 });
    }
    return Response.json({ error: 'Workspace authorization failed' }, { status: 500 });
  }
  const repo = createTenantRepository(db, ctx, 'read');

  let account: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  try {
    account = await repo.instagramAccounts.getByIdInWorkspace(accountId);
  } catch {
    account = null;
  }
  if (!account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  if (
    account['traffic_guard_paused'] !== true ||
    account['traffic_guard_paused_incident_id'] !== incidentId
  ) {
    return Response.json(
      { error: 'This incident is no longer the active paused incident' },
      { status: 409 }
    );
  }

  const { data: incident, error: incidentError } = await db
    .from('comment_traffic_incidents')
    .select('id, paused_at, resumed_at')
    .eq('id', incidentId)
    .eq('instagram_account_id', accountId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (
    incidentError ||
    !incident ||
    !incident.paused_at ||
    incident.resumed_at
  ) {
    return Response.json(
      { error: 'This incident is not awaiting resumption' },
      { status: 409 }
    );
  }

  try {
    const result = await resumeAccountAutomations(accountId, incidentId);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resume account automations';
    const isConflict = /incident|paused/i.test(message);
    return Response.json({ error: message }, { status: isConflict ? 409 : 500 });
  }
}
