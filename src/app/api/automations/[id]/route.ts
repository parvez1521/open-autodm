/**
 * Automations CRUD - update + delete a single automation.
 */

import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { DMResponseSchema, MAX_DM_RESPONSES, MAX_DM_OPENING_VARIATIONS } from '@/lib/api/schemas';
import { automationToFlowGraph, hasComplexBranches, validateFlowGraph } from '@/lib/automation/flowGraph';
import type { FlowGraph } from '@/lib/types';
import { readWorkspaceFlags } from '@/lib/tenancy/workspaceFlags';
import { resolveRouteWorkspaceContext, requireCapability } from '@/lib/tenancy/routeContext';
import { createTenantRepository } from '@/lib/tenancy/repository';
import { WorkspaceAccessError } from '@/lib/tenancy/context';
import {
  evaluateEntitlementGate,
  planLimitResponse,
  countUserActiveAutomations,
  countWorkspaceActiveAutomations,
} from '@/lib/entitlements/guard';
import { billingWorkspaceSelector, resolveBillingWorkspace } from '@/lib/billing/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:automations:id');

const UpdateAutomationSchema = z.object({
  is_active: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
  keywords: z.array(z.string()).nullable().optional(),
  comment_reply_options: z.array(z.string()).optional(),
  dm_opening_message_enabled: z.boolean().optional(),
  dm_opening_message: z.string().optional(),
  dm_opening_message_variations: z.array(z.string()).max(MAX_DM_OPENING_VARIATIONS, `Max ${MAX_DM_OPENING_VARIATIONS} opening-message variations per automation`).optional(),
  dm_opening_message_button_title: z.string().nullable().optional(),
  dm_opening_message_button_link: z.string().nullable().optional(),
  post_thumbnail_url: z.string().nullable().optional(),
  post_caption: z.string().nullable().optional(),
  ask_to_follow_enabled: z.boolean().optional(),
  ask_to_follow_message: z.string().optional(),
  ask_to_follow_visit_profile_button: z.string().optional(),
  ask_to_follow_confirm_button: z.string().optional(),
  dm_responses: z.array(DMResponseSchema).max(MAX_DM_RESPONSES, `Max ${MAX_DM_RESPONSES} responses per automation`).optional(),
  public_reply_enabled: z.boolean().optional(),
  public_reply_options: z.array(z.string()).optional(),
  follow_up_enabled: z.boolean().optional(),
  follow_up_delay_minutes: z.number().int().refine((v) => [10, 20, 60, 120].includes(v), 'follow_up_delay_minutes must be one of 10, 20, 60, 120').optional(),
  follow_up_message: z.string().optional(),
  // Flow graph (Phase 5, row 19): when omitted, the stored graph is either
  // preserved verbatim (complex graphs) or regenerated from the edited flat
  // fields (simple canonical graphs) — see the PUT handler. When supplied,
  // it is validated and stored as the new graph.
  flow_graph: z.unknown().optional(),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (p18WorkspaceEnabled()) return p18UpdateAutomation(request, user, context);

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = UpdateAutomationSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return Response.json({ error: `Validation failed - ${detail}`, details: parsed.error.issues }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: existing, error: fetchError } = await db
    .from('automations')
    .select('id, user_id, type, is_active, post_id, keywords, dm_opening_message, dm_opening_message_button_title, dm_responses, flow_graph')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (fetchError || !existing) {
    return Response.json({ error: 'Automation not found' }, { status: 404 });
  }

  // Bug 2 enforcement (2026-11-09): only an inactive→active
  // transition consumes a new plan slot, so only that transition is
  // gated. Edits of an already-active automation and deactivations
  // are never gated (lib/entitlements/guard.ts; flag off ⇒ no-op).
  if (parsed.data.is_active === true && existing.is_active !== true) {
    const gate = await evaluateEntitlementGate(db, {
      dimension: 'activeAutomations',
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

  // ── Flow graph guard (Phase 5, row 19) ──────────────────────────────────
  // The candidate's linear builder cannot edit graph branching, so an edit
  // must never silently corrupt a stored flow graph. Same rule as
  // release-prep's builders:
  //  - graph supplied in the body → validate + store it;
  //  - no graph supplied + existing COMPLEX graph → preserve it verbatim
  //    (the flow_graph column is simply not part of the update);
  //  - no graph supplied + existing SIMPLE canonical graph → regenerate it
  //    from the merged flat fields, so trigger/DM/follow-up node data stays
  //    in sync with what the builder edited.
  const { flow_graph: suppliedGraph, ...flatUpdates } = parsed.data;
  const update: Record<string, unknown> = { ...flatUpdates };

  if (suppliedGraph !== undefined) {
    if (suppliedGraph === null) {
      update.flow_graph = null;
    } else {
      const candidate = suppliedGraph as FlowGraph;
      if (typeof candidate !== 'object' || !Array.isArray(candidate.nodes)) {
        return Response.json({ error: 'Validation failed - flow_graph must be a flow graph object with a nodes array' }, { status: 400 });
      }
      const validation = validateFlowGraph(candidate);
      if (!validation.valid) {
        return Response.json({ error: `Validation failed - flow_graph: ${validation.errors.join('; ')}` }, { status: 400 });
      }
      update.flow_graph = candidate;
    }
  } else {
    const existingGraph = (existing.flow_graph as FlowGraph | null) ?? null;
    if (existingGraph && Array.isArray(existingGraph.nodes) && existingGraph.nodes.length > 0 && !hasComplexBranches(existingGraph)) {
      update.flow_graph = automationToFlowGraph({
        ...existing,
        ...flatUpdates,
        flow_graph: existingGraph,
      });
    }
  }

  const { data: updated, error: updateError } = await db
    .from('automations')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id, name, type, is_active, total_dms_sent, updated_at')
    .single();

  if (updateError) {
    logger.error({ err: updateError, automationId: id }, 'Failed to update automation');
    return Response.json({ error: 'Failed to update automation' }, { status: 500 });
  }
  return Response.json({ automation: updated });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  // Programme 18 Phase D: workspace mode branches here; flag OFF ⇒ legacy.
  if (p18WorkspaceEnabled()) return p18DeleteAutomation(request, user, context);

  const { id } = await context.params;
  const db = createServiceClient();

  const { data: existing, error: fetchError } = await db
    .from('automations')
    .select('id, user_id, name')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (fetchError || !existing) {
    return Response.json({ error: 'Automation not found' }, { status: 404 });
  }

  const { error: deleteError } = await db.from('automations').delete().eq('id', id).eq('user_id', user.id);
  if (deleteError) {
    logger.error({ err: deleteError, automationId: id }, 'Failed to delete automation');
    return Response.json({ error: 'Failed to delete automation' }, { status: 500 });
  }

  logger.info({ userId: user.id, automationId: id }, 'Automation deleted');
  return Response.json({ success: true });
}

// ── Programme 18 Phase D — workspace mode ───────────────────────────────
// Selector convention: `x-workspace-id` header wins over `?workspace=`
// query param; the selector is never proof (per-request re-resolution,
// fail closed, no legacy fallback). By-id access goes ONLY through the
// repository's getByIdInWorkspace: a foreign or unbound row ⇒ 404 (the
// codebase's IDOR posture), never 403, and is never mutated. Writes
// require the 'write' capability (member+; viewer is read-only).
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

async function p18UpdateAutomation(
  request: Request,
  user: { id: string },
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = UpdateAutomationSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return Response.json({ error: `Validation failed - ${detail}`, details: parsed.error.issues }, { status: 400 });
  }

  const db = createServiceClient();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, p18Selector(request));
  if (!resolved.ok) return p18ResolutionFailure(resolved);
  try {
    requireCapability(resolved.ctx, 'write');
  } catch (err) {
    return p18CapabilityFailure(err);
  }
  const repo = createTenantRepository(db, resolved.ctx, 'write');

  let existing: Awaited<ReturnType<typeof repo.automations.getByIdInWorkspace>> = null;
  try {
    existing = await repo.automations.getByIdInWorkspace(id);
  } catch {
    existing = null; // foreign / unbound ⇒ 404 below, zero mutation
  }
  if (!existing) {
    return Response.json({ error: 'Automation not found' }, { status: 404 });
  }

  // Bug 2 enforcement (2026-11-09): inactive→active transitions are
  // gated on the workspace's active-automation limit — same rule as
  // the legacy handler (lib/entitlements/guard.ts; flag off ⇒ no-op).
  if (parsed.data.is_active === true && existing['is_active'] !== true) {
    const gate = await evaluateEntitlementGate(db, {
      dimension: 'activeAutomations',
      resolveContext: async () => ({
        workspaceId: resolved.ctx.workspaceId,
        usage: { activeAutomations: await countWorkspaceActiveAutomations(db, resolved.ctx.workspaceId) },
      }),
    });
    if (gate.blocked) return planLimitResponse(gate);
  }

  // Flow-graph guard: identical rules to the legacy handler (validate a
  // supplied graph; preserve a complex stored graph; regenerate a simple
  // canonical graph from the merged flat fields).
  const { flow_graph: suppliedGraph, ...flatUpdates } = parsed.data;
  const update: Record<string, unknown> = { ...flatUpdates };

  if (suppliedGraph !== undefined) {
    if (suppliedGraph === null) {
      update.flow_graph = null;
    } else {
      const candidate = suppliedGraph as FlowGraph;
      if (typeof candidate !== 'object' || !Array.isArray(candidate.nodes)) {
        return Response.json({ error: 'Validation failed - flow_graph must be a flow graph object with a nodes array' }, { status: 400 });
      }
      const validation = validateFlowGraph(candidate);
      if (!validation.valid) {
        return Response.json({ error: `Validation failed - flow_graph: ${validation.errors.join('; ')}` }, { status: 400 });
      }
      update.flow_graph = candidate;
    }
  } else {
    const existingGraph = (existing['flow_graph'] as FlowGraph | null) ?? null;
    if (existingGraph && Array.isArray(existingGraph.nodes) && existingGraph.nodes.length > 0 && !hasComplexBranches(existingGraph)) {
      update.flow_graph = automationToFlowGraph({
        ...(existing as unknown as Record<string, unknown>),
        ...flatUpdates,
        flow_graph: existingGraph,
      } as never);
    }
  }

  try {
    const updated = await repo.automations.updateById(id, {
      ...update,
      updated_at: new Date().toISOString(),
    });
    if (!updated) {
      return Response.json({ error: 'Automation not found' }, { status: 404 });
    }
    return Response.json({ automation: updated });
  } catch (err) {
    if (err instanceof WorkspaceAccessError) return p18CapabilityFailure(err);
    logger.error({ err, automationId: id }, 'Failed to update automation (workspace mode)');
    return Response.json({ error: 'Failed to update automation' }, { status: 500 });
  }
}

async function p18DeleteAutomation(
  request: Request,
  user: { id: string },
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const db = createServiceClient();
  const resolved = await resolveRouteWorkspaceContext(db, user.id, p18Selector(request));
  if (!resolved.ok) return p18ResolutionFailure(resolved);
  try {
    requireCapability(resolved.ctx, 'write');
  } catch (err) {
    return p18CapabilityFailure(err);
  }
  const repo = createTenantRepository(db, resolved.ctx, 'write');

  let existing: Awaited<ReturnType<typeof repo.automations.getByIdInWorkspace>> = null;
  try {
    existing = await repo.automations.getByIdInWorkspace(id);
  } catch {
    existing = null; // foreign / unbound ⇒ 404, zero mutation
  }
  if (!existing) {
    return Response.json({ error: 'Automation not found' }, { status: 404 });
  }

  try {
    const deleted = await repo.automations.deleteById(id);
    if (!deleted) {
      return Response.json({ error: 'Automation not found' }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof WorkspaceAccessError) return p18CapabilityFailure(err);
    logger.error({ err, automationId: id }, 'Failed to delete automation (workspace mode)');
    return Response.json({ error: 'Failed to delete automation' }, { status: 500 });
  }

  logger.info({ userId: user.id, automationId: id }, 'Automation deleted (workspace mode)');
  return Response.json({ success: true });
}
