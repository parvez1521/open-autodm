/**
 * GET /api/activity?accountId=<id>&limit=25
 *
 * Authenticated endpoint returning real recent automation activity:
 *  - DM jobs: sent, failed, skipped, processing
 *  - Follow-up check-in states: scheduled, waiting_response, sent, held, expired
 *
 * Scoped strictly to the authenticated owner's connected Instagram accounts
 * and Facebook Pages. Message content is sanitized to prevent private
 * conversation exposure.
 *
 * Ported verbatim from release-prep (Phase 5, row 22). Owner scoping: the
 * caller's own instagram_accounts are loaded first and every query is
 * restricted to those account ids; an explicitly requested accountId that
 * is not owned returns 404. Only job/follow-up metadata is exposed
 * (status, automation name/type, timestamps, error text) — no message
 * bodies, recipients, or comment text ever leave this route.
 *
 * Activity fix (2026-11-23, audit #12 follow-up): the route used to
 * return a deterministically empty feed live while the same page
 * reported 99 DMs and /analytics showed the same dm_jobs rows. Two
 * defects, both in the query shape — the 0080aff transport fix
 * (workspace-scoped read) was correct hygiene but not the cause:
 *
 *  1. Facebook-blind: the queries filtered ONLY on
 *     `instagram_account_id`. Facebook jobs carry `facebook_page_id`
 *     with `instagram_account_id` NULL (markFbJobStatus), so every
 *     Messenger job was invisible — the same defect /analytics had
 *     until c452a48. The route now queries BOTH sides (IG by
 *     instagram_account_id, FB by facebook_page_id), exactly like
 *     /api/analytics, and an explicitly requested accountId may be
 *     an Instagram account OR a Facebook Page row id.
 *  2. Fragile join + swallowed errors: the dm_jobs select embedded
 *     `automations (id, name, type)` — the ONLY query on dm_jobs in
 *     the codebase that embeds a relation — and ANY error from that
 *     select (or the follow-ups select) was logged and silently
 *     continued with `[]`, so a failing leg masqueraded as "no
 *     activity" (200 + empty) instead of surfacing. The selects are
 *     now FLAT (the same shape as the proven-working /api/analytics
 *     dm_jobs query); automation names come from the automations
 *     list the route already loads for scoping and are joined in JS.
 *     The primary jobs leg now runs under withTransientQueryRetry
 *     (one bounded retry on transient PostgREST errors, like the
 *     contacts route) and a persistent failure returns 500, so a
 *     real failure renders the dashboard's retryable error branch
 *     instead of the misleading "No recent events" empty state.
 *     The follow-ups leg stays secondary: a missing table (42P01)
 *     or a persistent error there only drops follow-ups, never the
 *     jobs feed.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { withTransientQueryRetry } from '@/lib/supabase/queryRetry';
import type { SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:activity');

export interface ActivityItem {
  id: string;
  type: 'dm' | 'comment_private_reply' | 'story_reply' | 'follow_up';
  status: 'sent' | 'processing' | 'failed' | 'skipped' | 'scheduled' | 'held' | 'waiting_response' | 'expired';
  automationId: string;
  automationName: string;
  automationType: string;
  timestamp: string;
  errorMessage: string | null;
}

interface JobRow {
  id: string;
  trigger_type: string;
  status: string;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  automation_id: string;
}

interface FollowUpRow {
  id: string;
  status: string;
  error_reason: string | null;
  scheduled_for: string | null;
  sent_at: string | null;
  created_at: string;
  automation_id: string;
}

type AutomationName = { name: string; type: string };

const FLAT_JOB_COLUMNS =
  'id, trigger_type, status, error_message, sent_at, created_at, automation_id';
const FLAT_FOLLOW_UP_COLUMNS =
  'id, status, error_reason, scheduled_for, sent_at, created_at, automation_id';

/**
 * The two-sided dm_jobs read (Instagram by instagram_account_id,
 * Facebook by facebook_page_id), flat — no relation embed. Mirrors
 * the /api/analytics fetchSide shape, which is the proven-working
 * query over this table. A persistent failure throws (the caller
 * turns it into a 500); transient blips get the one bounded retry.
 */
