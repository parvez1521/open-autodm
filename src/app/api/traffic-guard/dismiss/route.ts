import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { markNotificationRead } from '@/lib/trafficGuard/tracker';
import { createServiceClient } from '@/lib/supabase/service';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DismissSchema = z.object({
  notificationId: z.string().uuid(),
});

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Dismiss(request, user);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = DismissSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const { notificationId } = parsed.data;

  try {
    await markNotificationRead(notificationId, user.id);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to dismiss notification' },
      { status: 500 }
    );
  }
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). Dismiss is a READ-STATE action at
// member level: it requires the 'write' capability (member+; a viewer
// cannot dismiss) and gains NO platform privilege — the underlying
// markNotificationRead update stays filtered by the caller's own
// user_id exactly as in legacy mode, so a member can only ever mark
// their OWN notifications read. Before that, the notification must
// belong to the ctx workspace (repository getByIdInWorkspace on
// traffic_guard_notifications; foreign/unbound ⇒ 404, nothing marked).
async function p18Dismiss(
  request: Request,
  user: { id: string },
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = DismissSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }
  const { notificationId } = parsed.data;

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
  try {
    requireCapability(resolved.ctx, 'write');
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return Response.json({ error: err.message, code: err.code }, { status: 403 });
    }
    return Response.json({ error: 'Workspace authorization failed' }, { status: 500 });
  }
  const repo = createTenantRepository(db, resolved.ctx, 'read');

  let notification: Awaited<ReturnType<typeof repo.trafficGuardNotifications.getByIdInWorkspace>> = null;
  try {
    notification = await repo.trafficGuardNotifications.getByIdInWorkspace(notificationId);
  } catch {
    notification = null;
  }
  if (!notification) {
    return Response.json({ error: 'Notification not found' }, { status: 404 });
  }

  try {
    await markNotificationRead(notificationId, user.id);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to dismiss notification' },
      { status: 500 }
    );
  }
}
