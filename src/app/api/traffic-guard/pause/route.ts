import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { pauseAccountAutomations } from '@/lib/trafficGuard/tracker';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PauseSchema = z.object({
  accountId: z.string().uuid(),
  incidentId: z.string().uuid(),
});

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Pause(request, user);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = PauseSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const { accountId, incidentId } = parsed.data;

  const db = createServiceClient();
  const { data: account, error } = await db
    .from('instagram_accounts')
    .select('id, user_id')
    .eq('id', accountId)
    .single();

  if (error || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  if (account.user_id !== user.id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Validate the incident/account pair before invoking the privileged pause RPC.
  // The SQL function repeats this check so direct backend calls also fail closed.
  const { data: incident, error: incidentError } = await db
    .from('comment_traffic_incidents')
    .select('id')
    .eq('id', incidentId)
    .eq('instagram_account_id', accountId)
    .single();

  if (incidentError || !incident) {
    return Response.json({ error: 'Traffic Guard incident not found for this account' }, { status: 404 });
  }

  try {
    const result = await pauseAccountAutomations(accountId, incidentId);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to pause account automations' },
      { status: 500 }
    );
  }
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// PD-4 interim rule (Phase B role matrix §3.2): pause is a routine
// operation at member+ — the 'write' capability — pending the owner's
// PD-4 decision on whether halting all automations on an account should
// be elevated to admin+. BOTH verifications run before the privileged
// pause RPC: (1) workspace membership + capability, and (2) account
// ownership in workspace terms — the account bound to the ctx workspace
// (repository getByIdInWorkspace; foreign/unbound ⇒ 404). The legacy
// incident↔account pair validation is preserved, additionally scoped
// to the ctx workspace (a direct scoped query, because the pair check
// is a composite the repository's single-row assert cannot express on
// its own; the query filters on the server-derived ctx.workspaceId,
// never a client value).
async function p18Pause(
  request: Request,
  user: { id: string },
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = PauseSchema.safeParse(body);
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

  const { data: incident, error: incidentError } = await db
    .from('comment_traffic_incidents')
    .select('id')
    .eq('id', incidentId)
    .eq('instagram_account_id', accountId)
    .eq('workspace_id', ctx.workspaceId)
    .single();
  if (incidentError || !incident) {
    return Response.json({ error: 'Traffic Guard incident not found for this account' }, { status: 404 });
  }

  try {
    const result = await pauseAccountAutomations(accountId, incidentId);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to pause account automations' },
      { status: 500 }
    );
  }
}
