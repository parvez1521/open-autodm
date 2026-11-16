/**
 * GET /api/contacts/export - CSV download of the caller's own
 * captured contacts (owner decision, 2026-11-17). Backup/list
 * only: there is deliberately no bulk-DM / outreach action built
 * on top of it — Meta forbids cold-DMing exported contacts.
 *
 * Same auth + tenancy discipline as GET /api/contacts: the caller
 * sees only their own accounts' contacts (workspace mode: only
 * the selected workspace's rows, fail closed without a workspace
 * context). Unlike the list route (500-row cap), the export pages
 * through ALL rows — a capped export would silently truncate the
 * backup, so the page loop runs until a short page arrives.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository, applyTenantScope } from '@/lib/tenancy/repository';
import { withTransientQueryRetry } from '@/lib/supabase/queryRetry';
import { contactsToCsv, contactsExportFilename, type ContactExportRow } from '@/lib/contacts/exportCsv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:contacts:export');

/** PostgREST page size for the export loop (real client default). */
const EXPORT_PAGE_SIZE = 1000;

/** Columns the export selects — exactly the CSV columns, no more. */
const EXPORT_COLUMNS =
  'username, audience_ig_user_id, follows_business, first_interaction_at, last_interaction_at, last_trigger_type, total_triggers';

function csvResponse(rows: ContactExportRow[]): Response {
  return new Response(contactsToCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${contactsExportFilename()}"`,
    },
  });
}

/**
 * Drive a page fetcher until a short page arrives. The fetcher
 * builds a FRESH query per attempt (a supabase-js builder must
 * never be awaited twice), and each page rides ONE bounded retry
 * on transient PostgREST errors — the same discipline as the list
 * route's legs.
 */
async function fetchAllExportRows(
  fetchPage: (from: number, to: number) => Promise<ContactExportRow[]>,
): Promise<ContactExportRow[]> {
  const rows: ContactExportRow[] = [];
  let from = 0;
  for (;;) {
    const page = await fetchPage(from, from + EXPORT_PAGE_SIZE - 1);
    rows.push(...page);
    if (page.length < EXPORT_PAGE_SIZE) break;
    from += EXPORT_PAGE_SIZE;
  }
  return rows;
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18ExportContacts(request, user);
  }

  const db = createServiceClient();

  // Resolve the user's accounts first, then export their contacts.
  let accounts: { id: string }[] | null;
  try {
    accounts = await withTransientQueryRetry('api:contacts:export:accounts', async () => {
      const { data, error } = await db
        .from('instagram_accounts')
        .select('id, username')
        .eq('user_id', user.id);
      if (error) throw error;
      return data;
    });
  } catch (accountsError) {
    logger.error(
      { err: accountsError, userId: user.id },
      'Failed to fetch accounts for contacts export',
    );
    return Response.json({ error: 'Failed to export contacts' }, { status: 500 });
  }

  const accountIds = (accounts ?? []).map((a) => a.id as string);
  if (accountIds.length === 0) {
    return csvResponse([]);
  }

  // Optional per-account scoping. SECURITY: the requested id must be one of
  // the authenticated user's own accounts - anything else is a 404.
  const requestedAccountId = new URL(request.url).searchParams.get('accountId');
  let scopedIds = accountIds;
  if (requestedAccountId) {
    if (!accountIds.includes(requestedAccountId)) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
    scopedIds = [requestedAccountId];
  }

  let rows: ContactExportRow[];
  try {
    rows = await fetchAllExportRows((from, to) =>
      withTransientQueryRetry('api:contacts:export:page', async () => {
        const { data, error } = await db
          .from('contacts')
          .select(EXPORT_COLUMNS)
          .in('instagram_account_id', scopedIds)
          .order('last_interaction_at', { ascending: false })
          .range(from, to);
        if (error) throw error;
        return (data ?? []) as ContactExportRow[];
      }),
    );
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to export contacts');
    return Response.json({ error: 'Failed to export contacts' }, { status: 500 });
  }
  logger.debug({ userId: user.id, rows: rows.length }, 'Exported contacts');
  return csvResponse(rows);
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Same selector convention and fail-closed resolution as the list
// route. Reads go through the tenant scope primitive
// (applyTenantScope) — the repository's list() has no paging API,
// and the export must page through every row, so the scope is
// applied to a ranged query here instead of via the accessor.
// The scope is identical either way: only rows stamped with
// ctx.workspaceId can surface.
async function p18ExportContacts(
  request: Request,
  user: { id: string },
): Promise<Response> {
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
  const repo = createTenantRepository(db, resolved.ctx, 'read');

  const requestedAccountId = new URL(request.url).searchParams.get('accountId');
  if (requestedAccountId) {
    // The account must be bound to THIS workspace; foreign/unbound ⇒ 404.
    let account: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
    try {
      account = await repo.instagramAccounts.getByIdInWorkspace(requestedAccountId);
    } catch {
      account = null;
    }
    if (!account) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
  }

  let rows: ContactExportRow[];
  try {
    rows = await fetchAllExportRows((from, to) =>
      withTransientQueryRetry('api:contacts:export:page', async () => {
        const query = applyTenantScope(db.from('contacts').select(EXPORT_COLUMNS), resolved.ctx);
        if (requestedAccountId) query.eq('instagram_account_id', requestedAccountId);
        const { data, error } = await query
          .order('last_interaction_at', { ascending: false })
          .range(from, to);
        if (error) throw error;
        return (data ?? []) as ContactExportRow[];
      }),
    );
  } catch (err) {
    logger.error(
      { err, userId: user.id },
      'Failed to export contacts (workspace mode)',
    );
    return Response.json({ error: 'Failed to export contacts' }, { status: 500 });
  }
  logger.debug({ userId: user.id, rows: rows.length }, 'Exported contacts (workspace mode)');
  return csvResponse(rows);
}