async function fetchJobs(
  db: SupabaseClient,
  opts: { workspaceId?: string; igIds: string[]; fbIds: string[]; limit: number },
): Promise<JobRow[]> {
  const legs: Array<Promise<JobRow[]>> = [];
  if (opts.igIds.length > 0) {
    legs.push(
      withTransientQueryRetry('api:activity:jobs-ig', async () => {
        let q = db
          .from('dm_jobs')
          .select(FLAT_JOB_COLUMNS)
          .in('instagram_account_id', opts.igIds)
          .order('created_at', { ascending: false })
          .limit(opts.limit);
        if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId);
        const { data, error } = await q;
        if (error) throw error;
        return (data ?? []) as JobRow[];
      }),
    );
  }
  if (opts.fbIds.length > 0) {
    legs.push(
      withTransientQueryRetry('api:activity:jobs-fb', async () => {
        let q = db
          .from('dm_jobs')
          .select(FLAT_JOB_COLUMNS)
          .in('facebook_page_id', opts.fbIds)
          .order('created_at', { ascending: false })
          .limit(opts.limit);
        if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId);
        const { data, error } = await q;
        if (error) throw error;
        return (data ?? []) as JobRow[];
      }),
    );
  }
  return (await Promise.all(legs)).flat();
}

/**
 * Follow-up check-ins. Instagram-only: automation_follow_ups has no
 * facebook_page_id column and the Facebook engine writes no
 * follow-ups (FB v1 gap). Secondary source — a missing table (42P01)
 * or a persistent failure only drops follow-ups, never the jobs feed.
 */
