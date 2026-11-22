/**
 * GET /api/analytics?from=ISO&to=ISO&automationId=<uuid|all>&channel=<instagram|facebook|all>&accountId=<uuid>
 *
 * Aggregates the engine's own event trail into dashboard metrics:
 *  - dm_jobs            → triggers by type, deliveries, failures (time series)
 *  - automation_sessions → button-flow starts/completions + follows gained
 *                          (a session that reached the ask-to-follow card AND
 *                          completed means the follow re-check passed)
 *  - contacts           → new contacts captured + their follow status
 *
 * Channel (2026-11-22): Instagram and Facebook rows live in the same
 * tables but under different account columns — Instagram rows key on
 * instagram_account_id, Facebook rows on facebook_page_id (both
 * instagram_account_id NULL on the FB side, see migration
 * 20261119000001). The `channel` param scopes every source to one
 * channel's rows; `all` (the default, for older callers) merges both.
 * Before this, the route only ever read instagram_account_id, so
 * Facebook activity was invisible here entirely — the Facebook tab
 * of /analytics now shows the real Messenger numbers.
 * The aggregation itself lives in src/lib/analytics/aggregate.ts and
 * is shared by both branches, so the metric definitions cannot drift.
 *
 * All scoping is by the authenticated user's Instagram accounts and
 * Facebook Pages; the optional automation filter narrows every source.
 * Aggregation happens in JS over the channel-scoped rows — at
 * self-hosted scale the row counts are small (guarded by hard limits).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import {
  aggregateAnalytics,
  ANALYTICS_ROW_LIMIT,
  type AnalyticsAutomationMeta,
  type AnalyticsContactRow,
  type AnalyticsJobRow,
  type AnalyticsSessionRow,
} from '@/lib/analytics/aggregate';
import {
  filterMetaByChannel,
  parseAnalyticsChannel,
  type AnalyticsChannel,
} from '@/lib/analytics/channel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:analytics');

interface AnalyticsParams {
  from: Date;
  to: Date;
  automationId: string;
  requestedAccountId: string | null;
  channel: AnalyticsChannel;
}

function parseAnalyticsParams(url: URL): { params: AnalyticsParams | null; error: string | null } {
  const toParam = url.searchParams.get('to');
  const fromParam = url.searchParams.get('from');
  const automationId = url.searchParams.get('automationId') ?? 'all';
  const requestedAccountId = url.searchParams.get('accountId');
  const channel = parseAnalyticsChannel(url.searchParams.get('channel'));
  if (channel === null) {
    return { params: null, error: 'Invalid channel — expected instagram, facebook or all' };
  }
  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 86400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return { params: null, error: 'Invalid date range' };
  }
  return { params: { from, to, automationId, requestedAccountId, channel }, error: null };
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Analytics(request, user);
  }

  const url = new URL(request.url);
  const { params, error } = parseAnalyticsParams(url);
  if (!params) return Response.json({ error }, { status: 400 });
  const { from, to, automationId, requestedAccountId, channel } = params;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const db = createServiceClient();

  const { data: accounts, error: accErr } = await db
    .from('instagram_accounts')
    .select('id')
    .eq('user_id', user.id);
  if (accErr) {
    logger.error({ err: accErr }, 'Failed to fetch accounts');
    return Response.json({ error: 'Failed to load analytics' }, { status: 500 });
  }
  const ownedIds = (accounts ?? []).map((a) => a.id as string);

  // Facebook Pages owned by this user (channel scoping, 2026-11-22).
  const { data: fbPages } = await db
    .from('facebook_pages')
    .select('id')
    .eq('user_id', user.id);
  const ownedFbPageIds = (fbPages ?? []).map((p) => p.id as string);

  // Optional per-account scoping. SECURITY: the id must be user-owned.
  // The id may be an Instagram account OR a Facebook Page row id
  // (mirrors GET /api/automations).
  let requestedIsFacebook = false;
  if (requestedAccountId) {
    if (!ownedIds.includes(requestedAccountId)) {
      if (!ownedFbPageIds.includes(requestedAccountId)) {
        return Response.json({ error: 'Instagram account not found' }, { status: 404 });
      }
      requestedIsFacebook = true;
    }
  }

  // The account-column partition IS the channel partition: Instagram
  // rows key on instagram_account_id, Facebook rows on facebook_page_id.
  // A requested account narrows to that account alone; the channel
  // param narrows to that channel's side.
  let igScopeIds = requestedIsFacebook ? [] : requestedAccountId ? [requestedAccountId] : ownedIds;
  let fbScopeIds = requestedIsFacebook ? [requestedAccountId!] : requestedAccountId ? [] : ownedFbPageIds;
  if (channel === 'instagram') fbScopeIds = [];
  if (channel === 'facebook') igScopeIds = [];

  const { data: automations } = await db
    .from('automations')
    .select('id, name, type, is_active, instagram_account_id, channel, facebook_page_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  const automationMeta = filterMetaByChannel(
    ((automations ?? []) as AnalyticsAutomationMeta[]).filter((a) =>
      !requestedAccountId ||
      (requestedIsFacebook ? a.facebook_page_id === requestedAccountId : a.instagram_account_id === requestedAccountId),
    ),
    channel,
  );

  const empty = igScopeIds.length === 0 && fbScopeIds.length === 0;

  // One query per account column per source table: PostgREST has no
  // OR across columns here, and the two sides are disjoint by
  // construction. Date filters stay SQL-side (the ROW_LIMIT /
  // truncated semantics are unchanged: "first 20,000 events in range").
  const buildQueries = <T>(table: 'dm_jobs' | 'automation_sessions' | 'contacts') => {
    const queries: Array<PromiseLike<{ data: T[] | null; error: unknown }>> = [];
    const columns =
      table === 'dm_jobs'
        ? 'trigger_type, status, created_at, sent_at, automation_id'
        : table === 'automation_sessions'
          ? 'automation_id, current_step, completed, started_at'
          : 'first_interaction_at, follows_business, last_automation_id';
    const dateColumn =
      table === 'dm_jobs' ? 'created_at' : table === 'automation_sessions' ? 'started_at' : 'first_interaction_at';
    if (igScopeIds.length > 0) {
      let q = db
        .from(table)
        .select(columns)
        .in('instagram_account_id', igScopeIds)
        .gte(dateColumn, fromIso)
        .lte(dateColumn, toIso)
        .limit(ANALYTICS_ROW_LIMIT);
      if (table === 'contacts' && automationId !== 'all') q = q.eq('last_automation_id', automationId);
      else if (table !== 'contacts' && automationId !== 'all') q = q.eq('automation_id', automationId);
      queries.push(q as unknown as PromiseLike<{ data: T[] | null; error: unknown }>);
    }
    if (fbScopeIds.length > 0) {
      let q = db
        .from(table)
        .select(columns)
        .in('facebook_page_id', fbScopeIds)
        .gte(dateColumn, fromIso)
        .lte(dateColumn, toIso)
        .limit(ANALYTICS_ROW_LIMIT);
      if (table === 'contacts' && automationId !== 'all') q = q.eq('last_automation_id', automationId);
      else if (table !== 'contacts' && automationId !== 'all') q = q.eq('automation_id', automationId);
      queries.push(q as unknown as PromiseLike<{ data: T[] | null; error: unknown }>);
    }
    return queries;
  };

  const [jobsRes, sessionsRes, contactsRes] = empty
    ? [{ data: [] }, { data: [] }, { data: [] }]
    : await Promise.all([
        Promise.all(buildQueries<AnalyticsJobRow>('dm_jobs')).then((rs) => ({ data: rs.flatMap((r) => r.data ?? []) })),
        Promise.all(buildQueries<AnalyticsSessionRow>('automation_sessions')).then((rs) => ({ data: rs.flatMap((r) => r.data ?? []) })),
        Promise.all(buildQueries<AnalyticsContactRow>('contacts')).then((rs) => ({ data: rs.flatMap((r) => r.data ?? []) })),
      ]);

  const jobs = (jobsRes.data ?? []) as AnalyticsJobRow[];
  const sessions = (sessionsRes.data ?? []) as AnalyticsSessionRow[];
  const contacts = (contactsRes.data ?? []) as AnalyticsContactRow[];

  const aggregated = aggregateAnalytics({ jobs, sessions, contacts, automationMeta, automationId, from, to });
  return Response.json({
    range: { from: fromIso, to: toIso },
    channel,
    ...aggregated,
  });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// Scoping order is load-bearing: FIRST the ctx workspace (repository
// account/automation lists + a workspace_id filter on every aggregate
// query), THEN the caller's accountId/automationId/channel filters
// inside that scope. A foreign automation/account id therefore can
// never widen the result — it resolves to 404 before any aggregate runs.
//
// Repository-vs-direct justification: the tenant repository's list()
// supports equality filters only, while analytics needs date-range
// aggregation over dm_jobs / automation_sessions / contacts. The
// aggregate queries below are therefore direct queries scoped by
// ctx.workspaceId (never by a client-supplied workspace value) AND by
// the workspace's own account ids, with the date/automation narrowing
// applied in JS over that already-scoped set. Account and automation
// membership checks themselves DO go through the repository.
// This route has no response cache (force-dynamic, computed per
// request), so there is no cache key to make workspace-safe here; the
// one cached route in this family (instagram/posts) keys its cache by
// workspace in workspace mode.
async function p18Analytics(
  request: Request,
  user: { id: string },
): Promise<Response> {
  const url = new URL(request.url);
  const { params, error } = parseAnalyticsParams(url);
  if (!params) return Response.json({ error }, { status: 400 });
  const { from, to, automationId, requestedAccountId, channel } = params;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const db = createServiceClient();
  const header = request.headers.get('x-workspace-id');
  const selector =
    header && header.trim().length > 0 ? header : url.searchParams.get('workspace');
  const resolved = await resolveRouteWorkspaceContext(db, user.id, selector);
  if (!resolved.ok) {
    return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status });
  }
  const ctx = resolved.ctx;
  const repo = createTenantRepository(db, ctx, 'read');

  let workspaceAccounts: Awaited<ReturnType<typeof repo.instagramAccounts.list>>;
  let workspaceAutomations: Awaited<ReturnType<typeof repo.automations.list>>;
  try {
    workspaceAccounts = await repo.instagramAccounts.list();
    workspaceAutomations = await repo.automations.list();
  } catch (err) {
    logger.error({ err }, 'Failed to fetch workspace scope for analytics');
    return Response.json({ error: 'Failed to load analytics' }, { status: 500 });
  }
  const ownedIds = workspaceAccounts.map((a) => a['id'] as string);

  // Facebook Pages bound to this workspace (direct query — the tenant
  // repository has no facebookPages accessor yet; same pattern as the
  // automations list route).
  const { data: fbPages } = await db
    .from('facebook_pages')
    .select('id')
    .eq('workspace_id', ctx.workspaceId);
  const ownedFbPageIds = (fbPages ?? []).map((p) => p['id'] as string);

  // Optional per-account scoping: an Instagram account OR a Facebook
  // Page row id bound to THIS workspace (mirrors p18ListAutomations).
  let requestedIsFacebook = false;
  if (requestedAccountId) {
    if (!ownedIds.includes(requestedAccountId)) {
      const { data: fbPage } = await db
        .from('facebook_pages')
        .select('id')
        .eq('id', requestedAccountId)
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle();
      if (!fbPage) {
        return Response.json({ error: 'Instagram account not found' }, { status: 404 });
      }
      requestedIsFacebook = true;
    }
  }

  // Direct ownership check for the automation filter (closes the legacy
  // gap where automationId was only safe by intersection): a foreign or
  // unbound automation id is a 404, never a widening filter.
  if (automationId !== 'all') {
    let automation: Awaited<ReturnType<typeof repo.automations.getByIdInWorkspace>> = null;
    try {
      automation = await repo.automations.getByIdInWorkspace(automationId);
    } catch {
      automation = null;
    }
    if (!automation) {
      return Response.json({ error: 'Automation not found' }, { status: 404 });
    }
  }

  let igScopeIds = requestedIsFacebook ? [] : requestedAccountId ? [requestedAccountId] : ownedIds;
  let fbScopeIds = requestedIsFacebook ? [requestedAccountId!] : requestedAccountId ? [] : ownedFbPageIds;
  if (channel === 'instagram') fbScopeIds = [];
  if (channel === 'facebook') igScopeIds = [];

  const automationMeta = filterMetaByChannel(
    (workspaceAutomations as unknown as AnalyticsAutomationMeta[]).filter((a) =>
      !requestedAccountId ||
      (requestedIsFacebook ? a.facebook_page_id === requestedAccountId : a.instagram_account_id === requestedAccountId),
    ),
    channel,
  );

  const inRange = (iso: unknown): boolean =>
    typeof iso === 'string' && iso >= fromIso && iso <= toIso;
  const empty = igScopeIds.length === 0 && fbScopeIds.length === 0;

  let jobs: AnalyticsJobRow[] = [];
  let sessions: AnalyticsSessionRow[] = [];
  let contacts: AnalyticsContactRow[] = [];
  if (!empty) {
    const fetchSide = async (
      table: 'dm_jobs' | 'automation_sessions' | 'contacts',
      accountColumn: 'instagram_account_id' | 'facebook_page_id',
      accountIds: string[],
    ) => {
      const columns =
        table === 'dm_jobs'
          ? 'trigger_type, status, created_at, sent_at, automation_id'
          : table === 'automation_sessions'
            ? 'automation_id, current_step, completed, started_at'
            : 'first_interaction_at, follows_business, last_automation_id';
      const { data } = await db
        .from(table)
        .select(columns)
        .eq('workspace_id', ctx.workspaceId)
        .in(accountColumn, accountIds)
        .limit(ANALYTICS_ROW_LIMIT);
      return (data ?? []) as unknown as Array<Record<string, unknown>>;
    };
    const [jobsIg, jobsFb, sessionsIg, sessionsFb, contactsIg, contactsFb] = await Promise.all([
      igScopeIds.length > 0 ? fetchSide('dm_jobs', 'instagram_account_id', igScopeIds) : Promise.resolve([]),
      fbScopeIds.length > 0 ? fetchSide('dm_jobs', 'facebook_page_id', fbScopeIds) : Promise.resolve([]),
      igScopeIds.length > 0 ? fetchSide('automation_sessions', 'instagram_account_id', igScopeIds) : Promise.resolve([]),
      fbScopeIds.length > 0 ? fetchSide('automation_sessions', 'facebook_page_id', fbScopeIds) : Promise.resolve([]),
      igScopeIds.length > 0 ? fetchSide('contacts', 'instagram_account_id', igScopeIds) : Promise.resolve([]),
      fbScopeIds.length > 0 ? fetchSide('contacts', 'facebook_page_id', fbScopeIds) : Promise.resolve([]),
    ]);
    jobs = [...jobsIg, ...jobsFb].filter(
      (j) => inRange(j['created_at']) && (automationId === 'all' || j['automation_id'] === automationId),
    ) as unknown as AnalyticsJobRow[];
    sessions = [...sessionsIg, ...sessionsFb].filter(
      (s) => inRange(s['started_at']) && (automationId === 'all' || s['automation_id'] === automationId),
    ) as unknown as AnalyticsSessionRow[];
    contacts = [...contactsIg, ...contactsFb].filter(
      (c) =>
        inRange(c['first_interaction_at']) &&
        (automationId === 'all' || c['last_automation_id'] === automationId),
    ) as unknown as AnalyticsContactRow[];
  }

  const aggregated = aggregateAnalytics({ jobs, sessions, contacts, automationMeta, automationId, from, to });
  return Response.json({
    range: { from: fromIso, to: toIso },
    channel,
    ...aggregated,
  });
}
