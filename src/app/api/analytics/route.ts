/**
 * GET /api/analytics?from=ISO&to=ISO&automationId=<uuid|all>
 *
 * Aggregates the engine's own event trail into dashboard metrics:
 *  - dm_jobs            → triggers by type, deliveries, failures (time series)
 *  - automation_sessions → button-flow starts/completions + follows gained
 *                          (a session that reached the ask-to-follow card AND
 *                          completed means the follow re-check passed)
 *  - contacts           → new contacts captured + their follow status
 *
 * All scoping is by the authenticated user's Instagram accounts; the optional
 * automation filter narrows every source. Aggregation happens here in JS -
 * at self-hosted scale the row counts are small (guarded by hard limits).
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:analytics');

const ROW_LIMIT = 20000;
const MAX_DAYS = 400;

interface JobRow {
  trigger_type: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  automation_id: string;
}

interface SessionRow {
  automation_id: string;
  current_step: number;
  completed: boolean;
  started_at: string;
}

interface ContactRow {
  first_interaction_at: string;
  follows_business: boolean | null;
  last_automation_id: string | null;
}

interface AutomationMeta {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  instagram_account_id: string;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Analytics(request, user);
  }

  const url = new URL(request.url);
  const toParam = url.searchParams.get('to');
  const fromParam = url.searchParams.get('from');
  const automationId = url.searchParams.get('automationId') ?? 'all';
  const requestedAccountId = url.searchParams.get('accountId');

  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 86400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return Response.json({ error: 'Invalid date range' }, { status: 400 });
  }
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

  // Optional per-account scoping. SECURITY: the id must be user-owned.
  let accountIds = ownedIds;
  if (requestedAccountId) {
    if (!ownedIds.includes(requestedAccountId)) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
    accountIds = [requestedAccountId];
  }

  const { data: automations } = await db
    .from('automations')
    .select('id, name, type, is_active, instagram_account_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  const automationMeta = ((automations ?? []) as AutomationMeta[]).filter(
    (a) => !requestedAccountId || a.instagram_account_id === requestedAccountId
  );

  const empty = accountIds.length === 0;

  let jobsQ = db
    .from('dm_jobs')
    .select('trigger_type, status, created_at, sent_at, automation_id')
    .in('instagram_account_id', accountIds)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .limit(ROW_LIMIT);
  if (automationId !== 'all') jobsQ = jobsQ.eq('automation_id', automationId);

  let sessionsQ = db
    .from('automation_sessions')
    .select('automation_id, current_step, completed, started_at')
    .in('instagram_account_id', accountIds)
    .gte('started_at', fromIso)
    .lte('started_at', toIso)
    .limit(ROW_LIMIT);
  if (automationId !== 'all') sessionsQ = sessionsQ.eq('automation_id', automationId);

  let contactsQ = db
    .from('contacts')
    .select('first_interaction_at, follows_business, last_automation_id')
    .in('instagram_account_id', accountIds)
    .gte('first_interaction_at', fromIso)
    .lte('first_interaction_at', toIso)
    .limit(ROW_LIMIT);
  if (automationId !== 'all') contactsQ = contactsQ.eq('last_automation_id', automationId);

  const [jobsRes, sessionsRes, contactsRes] = empty
    ? [{ data: [] }, { data: [] }, { data: [] }]
    : await Promise.all([jobsQ, sessionsQ, contactsQ]);

  const jobs = ((jobsRes.data ?? []) as JobRow[]);
  const sessions = ((sessionsRes.data ?? []) as SessionRow[]);
  const contacts = ((contactsRes.data ?? []) as ContactRow[]);

  // ── Totals ────────────────────────────────────────────────────────────────
  const triggerTypes = ['comment', 'dm', 'story_reply'];
  const totals = {
    triggers: jobs.filter((j) => triggerTypes.includes(j.trigger_type)).length,
    comments: jobs.filter((j) => j.trigger_type === 'comment').length,
    dmKeywords: jobs.filter((j) => j.trigger_type === 'dm').length,
    storyReplies: jobs.filter((j) => j.trigger_type === 'story_reply').length,
    delivered: jobs.filter((j) => j.status === 'sent').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    flowsStarted: sessions.length,
    flowsCompleted: sessions.filter((s) => s.completed).length,
    askToFollowShown: sessions.filter((s) => s.current_step >= 2).length,
    followsGained: sessions.filter((s) => s.current_step >= 2 && s.completed).length,
    newContacts: contacts.length,
    newContactFollowers: contacts.filter((c) => c.follows_business === true).length,
  };

  // ── Daily series (zero-filled across the range) ───────────────────────────
  const days: Record<string, { date: string; comments: number; dms: number; stories: number; delivered: number; contacts: number }> = {};
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  let guard = 0;
  while (cursor <= end && guard < MAX_DAYS) {
    const key = cursor.toISOString().slice(0, 10);
    days[key] = { date: key, comments: 0, dms: 0, stories: 0, delivered: 0, contacts: 0 };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  for (const j of jobs) {
    const d = days[dayKey(j.created_at)];
    if (!d) continue;
    if (j.trigger_type === 'comment') d.comments += 1;
    else if (j.trigger_type === 'dm') d.dms += 1;
    else if (j.trigger_type === 'story_reply') d.stories += 1;
    if (j.status === 'sent') {
      const sd = days[dayKey(j.sent_at ?? j.created_at)];
      if (sd) sd.delivered += 1;
    }
  }
  for (const c of contacts) {
    const d = days[dayKey(c.first_interaction_at)];
    if (d) d.contacts += 1;
  }

  // ── Per-automation breakdown ──────────────────────────────────────────────
  const byAutomation = new Map<string, { triggers: number; delivered: number; failed: number; flowsCompleted: number; follows: number }>();
  for (const j of jobs) {
    const row = byAutomation.get(j.automation_id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 };
    if (triggerTypes.includes(j.trigger_type)) row.triggers += 1;
    if (j.status === 'sent') row.delivered += 1;
    if (j.status === 'failed') row.failed += 1;
    byAutomation.set(j.automation_id, row);
  }
  for (const s of sessions) {
    const row = byAutomation.get(s.automation_id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 };
    if (s.completed) row.flowsCompleted += 1;
    if (s.current_step >= 2 && s.completed) row.follows += 1;
    byAutomation.set(s.automation_id, row);
  }

  const perAutomation = automationMeta
    .filter((a) => automationId === 'all' || a.id === automationId)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      isActive: a.is_active,
      ...(byAutomation.get(a.id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 }),
    }))
    .sort((a, b) => b.triggers - a.triggers);

  return Response.json({
    range: { from: fromIso, to: toIso },
    totals,
    daily: Object.values(days),
    perAutomation,
    automations: automationMeta.map((a) => ({ id: a.id, name: a.name, type: a.type })),
    truncated: jobs.length >= ROW_LIMIT || sessions.length >= ROW_LIMIT || contacts.length >= ROW_LIMIT,
  });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// Scoping order is load-bearing: FIRST the ctx workspace (repository
// account/automation lists + a workspace_id filter on every aggregate
// query), THEN the caller's accountId/automationId filters inside that
// scope. A foreign automation/account id therefore can never widen the
// result — it resolves to 404 before any aggregate runs.
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
  const toParam = url.searchParams.get('to');
  const fromParam = url.searchParams.get('from');
  const automationId = url.searchParams.get('automationId') ?? 'all';
  const requestedAccountId = url.searchParams.get('accountId');

  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 86400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return Response.json({ error: 'Invalid date range' }, { status: 400 });
  }
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

  let accountIds = ownedIds;
  if (requestedAccountId) {
    if (!ownedIds.includes(requestedAccountId)) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
    accountIds = [requestedAccountId];
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

  const automationMeta = (workspaceAutomations as unknown as AutomationMeta[]).filter(
    (a) => !requestedAccountId || a.instagram_account_id === requestedAccountId,
  );

  const inRange = (iso: unknown): boolean =>
    typeof iso === 'string' && iso >= fromIso && iso <= toIso;
  const empty = accountIds.length === 0;

  let jobs: JobRow[] = [];
  let sessions: SessionRow[] = [];
  let contacts: ContactRow[] = [];
  if (!empty) {
    const [jobsRes, sessionsRes, contactsRes] = await Promise.all([
      db
        .from('dm_jobs')
        .select('trigger_type, status, created_at, sent_at, automation_id')
        .eq('workspace_id', ctx.workspaceId)
        .in('instagram_account_id', accountIds)
        .limit(ROW_LIMIT),
      db
        .from('automation_sessions')
        .select('automation_id, current_step, completed, started_at')
        .eq('workspace_id', ctx.workspaceId)
        .in('instagram_account_id', accountIds)
        .limit(ROW_LIMIT),
      db
        .from('contacts')
        .select('first_interaction_at, follows_business, last_automation_id')
        .eq('workspace_id', ctx.workspaceId)
        .in('instagram_account_id', accountIds)
        .limit(ROW_LIMIT),
    ]);
    jobs = ((jobsRes.data ?? []) as JobRow[]).filter(
      (j) => inRange(j.created_at) && (automationId === 'all' || j.automation_id === automationId),
    );
    sessions = ((sessionsRes.data ?? []) as SessionRow[]).filter(
      (s) => inRange(s.started_at) && (automationId === 'all' || s.automation_id === automationId),
    );
    contacts = ((contactsRes.data ?? []) as ContactRow[]).filter(
      (c) =>
        inRange(c.first_interaction_at) &&
        (automationId === 'all' || c.last_automation_id === automationId),
    );
  }

  const triggerTypes = ['comment', 'dm', 'story_reply'];
  const totals = {
    triggers: jobs.filter((j) => triggerTypes.includes(j.trigger_type)).length,
    comments: jobs.filter((j) => j.trigger_type === 'comment').length,
    dmKeywords: jobs.filter((j) => j.trigger_type === 'dm').length,
    storyReplies: jobs.filter((j) => j.trigger_type === 'story_reply').length,
    delivered: jobs.filter((j) => j.status === 'sent').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    flowsStarted: sessions.length,
    flowsCompleted: sessions.filter((s) => s.completed).length,
    askToFollowShown: sessions.filter((s) => s.current_step >= 2).length,
    followsGained: sessions.filter((s) => s.current_step >= 2 && s.completed).length,
    newContacts: contacts.length,
    newContactFollowers: contacts.filter((c) => c.follows_business === true).length,
  };

  const days: Record<string, { date: string; comments: number; dms: number; stories: number; delivered: number; contacts: number }> = {};
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  let guard = 0;
  while (cursor <= end && guard < MAX_DAYS) {
    const key = cursor.toISOString().slice(0, 10);
    days[key] = { date: key, comments: 0, dms: 0, stories: 0, delivered: 0, contacts: 0 };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  for (const j of jobs) {
    const d = days[dayKey(j.created_at)];
    if (!d) continue;
    if (j.trigger_type === 'comment') d.comments += 1;
    else if (j.trigger_type === 'dm') d.dms += 1;
    else if (j.trigger_type === 'story_reply') d.stories += 1;
    if (j.status === 'sent') {
      const sd = days[dayKey(j.sent_at ?? j.created_at)];
      if (sd) sd.delivered += 1;
    }
  }
  for (const c of contacts) {
    const d = days[dayKey(c.first_interaction_at)];
    if (d) d.contacts += 1;
  }

  const byAutomation = new Map<string, { triggers: number; delivered: number; failed: number; flowsCompleted: number; follows: number }>();
  for (const j of jobs) {
    const row = byAutomation.get(j.automation_id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 };
    if (triggerTypes.includes(j.trigger_type)) row.triggers += 1;
    if (j.status === 'sent') row.delivered += 1;
    if (j.status === 'failed') row.failed += 1;
    byAutomation.set(j.automation_id, row);
  }
  for (const s of sessions) {
    const row = byAutomation.get(s.automation_id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 };
    if (s.completed) row.flowsCompleted += 1;
    if (s.current_step >= 2 && s.completed) row.follows += 1;
    byAutomation.set(s.automation_id, row);
  }

  const perAutomation = automationMeta
    .filter((a) => automationId === 'all' || a.id === automationId)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      isActive: a.is_active,
      ...(byAutomation.get(a.id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 }),
    }))
    .sort((a, b) => b.triggers - a.triggers);

  return Response.json({
    range: { from: fromIso, to: toIso },
    totals,
    daily: Object.values(days),
    perAutomation,
    automations: automationMeta.map((a) => ({ id: a.id, name: a.name, type: a.type })),
    truncated: jobs.length >= ROW_LIMIT || sessions.length >= ROW_LIMIT || contacts.length >= ROW_LIMIT,
  });
}
