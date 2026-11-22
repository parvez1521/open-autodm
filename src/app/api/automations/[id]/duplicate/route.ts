/**
 * POST /api/automations/[id]/duplicate — copy an automation.
 *
 * Duplicates the whole config (channel, type, post, keywords, public
 * replies, opening variations, reveal/follow-up, responses including
 * both link buttons, require-follow, lead form, trigger config, flow
 * graph) under a new id named "Copy of <original name>".
 *
 * The copy is ALWAYS created INACTIVE (is_active false) so it can
 * never double-send DMs until the owner activates it himself — that
 * is the whole point of duplicating before editing. The copied config
 * is validated with the exact create schema (CreateAutomationSchema)
 * before insert, and the insert row is the same shape the create
 * endpoint writes. Counters restart at zero; the source row is never
 * touched. No entitlement gate runs: inactive creates are never
 * gated (the gate runs on activation instead, in the [id] PUT).
 *
 * Ownership: legacy mode scopes by user_id; workspace mode goes
 * through the tenant repository (foreign/unbound id ⇒ 404, viewer
 * is read-only — the same IDOR posture as PUT/DELETE).
 */

import { randomUUID } from 'node:crypto';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { CreateAutomationSchema, type CreateAutomationInput } from '@/lib/api/schemas';
import { validateFlowGraph } from '@/lib/automation/flowGraph';
import type { FlowGraph } from '@/lib/types';
import {
  buildDuplicateInsertRow,
  sourceRowToCreateBody,
  type AutomationSourceRow,
} from '@/lib/automation/duplicate';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:automations:duplicate');

type RouteContext = { params: Promise<{ id: string }> };

/** Full config columns of one automation row, for the copy. */
const SOURCE_COLUMNS =
  'id, user_id, name, type, instagram_account_id, facebook_page_id, channel, is_active, ' +
  'post_id, post_thumbnail_url, post_caption, keywords, comment_reply_options, ' +
  'public_reply_enabled, public_reply_options, follow_up_enabled, follow_up_delay_minutes, ' +
  'follow_up_message, dm_opening_message_enabled, dm_opening_message, ' +
  'dm_opening_message_variations, dm_opening_message_button_title, dm_opening_message_button_link, ' +
  'ask_to_follow_enabled, ask_to_follow_message, ask_to_follow_visit_profile_button, ' +
  'ask_to_follow_confirm_button, dm_responses, trigger_config, flow_graph, ai_reply_language';

/**
 * Validates the copied config exactly the way create does, and
 * resolves the flow graph to its stored value. Returns the validated
 * create payload + flow graph, or an error Response on failure.
 */
