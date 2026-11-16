/**
 * GET /api/leads - lead submissions captured by lead-form responses.
 *
 * Lists the email/phone values audience members submitted in reply to a
 * lead-form ask. Scoped to the authenticated user's (workspace's)
 * automations: the owner can see leads for their own automations only.
 * Optional ?automation_id= narrows to one automation; ?account_id=
 * narrows to one Instagram account. Values are never sent anywhere from
 * here — this is a read-only view of what people voluntarily typed in a DM.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { withTransientQueryRetry } from '@/lib/supabase/queryRetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:leads');
const PAGE_SIZE = 100;

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18ListLeads(request, user);
  }

  const db = createServiceClient();
  const { searchParams } = new URL(request.url);
  const automationId = searchParams.get('automation_id') ?? undefined;
  const accountId = searchParams.get('account_id') ?? undefined;

  // Automations belonging to this user — the visibility boundary.
  let automationRows: { id: string; name: string; instagram_account_id: string }[] | null;
  try {
    automationRows = await withTransientQueryRetry('api:leads:automations', async () => {
      const { data, error } = await db
        .from('automations')
        .select('id, name, instagram_account_id')
        .eq('user_id', user.id);
      if (error) throw error;
      return data as { id: string; name: string; instagram_account_id: string }[];
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to load automations for leads');
    return Response.json({ error: 'Failed to load leads' }, { status: 500 });
  }
  const leads = await listLeadsForAutomations(db, automationRows ?? [], automationId, accountId);
  if (leads === null) {
    return Response.json({ error: 'Failed to load leads' }, { status: 500 });
  }
  return Response.json({ leads });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Same list core as the legacy branch; only the automation visibility
// boundary differs (the tenant repository's workspace-scoped list).
async function p18ListLeads(request: Request, user: { id: string }): Promise<Response> {
  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0 ? header : new URL(request.url).searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  const repo = createTenantRepository(db, resolved.ctx, 'read');

  let automationRows: { id: string; name: string; instagram_account_id: string }[];
  try {
    const rows = await repo.automations.list({});
    automationRows = rows.map((r) => ({
      id: String(r['id']),
      name: String(r['name'] ?? 'Automation'),
      instagram_account_id: String(r['instagram_account_id'] ?? ''),
    }));
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to load automations for leads (workspace mode)');
    return Response.json({ error: 'Failed to load leads' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const automationId = searchParams.get('automation_id') ?? undefined;
  const accountId = searchParams.get('account_id') ?? undefined;
  const leads = await listLeadsForAutomations(db, automationRows, automationId, accountId);
  if (leads === null) {
    return Response.json({ error: 'Failed to load leads' }, { status: 500 });
  }
  return Response.json({ leads });
}

type LeadRow = {
  id: string;
  automationId: string;
  automationName: string;
  instagramAccountId: string;
  audienceIgUserId: string;
  username: string | null;
  field: 'email' | 'phone';
  value: string;
  submittedAt: string;
};

/** Shared list core: filter to the visible automations, then fetch + map. */
async function listLeadsForAutomations(
  db: ReturnType<typeof createServiceClient>,
  automationRows: { id: string; name: string; instagram_account_id: string }[],
  automationId: string | undefined,
  accountId: string | undefined,
): Promise<LeadRow[] | null> {
  const automationById = new Map(automationRows.map((a) => [a.id, a]));
  let visibleAutomationIds = [...automationById.keys()];
  if (automationId) {
    if (!automationById.has(automationId)) return [];
    visibleAutomationIds = [automationId];
  }
  if (accountId) {
    visibleAutomationIds = visibleAutomationIds.filter(
      (id) => automationById.get(id)?.instagram_account_id === accountId,
    );
  }
  if (visibleAutomationIds.length === 0) return [];

  let data: unknown[] | null;
  try {
    data = await withTransientQueryRetry('api:leads:list', async () => {
      const { data: rows, error } = await db
        .from('lead_submissions')
        .select('id, automation_id, instagram_account_id, audience_ig_user_id, username, field, value, submitted_at')
        .in('automation_id', visibleAutomationIds)
        .order('submitted_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      return rows;
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load lead submissions');
    return null;
  }

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r['id'] as string,
      automationId: r['automation_id'] as string,
      automationName: automationById.get(r['automation_id'] as string)?.name ?? 'Automation',
      instagramAccountId: r['instagram_account_id'] as string,
      audienceIgUserId: r['audience_ig_user_id'] as string,
      username: (r['username'] as string | null) ?? null,
      field: r['field'] as 'email' | 'phone',
      value: r['value'] as string,
      submittedAt: r['submitted_at'] as string,
    };
  });
}
