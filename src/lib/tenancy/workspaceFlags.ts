/**
 * Programme 18 / Phase I foundation — workspace runtime feature flag.
 *
 * Follows src/lib/billing/flags.ts EXACTLY in shape and discipline:
 * pure injected-env readers (tests never touch real env), a DEFAULT_*
 * constant that is all-false, `=== 'true'` checks only (no truthy
 * coercion — '1', 'yes', 'TRUE', ' true' all stay OFF), and a route-gate
 * helper analogous to assertBillingRouteEnabled.
 *
 *   - WORKSPACE_RUNTIME_ENABLED: when off (default) every workspace-mode
 *     route must be inert (404/503 via assertWorkspaceRouteEnabled) and
 *     the product keeps its legacy single-owner behaviour byte-for-byte.
 *     When on, routes resolve a workspace context per request via
 *     src/lib/tenancy/routeContext.ts and serve tenant data only through
 *     src/lib/tenancy/repository.ts.
 *
 * This module deliberately does NOT touch billing/flags.ts and does NOT
 * redefine or widen any signup, entitlement, or billing flag — those
 * keep their existing owners and meanings in their own modules.
 */
export interface WorkspaceFlags {
  workspaceRuntimeEnabled: boolean;
}

export function readWorkspaceFlags(
  env: Record<string, string | undefined> = {},
): WorkspaceFlags {
  return { workspaceRuntimeEnabled: env.WORKSPACE_RUNTIME_ENABLED === 'true' };
}

export const DEFAULT_WORKSPACE_FLAGS: WorkspaceFlags = { workspaceRuntimeEnabled: false };

export function assertWorkspaceRouteEnabled(
  flags: WorkspaceFlags,
): { ok: true } | { ok: false; status: 503; reason: 'workspace-runtime-disabled' } {
  return flags.workspaceRuntimeEnabled
    ? { ok: true }
    : { ok: false, status: 503, reason: 'workspace-runtime-disabled' };
}