function validateDuplicate(
  source: AutomationSourceRow,
): { data: CreateAutomationInput; flowGraph: FlowGraph | null } | { error: Response } {
  const body = sourceRowToCreateBody(source);
  const parsed = CreateAutomationSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { error: Response.json({ error: `Validation failed - ${detail}` }, { status: 400 }) };
  }
  const data = parsed.data;
  const isFacebook = Boolean(data.facebookPageId);

  // Facebook automations never carry a flow graph (the FB engine is
  // linear-only) — reject one instead of silently dropping it.
  if (isFacebook && data.flowGraph !== undefined && data.flowGraph !== null) {
    return { error: Response.json({ error: 'Validation failed - flowGraph is not supported for Facebook automations' }, { status: 400 }) };
  }
  let flowGraph: FlowGraph | null = null;
  if (data.flowGraph !== undefined && data.flowGraph !== null) {
    const candidate = data.flowGraph as FlowGraph;
    if (typeof candidate !== 'object' || !Array.isArray(candidate.nodes)) {
      return { error: Response.json({ error: 'Validation failed - flowGraph must be a flow graph object with a nodes array' }, { status: 400 }) };
    }
    const validation = validateFlowGraph(candidate);
    if (!validation.valid) {
      return { error: Response.json({ error: `Validation failed - flowGraph: ${validation.errors.join('; ')}` }, { status: 400 }) };
    }
    flowGraph = candidate;
  }

  // Facebook v1 limits (same as create): no require-follow, no
  // scheduled follow-ups, no lead-form capture. A source row written
  // by the FB builder already satisfies these; the check is the
  // safety net for rows written any other way.
  if (isFacebook) {
    if (data.askToFollowEnabled) {
      return { error: Response.json({ error: 'Validation failed - askToFollow is not available for Facebook automations' }, { status: 400 }) };
    }
    if (data.followUpEnabled) {
      return { error: Response.json({ error: 'Validation failed - scheduled follow-ups are not available for Facebook automations' }, { status: 400 }) };
    }
    if (data.dmResponses.some((r) => r.type === 'lead_form')) {
      return { error: Response.json({ error: 'Validation failed - lead-form responses are not available for Facebook automations' }, { status: 400 }) };
    }
  }

  return { data, flowGraph };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  if (p18WorkspaceEnabled()) return p18DuplicateAutomation(request, user, context);

  const { id } = await context.params;
  const db = createServiceClient();

  const { data: source, error: fetchError } = await db
    .from('automations')
    .select(SOURCE_COLUMNS)
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (fetchError || !source) {
    return Response.json({ error: 'Automation not found' }, { status: 404 });
  }

  const validated = validateDuplicate(source as unknown as AutomationSourceRow);
  if ('error' in validated) return validated.error;

  const newId = randomUUID();
  const { data: created, error } = await db
    .from('automations')
    .insert(buildDuplicateInsertRow(validated.data, user.id, newId, validated.flowGraph))
    .select('id, name, type, is_active, total_dms_sent, created_at')
    .single();
  if (error) {
    logger.error({ err: error, userId: user.id, sourceAutomationId: id }, 'Failed to duplicate automation');
    return Response.json({ error: 'Failed to duplicate automation' }, { status: 500 });
  }

  logger.info({ userId: user.id, sourceAutomationId: id, automationId: created?.id }, 'Automation duplicated');
  return Response.json({ automation: created }, { status: 201 });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
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

async function p18DuplicateAutomation(
  request: Request,
  user: { id: string },
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const db = createServiceClient();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, p18Selector(request));
  if (!resolved.ok) return p18ResolutionFailure(resolved);
  const ctx = resolved.ctx;
  try {
    requireCapability(ctx, 'write');
  } catch (err) {
    return p18CapabilityFailure(err);
  }
  const repo = createTenantRepository(db, ctx, 'write');

  let source: Awaited<ReturnType<typeof repo.automations.getByIdInWorkspace>> = null;
  try {
    source = await repo.automations.getByIdInWorkspace(id);
  } catch {
    source = null; // foreign / unbound ⇒ 404, zero mutation
  }
  if (!source) {
    return Response.json({ error: 'Automation not found' }, { status: 404 });
  }

  const validated = validateDuplicate(source as unknown as AutomationSourceRow);
  if ('error' in validated) return validated.error;

  // The id is minted up front: the repository insert returns the
  // stamped payload (not a re-read row), so the response carries
  // the copy's real id.
  const newId = randomUUID();
  try {
    const created = await repo.automations.insert(
      buildDuplicateInsertRow(validated.data, user.id, newId, validated.flowGraph),
    );
    logger.info(
      { userId: user.id, sourceAutomationId: id, automationId: created['id'], workspaceId: ctx.workspaceId },
      'Automation duplicated (workspace mode)',
    );
    return Response.json(
      {
        automation: {
          id: created['id'],
          name: created['name'],
          type: created['type'],
          is_active: created['is_active'],
          total_dms_sent: created['total_dms_sent'],
          created_at: created['created_at'],
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof WorkspaceAccessError) return p18CapabilityFailure(err);
    logger.error({ err, userId: user.id, sourceAutomationId: id }, 'Failed to duplicate automation (workspace mode)');
    return Response.json({ error: 'Failed to duplicate automation' }, { status: 500 });
  }
}
