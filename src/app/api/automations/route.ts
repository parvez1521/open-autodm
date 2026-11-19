/**
 * Automations CRUD - list + create.
 * Identity always from the verified JWT; ownership always checked in SQL.
 */

import { z } from 'zod';
import { getAuthenticatedUser, unauthorized, type AuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { DMResponseSchema, MAX_DM_RESPONSES, MAX_DM_OPENING_VARIATIONS } from '@/lib/api/schemas';
import { validateFlowGraph } from '@/lib/automation/flowGraph';
import type { FlowGraph } from '@/lib/types';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';
import { withTransientQueryRetry } from '@/lib/supabase/queryRetry';
import {
  evaluateEntitlementGate,
  planLimitResponse,
  countUserActiveAutomations,
  countWorkspaceActiveAutomations,
} from '@/lib/entitlements/guard';
import { billingWorkspaceSelector, resolveBillingWorkspace } from '@/lib/billing/access';
import { isOwnerFree } from '@/lib/owner';
import { getLinkClickCounts } from '@/lib/automation/linkTracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:automations');

const CreateAutomationSchema = z.object({
  instagramAccountId: z.string().uuid('instagramAccountId must be a UUID').nullable().optional(),
  /** Facebook Page automations (2026-11-19): the facebook_pages row id.
   *  Exactly one of instagramAccountId / facebookPageId must be set. */
  facebookPageId: z.string().uuid('facebookPageId must be a UUID').nullable().optional(),
  name: z.string().min(1, 'name is required').max(200),
  type: z.enum(['comment_dm', 'dm_reply', 'story_reply', 'reel_dm', 'story_mention', 'fb_comment_dm', 'fb_dm_reply']),
  isActive: z.boolean().default(true),
  /** AI reply language (2026-11-17): 'en' or 'hinglish'. Defaults to English. */
  aiReplyLanguage: z.enum(['en', 'hinglish']).default('en'),
  postId: z.string().nullable().optional(),
  postThumbnailUrl: z.string().nullable().optional(),
  postCaption: z.string().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  commentReplyOptions: z.array(z.string()).default([]),
  dmOpeningMessageEnabled: z.boolean().default(true),
  dmOpeningMessage: z.string().default(''),
  dmOpeningMessageVariations: z.array(z.string()).max(MAX_DM_OPENING_VARIATIONS, `Max ${MAX_DM_OPENING_VARIATIONS} opening-message variations per automation`).default([]),
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
}).refine(
  (v) => Boolean(v.instagramAccountId) !== Boolean(v.facebookPageId),
  { message: 'Exactly one of instagramAccountId / facebookPageId must be set' }
).refine(
  (v) => {
    const isFbType = v.type === 'fb_comment_dm' || v.type === 'fb_dm_reply';
    return isFbType === Boolean(v.facebookPageId);
  },
  { message: 'fb_* types require facebookPageId; Instagram types require instagramAccountId' }
);

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
  // The id may be an Instagram account OR a Facebook Page row id.
  const requestedAccountId = new URL(request.url).searchParams.get('accountId');
  let requestedFacebookPageId: string | null = null;
  if (requestedAccountId) {
    const { data: owned } = await db
      .from('instagram_accounts')
      .select('id')
      .eq('id', requestedAccountId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!owned) {
      const { data: ownedPage } = await db
        .from('facebook_pages')
        .select('id')
        .eq('id', requestedAccountId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!ownedPage) {
        return Response.json({ error: 'Account not found' }, { status: 404 });
      }
      requestedFacebookPageId = requestedAccountId;
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
          id, name, type, is_active, paused_by_disconnect, post_id, post_thumbnail_url, post_caption, keywords,
          comment_reply_options, public_reply_enabled, public_reply_options,
          follow_up_enabled, follow_up_delay_minutes, follow_up_message,
          dm_opening_message_enabled,
          dm_opening_message, dm_opening_message_variations, dm_opening_message_button_title, dm_opening_message_button_link,
          ask_to_follow_enabled, ask_to_follow_message,
          ask_to_follow_visit_profile_button, ask_to_follow_confirm_button,
          dm_responses, trigger_config, flow_graph, total_dms_sent, ai_reply_language, created_at, updated_at,
          instagram_account_id, channel, facebook_page_id,
          instagram_accounts ( id, username, profile_picture_url ),
          facebook_pages ( id, name, username, profile_picture_url )
        `)
        .eq('user_id', user.id);
      if (requestedAccountId) {
        if (requestedFacebookPageId) query = query.eq('facebook_page_id', requestedFacebookPageId);
        else query = query.eq('instagram_account_id', requestedAccountId);
      }
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
  // Link click totals (2026-11-17): merged per automation, best-effort —
  // a missing tracked_links table (migration not applied yet) reports 0.
  const clickCounts = await getLinkClickCounts(
    db,
    (data ?? []).map((row) => (row as { id: string }).id),
  );
  const automations = (data ?? []).map((row) => ({
    ...(row as Record<string, unknown>),
    total_link_clicks: clickCounts.get((row as { id: string }).id) ?? 0,
  }));
  return Response.json({ automations });
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
  // Facebook automations never carry a flow graph (the FB engine is
  // linear-only) — reject one instead of silently dropping it.
  const isFacebook = Boolean(data.facebookPageId);
  if (isFacebook && data.flowGraph !== undefined && data.flowGraph !== null) {
    return Response.json({ error: 'Validation failed - flowGraph is not supported for Facebook automations' }, { status: 400 });
  }
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

  // Facebook v1 limits (the UI hides these for FB; the API enforces them):
  // no require-follow (no follow signal on Facebook), no scheduled
  // follow-ups, no lead-form capture.
  if (isFacebook) {
    if (data.askToFollowEnabled) {
      return Response.json({ error: 'Validation failed - askToFollow is not available for Facebook automations' }, { status: 400 });
    }
    if (data.followUpEnabled) {
      return Response.json({ error: 'Validation failed - scheduled follow-ups are not available for Facebook automations' }, { status: 400 });
    }
    if (data.dmResponses.some((r) => r.type === 'lead_form')) {
      return Response.json({ error: 'Validation failed - lead-form responses are not available for Facebook automations' }, { status: 400 });
    }
  }

  // Ownership: the account being attached must belong to this user
  // (Instagram account OR Facebook Page, by the payload's channel).
  if (isFacebook) {
    const { data: fbPage, error: fbError } = await db
      .from('facebook_pages')
      .select('id')
      .eq('id', data.facebookPageId)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();
    if (fbError || !fbPage) {
      return Response.json({ error: 'Facebook Page not found or not yours' }, { status: 403 });
    }
  } else {
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
  }

  // Bug 2 enforcement (2026-11-09): creating an automation that
  // starts ACTIVE consumes one of the plan's active-automation slots.
  // ENTITLEMENTS_ENFORCED off (default) ⇒ the gate is a pass-through
  // and nothing below runs (lib/entitlements/guard.ts). Legacy usage
  // is user-scoped like the data itself; the plan comes from the
  // caller's billing workspace (single-membership default).
  if (data.isActive) {
    const gate = await evaluateEntitlementGate(db, {
      dimension: 'activeAutomations',
      // Owner comp (owner decision 2026-11-15): the owner's account
      // is forever free — never gated on plan limits.
      ownerFree: isOwnerFree(user),
      resolveContext: async () => {
        const ws = await resolveBillingWorkspace(db, user.id, billingWorkspaceSelector(request));
        return {
          workspaceId: ws.ok ? ws.ctx.workspaceId : null,
          usage: { activeAutomations: await countUserActiveAutomations(db, user.id) },
        };
      },
    });
    if (gate.blocked) return planLimitResponse(gate);
  }

  const { data: created, error } = await db
    .from('automations')
    .insert({
      user_id: user.id,
      instagram_account_id: isFacebook ? null : data.instagramAccountId,
      facebook_page_id: isFacebook ? data.facebookPageId : null,
      channel: isFacebook ? 'facebook' : 'instagram',
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
      // Variation 1 stays mirrored into the legacy single-message column
      // so older engine paths and the "opening off" check keep working.
      dm_opening_message: data.dmOpeningMessageVariations[0] ?? data.dmOpeningMessage,
      dm_opening_message_variations: data.dmOpeningMessageVariations,
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
      ai_reply_language: data.aiReplyLanguage,
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
  let requestedFacebookPageId: string | null = null;
  if (requestedAccountId) {
    // The account must be bound to THIS workspace; foreign/unbound ⇒ 404.
    // The id may be an Instagram account OR a Facebook Page row id.
    let account: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
    try {
      account = await repo.instagramAccounts.getByIdInWorkspace(requestedAccountId);
    } catch {
      account = null;
    }
    if (!account) {
      const { data: fbPage } = await db
        .from('facebook_pages')
        .select('id')
        .eq('id', requestedAccountId)
        .eq('workspace_id', resolved.ctx.workspaceId)
        .maybeSingle();
      if (!fbPage) {
        return Response.json({ error: 'Account not found' }, { status: 404 });
      }
      requestedFacebookPageId = requestedAccountId;
    }
  }

  // The data leg itself carries the bounded transient retry inside
  // the tenant repository's list (fix-plan item 6); here we only add
  // the per-leg timing.
  const queryStartedAt = Date.now();
  try {
    const rows = await repo.automations.list(
      requestedAccountId
        ? requestedFacebookPageId
          ? { facebook_page_id: requestedFacebookPageId }
          : { instagram_account_id: requestedAccountId }
        : {},
    );
    const queryMs = Date.now() - queryStartedAt;
    const automations = [...rows].sort((a, b) =>
      String(b['created_at'] ?? '').localeCompare(String(a['created_at'] ?? '')),
    );
    logger.debug(
      { userId: user.id, authMs, resolveMs, queryMs },
      'Listed automations (workspace mode)',
    );
    // Link click totals (2026-11-17) — see the legacy handler.
    const clickCounts = await getLinkClickCounts(
      db,
      automations.map((row) => String(row['id'] ?? '')),
    );
    const withClicks = automations.map((row) => ({
      ...row,
      total_link_clicks: clickCounts.get(String(row['id'] ?? '')) ?? 0,
    }));
    return Response.json({ automations: withClicks });
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
  // Full authenticated user (not just the id): the entitlement gate
  // needs the email for the owner-free comp (isOwnerFree).
  user: AuthenticatedUser,
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
  // Facebook automations never carry a flow graph (the FB engine is
  // linear-only) — reject one instead of silently dropping it.
  const isFacebook = Boolean(data.facebookPageId);
  if (isFacebook && data.flowGraph !== undefined && data.flowGraph !== null) {
    return Response.json({ error: 'Validation failed - flowGraph is not supported for Facebook automations' }, { status: 400 });
  }
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

  // Facebook v1 limits (same as the legacy handler).
  if (isFacebook) {
    if (data.askToFollowEnabled) {
      return Response.json({ error: 'Validation failed - askToFollow is not available for Facebook automations' }, { status: 400 });
    }
    if (data.followUpEnabled) {
      return Response.json({ error: 'Validation failed - scheduled follow-ups are not available for Facebook automations' }, { status: 400 });
    }
    if (data.dmResponses.some((r) => r.type === 'lead_form')) {
      return Response.json({ error: 'Validation failed - lead-form responses are not available for Facebook automations' }, { status: 400 });
    }
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

  // TW-1 fix (workspace mode): the target account must be bound to the
  // SAME workspace as the resolved context. Foreign/unbound ⇒ 404, and
  // nothing is inserted. The account may be an Instagram account OR a
  // Facebook Page (direct workspace_id-scoped query — the tenant
  // repository has no facebookPages accessor yet).
  let igAccount: Awaited<ReturnType<typeof repo.instagramAccounts.getByIdInWorkspace>> = null;
  let fbPage: { id: string; is_active: boolean } | null = null;
  if (isFacebook) {
    const { data: pageRow } = await db
      .from('facebook_pages')
      .select('id, is_active')
      .eq('id', data.facebookPageId)
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle();
    fbPage = pageRow as { id: string; is_active: boolean } | null;
  } else {
    try {
      igAccount = await repo.instagramAccounts.getByIdInWorkspace(data.instagramAccountId!);
    } catch {
      igAccount = null;
    }
  }
  if (!igAccount && !fbPage) {
    return Response.json({ error: 'Account not found' }, { status: 404 });
  }
  if ((igAccount && igAccount['is_active'] === false) || (fbPage && fbPage.is_active === false)) {
    return Response.json({ error: 'Account not found or not yours' }, { status: 403 });
  }

  // Bug 2 enforcement (2026-11-09): creating an ACTIVE automation
  // consumes a workspace plan slot — same gate as the legacy handler,
  // with workspace-scoped usage. Inactive creates are never gated
  // (activation is gated in the [id] PUT instead). Flag off ⇒
  // pass-through, zero behaviour change (lib/entitlements/guard.ts).
  if (data.isActive) {
    const gate = await evaluateEntitlementGate(db, {
      dimension: 'activeAutomations',
      // Owner comp (owner decision 2026-11-15): the owner's account
      // is forever free — never gated on plan limits.
      ownerFree: isOwnerFree(user),
      resolveContext: async () => ({
        workspaceId: ctx.workspaceId,
        usage: { activeAutomations: await countWorkspaceActiveAutomations(db, ctx.workspaceId) },
      }),
    });
    if (gate.blocked) return planLimitResponse(gate);
  }

  try {
    // The repository stamps workspace_id from ctx and rejects any payload
    // carrying a foreign workspace_id.
    const created = await repo.automations.insert({
      user_id: user.id,
      instagram_account_id: isFacebook ? null : data.instagramAccountId,
      facebook_page_id: isFacebook ? data.facebookPageId : null,
      channel: isFacebook ? 'facebook' : 'instagram',
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
      // Variation 1 stays mirrored into the legacy single-message column
      // so older engine paths and the "opening off" check keep working.
      dm_opening_message: data.dmOpeningMessageVariations[0] ?? data.dmOpeningMessage,
      dm_opening_message_variations: data.dmOpeningMessageVariations,
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
      ai_reply_language: data.aiReplyLanguage,
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