async function fetchFollowUps(
  db: SupabaseClient,
  opts: { workspaceId?: string; igIds: string[]; limit: number },
): Promise<FollowUpRow[]> {
  if (opts.igIds.length === 0) return [];
  try {
    return await withTransientQueryRetry('api:activity:follow-ups', async () => {
      let q = db
        .from('automation_follow_ups')
        .select(FLAT_FOLLOW_UP_COLUMNS)
        .in('instagram_account_id', opts.igIds)
        .order('created_at', { ascending: false })
        .limit(opts.limit);
      if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId);
      const { data, error } = await q;
      if (error) {
        if ((error as { code?: string }).code === '42P01') return [];
        throw error;
      }
      return (data ?? []) as FollowUpRow[];
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch follow_ups for activity');
    return [];
  }
}

function toActivities(
  jobs: JobRow[],
  followUps: FollowUpRow[],
  names: Map<string, AutomationName>,
): ActivityItem[] {
  const activities: ActivityItem[] = [];

  for (const j of jobs) {
    const auto = names.get(j.automation_id);
    let mappedType: ActivityItem['type'] = 'dm';
    if (j.trigger_type === 'comment') mappedType = 'comment_private_reply';
    else if (j.trigger_type === 'story_reply') mappedType = 'story_reply';
    else if (j.trigger_type === 'dm_reply_followup') mappedType = 'follow_up';

    activities.push({
      id: `job_${j.id}`,
      type: mappedType,
      status: (j.status as ActivityItem['status']) || 'processing',
      automationId: j.automation_id,
      automationName: auto?.name ?? 'Automation',
      automationType: auto?.type ?? j.trigger_type,
      timestamp: j.sent_at || j.created_at,
      errorMessage: j.error_message ?? null,
    });
  }

  for (const fu of followUps) {
    const auto = names.get(fu.automation_id);
    activities.push({
      id: `fu_${fu.id}`,
      type: 'follow_up',
      status: (fu.status as ActivityItem['status']) || 'scheduled',
      automationId: fu.automation_id,
      automationName: auto?.name ?? 'Follow-up Check-in',
      automationType: auto?.type ?? 'follow_up',
      timestamp: fu.sent_at || fu.scheduled_for || fu.created_at,
      errorMessage: fu.error_reason ?? null,
    });
  }

  // Sort unified activities chronologically (newest first) and take top `limit`
  activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return activities;
}

function parseLimit(url: URL): number {
  const limitParam = parseInt(url.searchParams.get('limit') || '25', 10);
  return Math.min(Math.max(1, isNaN(limitParam) ? 25 : limitParam), 50);
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Activity(request, user);
  }

  const url = new URL(request.url);
  const requestedAccountId = url.searchParams.get('accountId');
  const limit = parseLimit(url);

  const db = createServiceClient();

  // Validate owner accounts
  const { data: accounts, error: accErr } = await db
    .from('instagram_accounts')
    .select('id')
    .eq('user_id', user.id);

  if (accErr) {
    logger.error({ err: accErr }, 'Failed to fetch accounts for activity');
    return Response.json({ error: 'Failed to load activity' }, { status: 500 });
  }

  const ownedAccountIds = (accounts ?? []).map((a) => a.id as string);

  // Facebook Pages owned by this user (channel scoping, mirrors
  // the /api/analytics legacy branch).
  const { data: fbPages } = await db
    .from('facebook_pages')
    .select('id')
    .eq('user_id', user.id);
  const ownedFbPageIds = (fbPages ?? []).map((p) => p.id as string);

  // Optional per-account scoping. SECURITY: the id must be user-owned.
  // The id may be an Instagram account OR a Facebook Page row id
  // (mirrors GET /api/automations and /api/analytics).
  let requestedIsFacebook = false;
  if (requestedAccountId) {
    if (!ownedAccountIds.includes(requestedAccountId)) {
      if (!ownedFbPageIds.includes(requestedAccountId)) {
        return Response.json({ error: 'Instagram account not found' }, { status: 404 });
      }
      requestedIsFacebook = true;
    }
  }

  let igScopeIds = requestedIsFacebook ? [] : requestedAccountId ? [requestedAccountId] : ownedAccountIds;
  let fbScopeIds = requestedIsFacebook ? [requestedAccountId!] : requestedAccountId ? [] : ownedFbPageIds;

  // Automation display names, joined in JS (no relation embed).
  const { data: automations } = await db
    .from('automations')
    .select('id, name, type')
    .eq('user_id', user.id);
  const names = new Map<string, AutomationName>(
    ((automations ?? []) as Array<{ id: string; name: string; type: string }>).map((a) => [
      a.id,
      { name: a.name, type: a.type },
    ]),
  );

  let jobs: JobRow[];
  try {
    jobs = await fetchJobs(db, { igIds: igScopeIds, fbIds: fbScopeIds, limit });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch dm_jobs for activity');
    return Response.json({ error: 'Failed to load activity' }, { status: 500 });
  }
  const followUps = await fetchFollowUps(db, { igIds: igScopeIds, limit });

  return Response.json({ activities: toActivities(jobs, followUps, names).slice(0, limit) });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// Scoping order: FIRST the ctx workspace, THEN the caller's accountId
// filter inside it — a foreign account id can never widen results.
// Account membership comes from the tenant repository; the job /
// follow-up queries themselves are direct ctx-scoped queries
// (justification: dm_jobs / automation_follow_ups rows are aggregated
// across the workspace's account set with ordering + limit, which the
// repository's equality-only list does not express) — every query
// carries `.eq('workspace_id', ctx.workspaceId)` AND the workspace
// account-id set. This route has no cache, so no cache key needs a
// workspace dimension.
async function p18Activity(
  request: Request,
  user: { id: string },
): Promise<Response> {
  const url = new URL(request.url);
  const requestedAccountId = url.searchParams.get('accountId');
  const limit = parseLimit(url);

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
    logger.error({ err }, 'Failed to fetch workspace scope for activity');
    return Response.json({ error: 'Failed to load activity' }, { status: 500 });
  }
  const ownedAccountIds = workspaceAccounts.map((a) => a['id'] as string);

  // Facebook Pages bound to this workspace (direct query — the tenant
  // repository has no facebookPages accessor yet; same pattern as the
  // automations list route and /api/analytics).
  const { data: fbPages } = await db
    .from('facebook_pages')
    .select('id')
    .eq('workspace_id', ctx.workspaceId);
  const ownedFbPageIds = (fbPages ?? []).map((p) => p['id'] as string);

  // Optional per-account scoping: an Instagram account OR a Facebook
  // Page row id bound to THIS workspace (mirrors p18ListAutomations
  // and p18Analytics).
  let requestedIsFacebook = false;
  if (requestedAccountId) {
    if (!ownedAccountIds.includes(requestedAccountId)) {
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

  const igScopeIds = requestedIsFacebook ? [] : requestedAccountId ? [requestedAccountId] : ownedAccountIds;
  const fbScopeIds = requestedIsFacebook ? [requestedAccountId!] : requestedAccountId ? [] : ownedFbPageIds;

  const names = new Map<string, AutomationName>(
    (workspaceAutomations as unknown as Array<{ id: string; name: string; type: string }>).map((a) => [
      a.id,
      { name: a.name, type: a.type },
    ]),
  );

  let jobs: JobRow[];
  try {
    jobs = await fetchJobs(db, {
      workspaceId: ctx.workspaceId,
      igIds: igScopeIds,
      fbIds: fbScopeIds,
      limit,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch dm_jobs for activity (workspace mode)');
    return Response.json({ error: 'Failed to load activity' }, { status: 500 });
  }
  const followUps = await fetchFollowUps(db, {
    workspaceId: ctx.workspaceId,
    igIds: igScopeIds,
    limit,
  });

  return Response.json({ activities: toActivities(jobs, followUps, names).slice(0, limit) });
}
