/**
 * Automations CRUD - list + create.
 * Identity always from the verified JWT; ownership always checked in SQL.
 */

import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { DMResponseSchema, MAX_DM_RESPONSES } from '@/lib/api/schemas';
import { validateFlowGraph } from '@/lib/automation/flowGraph';
import type { FlowGraph } from '@/lib/types';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';
import { withTransientQueryRetry } from '@/lib/supabase/queryRetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:automations');

const CreateAutomationSchema = z.object({
  instagramAccountId: z.string().uuid('instagramAccountId must be a UUID'),
  name: z.string().min(1, 'name is required').max(200),
  type: z.enum(['comment_dm', 'dm_reply', 'story_reply', 'reel_dm']),
  isActive: z.boolean().default(true),
  postId: z.string().nullable().optional(),
  postThumbnailUrl: z.string().nullable().optional(),
  postCaption: z.string().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  commentReplyOptions: z.array(z.string()).default([]),
  dmOpeningMessageEnabled: z.boolean().default(true),
  dmOpeningMessage: z.string().default(''),
  dmOpeningMessageButtonTitle: z.string().nullable().optional(),
  dmOpeningMessageButtonLink: z.string().nullable().optional(),
  askToFollowEnabled: z.boolean().default(false),
  askToFollowMessage: z.string().default(''),
  askToFollowVisitProfileButton: z.string().default('Visit Profile'),
  askToFollowConfirmButton: z.string().default("I'm following ✅"),
  dmResponses: z.array(DMResponseSchema).max(MAX_DM_RESPONSES, `Max ${MAX_DM_RESPONSES} responses per automation`).default([]),
  // Public reply gate (Phase 5): when omitted, derived from whether any
  // comment reply options were configured (preserves the builder's promise
  // that configured replies are posted; the engine never posts when false).
  publicReplyEnabled: z.boolean().optional(),
  publicReplyOptions: z.array(z.string()).optional(),
  // Scheduled follow-ups (Phase 5): stored message text only, no AI.
  followUpEnabled: z.boolean().default(false),
  followUpDelayMinutes: z.number().int().refine((v) => [10, 20, 60, 120].includes(v), 'followUpDelayMinutes must be one of 10, 20, 60, 120').default(60),
  followUpMessage: z.string().default(''),
  // Flow graph + trigger config (Phase 5, row 19): optional; a supplied
  // graph is structurally validated before storage. The candidate's own
  // builder does not send these yet — they exist so flow automations can be
  // created/managed through the API without losing their graph.
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  flowGraph: z.unknown().optional(),
});

