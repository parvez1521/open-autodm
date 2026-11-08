/**
 * Billing-route workspace access — SaaS subscription wiring (2026-11-08).
 *
 * Billing routes resolve the caller's workspace through the ONE
 * established pattern (src/lib/tenancy/routeContext.ts) — this module
 * adds only the billing-specific conveniences on top of it:
 *
 *  - Selector sources, in the established precedence: the
 *    `x-workspace-id` header wins, then the POST body's `workspaceId`
 *    field, then the `?workspace=` query param. The selector is a
 *    SELECTOR, never proof — membership is re-resolved per request by
 *    routeContext, exactly like every other workspace-mode route.
 *  - No-selector default, via routeContext's OWN documented escape
 *    hatch: "Routes that want a default must obtain it explicitly via
 *    listUserWorkspaces and re-resolve." When the caller belongs to
 *    exactly ONE workspace, that workspace is listed and re-resolved
 *    (so the full membership check still runs). Zero memberships →
 *    403 not-a-member; several → 400 workspace-context-required (the
 *    client must name one; nothing is guessed).
 *  - Billing mutations (checkout, trial start) require the
 *    `manageBilling` capability (workspace OWNER) via routeContext's
 *    requireCapability/hasCapability — no role logic is re-derived
 *    here. Reads (billing status) need membership only.
 *
 * This module deliberately does NOT gate on WORKSPACE_RUNTIME_ENABLED:
 * billing is inherently workspace-scoped (subscriptions.workspace_id),
 * and its own flags (BILLING_ENABLED / PAYMENTS_LIVE_MODE) are the
 * gates the owner flips for the subscription flow. The workspace
 * runtime flag continues to govern the legacy app's data routes only.
 * Membership READS stay inside tenancy/context.ts (the §5 reader
 * inventory is untouched — this module contains no membership query).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveRouteWorkspaceContext,
  listUserWorkspaces,
  hasCapability,
  type RouteWorkspaceResult,
  type WorkspaceContext,
} from '../tenancy/routeContext';

export type { RouteWorkspaceResult, WorkspaceContext };

/** Extract the workspace selector from a request (header > body > query). */
export function billingWorkspaceSelector(
  request: Request,
  bodyWorkspaceId?: unknown,
): string | null {
  const header = request.headers.get('x-workspace-id');
  if (header && header.trim().length > 0) return header;
  if (typeof bodyWorkspaceId === 'string' && bodyWorkspaceId.trim().length > 0) {
    return bodyWorkspaceId;
  }
  try {
    const q = new URL(request.url).searchParams.get('workspace');
    if (q && q.trim().length > 0) return q;
  } catch {
    /* a malformed URL simply has no query selector */
  }
  return null;
}

/**
 * Resolve the workspace for a billing route. Never throws for a
 * resolution failure; never returns a context on error (the
 * RouteWorkspaceResult contract from routeContext).
 */
export async function resolveBillingWorkspace(
  db: SupabaseClient,
  userId: string,
  selector: string | null | undefined,
): Promise<RouteWorkspaceResult> {
  if (selector && selector.trim().length > 0) {
    return resolveRouteWorkspaceContext(db, userId, selector);
  }
  const memberships = await listUserWorkspaces(db, userId);
  if (memberships.length === 1) {
    // Explicit default per the routeContext doctrine: list, then
    // RE-RESOLVE so the membership check runs in full.
    return resolveRouteWorkspaceContext(db, userId, memberships[0]!.workspaceId);
  }
  if (memberships.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'not-a-member',
      message: 'The user does not belong to any workspace.',
    };
  }
  return {
    ok: false,
    status: 400,
    code: 'workspace-context-required',
    message: 'A workspace must be selected: this account belongs to more than one workspace.',
  };
}

export type BillingManagerFailure = { ok: false; status: number; code: string; message: string };

/**
 * The failure result when the resolved context may not manage billing
 * (owner-only), or null when it may. Returned as a result (not thrown)
 * so routes can serialize it exactly like a resolution failure.
 */
export function billingManagerFailure(ctx: WorkspaceContext): BillingManagerFailure | null {
  if (hasCapability(ctx, 'manageBilling')) return null;
  return {
    ok: false,
    status: 403,
    code: 'insufficient-role',
    message: `Role '${ctx.role}' cannot manage billing; the workspace owner does that.`,
  };
}

/** Serialize a failed RouteWorkspaceResult as a route JSON response. */
export function workspaceFailureResponse(failure: { status: number; code: string; message: string }): Response {
  return Response.json(
    { ok: false, code: failure.code, message: failure.message },
    { status: failure.status },
  );
}
