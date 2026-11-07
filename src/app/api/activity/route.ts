/**
 * GET /api/activity?accountId=<id>&limit=25
 *
 * Authenticated endpoint returning real recent automation activity:
 *  - DM jobs: sent, failed, skipped, processing
 *  - Follow-up check-in states: scheduled, waiting_response, sent, held, expired
 *
 * Scoped strictly to the authenticated owner's connected Instagram accounts.
 * Message content is sanitized to prevent private conversation exposure.
 *
 * Ported verbatim from release-prep (Phase 5, row 22). Owner scoping: the
 * caller's own instagram_accounts are loaded first and every query is
 * restricted to those account ids; an explicitly requested accountId that
 * is not owned returns 404. Only job/follow-up metadata is exposed
 * (status, automation name/type, timestamps, error text) — no message
 * bodies, recipients, or comment text ever leave this route.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';

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

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (readWorkspaceFlags(process.env).workspaceRuntimeEnabled) {
    return p18Activity(request, user);
  }

  const url = new URL(request.url);
  const requestedAccountId = url.searchParams.get('accountId');
  const limitParam = parseInt(url.searchParams.get('limit') || '25', 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 25 : limitParam), 50);

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
  if (ownedAccountIds.length === 0) {
    return Response.json({ activities: [] });
  }

  let targetAccountIds = ownedAccountIds;
  if (requestedAccountId) {
    if (!ownedAccountIds.includes(requestedAccountId)) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
    targetAccountIds = [requestedAccountId];
  }

  // 1. Fetch recent DM jobs
  const { data: jobs, error: jobsErr } = await db
    .from('dm_jobs')
    .select(`
      id,
      trigger_type,
      status,
      error_message,
      sent_at,
      created_at,
      automation_id,
      automations ( id, name, type )
    `)
    .in('instagram_account_id', targetAccountIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (jobsErr) {
    logger.error({ err: jobsErr }, 'Failed to fetch dm_jobs for activity');
  }

  // 2. Fetch recent follow-up records
  const { data: followUps, error: fuErr } = await db
    .from('automation_follow_ups')
    .select(`
      id,
      status,
      error_reason,
      scheduled_for,
      sent_at,
      created_at,
      automation_id,
      automations ( id, name, type )
    `)
    .in('instagram_account_id', targetAccountIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (fuErr && fuErr.code !== '42P01') {
    logger.warn({ err: fuErr }, 'Failed to fetch follow_ups for activity');
  }

  const activities: ActivityItem[] = [];

  for (const j of jobs ?? []) {
    const auto = Array.isArray(j.automations) ? j.automations[0] : j.automations;
    let mappedType: ActivityItem['type'] = 'dm';
    if (j.trigger_type === 'comment') mappedType = 'comment_private_reply';
    else if (j.trigger_type === 'story_reply') mappedType = 'story_reply';
    else if (j.trigger_type === 'dm_reply_followup') mappedType = 'follow_up';

    activities.push({
      id: `job_${j.id}`,
      type: mappedType,
      status: (j.status as ActivityItem['status']) || 'processing',
      automationId: j.automation_id,
      automationName: (auto as { name?: string })?.name ?? 'Automation',
      automationType: (auto as { type?: string })?.type ?? j.trigger_type,
      timestamp: j.sent_at || j.created_at,
      errorMessage: j.error_message ?? null,
    });
  }

  for (const fu of followUps ?? []) {
    const auto = Array.isArray(fu.automations) ? fu.automations[0] : fu.automations;
    activities.push({
      id: `fu_${fu.id}`,
      type: 'follow_up',
      status: (fu.status as ActivityItem['status']) || 'scheduled',
      automationId: fu.automation_id,
      automationName: (auto as { name?: string })?.name ?? 'Follow-up Check-in',
      automationType: (auto as { type?: string })?.type ?? 'follow_up',
      timestamp: fu.sent_at || fu.scheduled_for || fu.created_at,
      errorMessage: fu.error_reason ?? null,
    });
  }

  // Sort unified activities chronologically (newest first) and take top `limit`
  activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return Response.json({ activities: activities.slice(0, limit) });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback).
//
// Scoping order: FIRST the ctx workspace, THEN the caller's accountId
// filter inside it — a foreign account id can never widen results.
// Account membership comes from the tenant repository; the activity
// queries themselves are direct ctx-scoped queries (justification:
// dm_jobs / automation_follow_ups rows are aggregated across the
// workspace's account set with ordering + limit, which the repository's
// equality-only list does not express) — every query carries
// .eq('workspace_id', ctx.workspaceId) AND the workspace account-id set.
// This route has no cache, so no cache key needs a workspace dimension.
async function p18Activity(
  request: Request,
  user: { id: string },
): Promise<Response> {
  const url = new URL(request.url);
  const requestedAccountId = url.searchParams.get('accountId');
  const limitParam = parseInt(url.searchParams.get('limit') || '25', 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 25 : limitParam), 50);

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
  try {
    workspaceAccounts = await repo.instagramAccounts.list();
  } catch (err) {
    logger.error({ err }, 'Failed to fetch accounts for activity (workspace mode)');
    return Response.json({ error: 'Failed to load activity' }, { status: 500 });
  }
  const ownedAccountIds = workspaceAccounts.map((a) => a['id'] as string);
  if (ownedAccountIds.length === 0) {
    return Response.json({ activities: [] });
  }

  let targetAccountIds = ownedAccountIds;
  if (requestedAccountId) {
    if (!ownedAccountIds.includes(requestedAccountId)) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
    targetAccountIds = [requestedAccountId];
  }

  const { data: jobs, error: jobsErr } = await db
    .from('dm_jobs')
    .select(`
      id,
      trigger_type,
      status,
      error_message,
      sent_at,
      created_at,
      automation_id,
      automations ( id, name, type )
    `)
    .eq('workspace_id', ctx.workspaceId)
    .in('instagram_account_id', targetAccountIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (jobsErr) {
    logger.error({ err: jobsErr }, 'Failed to fetch dm_jobs for activity (workspace mode)');
  }

  const { data: followUps, error: fuErr } = await db
    .from('automation_follow_ups')
    .select(`
      id,
      status,
      error_reason,
      scheduled_for,
      sent_at,
      created_at,
      automation_id,
      automations ( id, name, type )
    `)
    .eq('workspace_id', ctx.workspaceId)
    .in('instagram_account_id', targetAccountIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (fuErr && fuErr.code !== '42P01') {
    logger.warn({ err: fuErr }, 'Failed to fetch follow_ups for activity (workspace mode)');
  }

  const activities: ActivityItem[] = [];

  for (const j of jobs ?? []) {
    const auto = Array.isArray(j.automations) ? j.automations[0] : j.automations;
    let mappedType: ActivityItem['type'] = 'dm';
    if (j.trigger_type === 'comment') mappedType = 'comment_private_reply';
    else if (j.trigger_type === 'story_reply') mappedType = 'story_reply';
    else if (j.trigger_type === 'dm_reply_followup') mappedType = 'follow_up';

    activities.push({
      id: `job_${j.id}`,
      type: mappedType,
      status: (j.status as ActivityItem['status']) || 'processing',
      automationId: j.automation_id,
      automationName: (auto as { name?: string })?.name ?? 'Automation',
      automationType: (auto as { type?: string })?.type ?? j.trigger_type,
      timestamp: j.sent_at || j.created_at,
      errorMessage: j.error_message ?? null,
    });
  }

  for (const fu of followUps ?? []) {
    const auto = Array.isArray(fu.automations) ? fu.automations[0] : fu.automations;
    activities.push({
      id: `fu_${fu.id}`,
      type: 'follow_up',
      status: (fu.status as ActivityItem['status']) || 'scheduled',
      automationId: fu.automation_id,
      automationName: (auto as { name?: string })?.name ?? 'Follow-up Check-in',
      automationType: (auto as { type?: string })?.type ?? 'follow_up',
      timestamp: fu.sent_at || fu.scheduled_for || fu.created_at,
      errorMessage: fu.error_reason ?? null,
    });
  }

  activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return Response.json({ activities: activities.slice(0, limit) });
}