export async function GET(request: Request): Promise<Response> {
  // Per-leg timing (flakiness fix, 2026-11-08, investigation
  // fix-plan item 6): auth / resolve / query durations ride along
  // in the logs so the next slow-or-failing list request is
  // diagnosable from function logs alone.
  const requestStartedAt = Date.now();
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const authMs = Date.now() - requestStartedAt;
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ the
  // legacy handler below runs exactly as before.
  if (p18WorkspaceEnabled()) return p18ListAutomations(request, user, authMs);

  const db = createServiceClient();

  // Optional per-account scoping. SECURITY: verify the account belongs to
  // this user before filtering by it - never trust a client-sent id.
  const requestedAccountId = new URL(request.url).searchParams.get('accountId');
  if (requestedAccountId) {
    const { data: owned } = await db
      .from('instagram_accounts')
      .select('id')
      .eq('id', requestedAccountId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!owned) {
      return Response.json({ error: 'Instagram account not found' }, { status: 404 });
    }
  }

  // Flakiness fix (2026-11-08): ONE bounded retry on transient
  // PostgREST errors for the data leg (see lib/supabase/queryRetry).
  // The builder is constructed inside the thunk — fresh per attempt.
  const queryStartedAt = Date.now();
  let data: unknown[] | null;
  try {
    data = await withTransientQueryRetry('api:automations:list', async () => {
      let query = db
        .from('automations')
        .select(`
          id, name, type, is_active, post_id, post_thumbnail_url, post_caption, keywords,
          comment_reply_options, public_reply_enabled, public_reply_options,
          follow_up_enabled, follow_up_delay_minutes, follow_up_message,
          dm_opening_message_enabled,
          dm_opening_message, dm_opening_message_button_title, dm_opening_message_button_link,
          ask_to_follow_enabled, ask_to_follow_message,
          ask_to_follow_visit_profile_button, ask_to_follow_confirm_button,
          dm_responses, trigger_config, flow_graph, total_dms_sent, created_at, updated_at,
          instagram_account_id,
          instagram_accounts ( id, username, profile_picture_url )
        `)
        .eq('user_id', user.id);
      if (requestedAccountId) query = query.eq('instagram_account_id', requestedAccountId);
      const { data: rows, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return rows;
    });
  } catch (error) {
    logger.error(
      { err: error, userId: user.id, authMs, queryMs: Date.now() - queryStartedAt },
      'Failed to fetch automations',
    );
    return Response.json({ error: 'Failed to fetch automations' }, { status: 500 });
  }
  logger.debug(
    { userId: user.id, authMs, queryMs: Date.now() - queryStartedAt },
    'Listed automations',
  );
  return Response.json({ automations: data ?? [] });
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (p18WorkspaceEnabled()) return p18CreateAutomation(request, user);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CreateAutomationSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return Response.json({ error: `Validation failed - ${detail}`, details: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  // Validate a supplied flow graph before it can reach storage/execution.
  let flowGraph: FlowGraph | null = null;
  if (data.flowGraph !== undefined && data.flowGraph !== null) {
    const candidate = data.flowGraph as FlowGraph;
    if (typeof candidate !== 'object' || !Array.isArray(candidate.nodes)) {
      return Response.json({ error: 'Validation failed - flowGraph must be a flow graph object with a nodes array' }, { status: 400 });
    }
    const validation = validateFlowGraph(candidate);
    if (!validation.valid) {
      return Response.json({ error: `Validation failed - flowGraph: ${validation.errors.join('; ')}` }, { status: 400 });
    }
    flowGraph = candidate;
  }

  const db = createServiceClient();

  // Ownership: the IG account being attached must belong to this user
  const { data: igAccount, error: igError } = await db
    .from('instagram_accounts')
    .select('id')
    .eq('id', data.instagramAccountId)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single();
  if (igError || !igAccount) {
    return Response.json({ error: 'Instagram account not found or not yours' }, { status: 403 });
  }

  const { data: created, error } = await db
    .from('automations')
    .insert({
      user_id: user.id,
      instagram_account_id: data.instagramAccountId,
      name: data.name,
      type: data.type,
      post_id: data.postId ?? null,
      post_thumbnail_url: data.postThumbnailUrl ?? null,
      post_caption: data.postCaption ?? null,
      keywords: data.keywords ?? null,
      comment_reply_options: data.commentReplyOptions,
      public_reply_enabled: data.publicReplyEnabled ?? (data.commentReplyOptions.length > 0),
      public_reply_options: data.publicReplyOptions ?? data.commentReplyOptions,
      follow_up_enabled: data.followUpEnabled,
      follow_up_delay_minutes: data.followUpDelayMinutes,
      follow_up_message: data.followUpMessage,
      dm_opening_message_enabled: data.dmOpeningMessageEnabled,
      dm_opening_message: data.dmOpeningMessage,
      dm_opening_message_button_title: data.dmOpeningMessageButtonTitle ?? null,
      dm_opening_message_button_link: data.dmOpeningMessageButtonLink ?? null,
      ask_to_follow_enabled: data.askToFollowEnabled,
      ask_to_follow_message: data.askToFollowMessage,
      ask_to_follow_visit_profile_button: data.askToFollowVisitProfileButton,
      ask_to_follow_confirm_button: data.askToFollowConfirmButton,
      dm_responses: data.dmResponses,
      trigger_config: data.triggerConfig ?? {},
      flow_graph: flowGraph,
      is_active: data.isActive,
      total_dms_sent: 0,
    })
    .select('id, name, type, is_active, total_dms_sent, created_at')
    .single();

  if (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to create automation');
    return Response.json({ error: 'Failed to create automation' }, { status: 500 });
  }

  logger.info({ userId: user.id, automationId: created?.id, type: data.type }, 'Automation created');
  return Response.json({ automation: created }, { status: 201 });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: the `x-workspace-id` header wins over the
// `?workspace=` query param when both are present. The selector is never
// proof: membership is re-resolved per request via
// resolveRouteWorkspaceContext, and any resolution failure fails closed
// (its status is returned; there is NO legacy fallback in workspace
// mode). Data access goes through the tenant repository, which scopes
// every read to ctx.workspaceId and stamps every insert.
function p18WorkspaceEnabled(): boolean {
  return readWorkspaceFlags(process.env).workspaceRuntimeEnabled;
}

function p18Selector(request: Request): string | null {
  const header = request.headers.get('x-workspace-id');
  if (header && header.trim().length > 0) return header;
  return new URL(request.url).searchParams.get('workspace');
}

function p18ResolutionFailure(res: { status: number; code: string; message: string }): Response {
  return Response.json({ error: res.message, code: res.code }, { status: res.status });
}

function p18CapabilityFailure(err: unknown): Response {
  if (err instanceof WorkspaceAccessError) {
    return Response.json({ error: err.message, code: err.code }, { status: 403 });
  }
  return Response.json({ error: 'Workspace authorization failed' }, { status: 500 });
}

async function p18ListAutomations(
  request: Request,
  user: { id: string },
  authMs: number,
): Promise<Response> {
  const db = createServiceClient();
  const resolveStartedAt = Date.now();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, p18Selector(request));
  const resolveMs = Date.now() - resolveStartedAt;
  if (!resolved.ok) return p18ResolutionFailure(resolved);
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

  // The data leg itself carries the bounded transient retry inside
  // the tenant repository's list (fix-plan item 6); here we only add
  // the per-leg timing.
  const queryStartedAt = Date.now();
  try {
    const rows = await repo.automations.list(
      requestedAccountId ? { instagram_account_id: requestedAccountId } : {},
    );
    const queryMs = Date.now() - queryStartedAt;
    const automations = [...rows].sort((a, b) =>
      String(b['created_at'] ?? '').localeCompare(String(a['created_at'] ?? '')),
    );
    logger.debug(
      { userId: user.id, authMs, resolveMs, queryMs },
      'Listed automations (workspace mode)',
    );
    return Response.json({ automations });
  } catch (err) {
    logger.error(
      { err, userId: user.id, authMs, resolveMs, queryMs: Date.now() - queryStartedAt },
      'Failed to fetch automations (workspace mode)',
    );
    return Response.json({ error: 'Failed to fetch automations' }, { status: 500 });
  }
}

async function p18CreateAutomation(
  request: Request,
  user: { id: string },
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CreateAutomationSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return Response.json({ error: `Validation failed - ${detail}`, details: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  let flowGraph: FlowGraph | null = null;
  if (data.flowGraph !== undefined && data.flowGraph !== null) {
    const candidate = data.flowGraph as FlowGraph;
    if (typeof candidate !== 'object' || !Array.isArray(candidate.nodes)) {
      return Response.json({ error: 'Validation failed - flowGraph must be a flow graph object with a nodes array' }, { status: 400 });
    }
    const validation = validateFlowGraph(candidate);
    if (!validation.valid) {
      return Response.json({ error: `Validation failed - flowGraph: ${validation.errors.join('; ')}` }, { status: 400 });
    }
    flowGraph = candidate;
  }

  const db = createServiceClient();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, p18Selector(request));
  if (!resolved.ok) return p18ResolutionFailure(resolved);
  const ctx = resolved.ctx;

  // Routine write: member+ (viewer is read-only).
  try {
    requireCapability(ctx, 'write');
  } catch (err) {
    return p18CapabilityFailure(err);
  }
  const repo = createTenantRepository(db, ctx, 'write');

  // TW-1 fix (workspace mode): the target IG account must be bound to the
  // SAME workspace as the resolved context. Foreign/unbound ⇒ 404, and
  // nothing is inserted.
  let igAccount: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  try {
    igAccount = await repo.instagramAccounts.getByIdInWorkspace(data.instagramAccountId);
  } catch {
    igAccount = null;
  }
  if (!igAccount) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }
  if (igAccount['is_active'] === false) {
    return Response.json({ error: 'Instagram account not found or not yours' }, { status: 403 });
  }

  try {
    // The repository stamps workspace_id from ctx and rejects any payload
    // carrying a foreign workspace_id.
    const created = await repo.automations.insert({
      user_id: user.id,
      instagram_account_id: data.instagramAccountId,
      name: data.name,
      type: data.type,
      post_id: data.postId ?? null,
      post_thumbnail_url: data.postThumbnailUrl ?? null,
      post_caption: data.postCaption ?? null,
      keywords: data.keywords ?? null,
      comment_reply_options: data.commentReplyOptions,
      public_reply_enabled: data.publicReplyEnabled ?? (data.commentReplyOptions.length > 0),
      public_reply_options: data.publicReplyOptions ?? data.commentReplyOptions,
      follow_up_enabled: data.followUpEnabled,
      follow_up_delay_minutes: data.followUpDelayMinutes,
      follow_up_message: data.followUpMessage,
      dm_opening_message_enabled: data.dmOpeningMessageEnabled,
      dm_opening_message: data.dmOpeningMessage,
      dm_opening_message_button_title: data.dmOpeningMessageButtonTitle ?? null,
      dm_opening_message_button_link: data.dmOpeningMessageButtonLink ?? null,
      ask_to_follow_enabled: data.askToFollowEnabled,
      ask_to_follow_message: data.askToFollowMessage,
      ask_to_follow_visit_profile_button: data.askToFollowVisitProfileButton,
      ask_to_follow_confirm_button: data.askToFollowConfirmButton,
      dm_responses: data.dmResponses,
      trigger_config: data.triggerConfig ?? {},
      flow_graph: flowGraph,
      is_active: data.isActive,
      total_dms_sent: 0,
    });
    logger.info({ userId: user.id, automationId: created['id'], workspaceId: ctx.workspaceId }, 'Automation created (workspace mode)');
    return Response.json({ automation: created }, { status: 201 });
  } catch (err) {
    if (err instanceof WorkspaceAccessError) return p18CapabilityFailure(err);
    logger.error({ err, userId: user.id }, 'Failed to create automation (workspace mode)');
    return Response.json({ error: 'Failed to create automation' }, { status: 500 });
  }
}
