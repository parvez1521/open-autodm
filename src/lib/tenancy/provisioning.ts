/**
 * First-workspace provisioning — launch fix (2026-11-08).
 *
 * THE GAP: nothing in the signup flow ever created a workspace.
 * Signup (components/auth/SignupForm.tsx) creates only the auth
 * identity; the /auth/callback route only runs the S-02 gate; the
 * onboarding page is a static checklist. The ONLY creation path was
 * an explicit POST /api/workspaces (→ the create_workspace RPC,
 * migration …000031) — and no UI ever called it. A fresh customer
 * therefore landed in a console with ZERO memberships, where every
 * workspace-scoped surface dead-ends: billing resolves through
 * lib/billing/access.ts and answers 403 "The user does not belong
 * to any workspace.", and scoped data queries have no workspace to
 * resolve. Accounts created before the SaaS wiring (e.g. the
 * staging preview account) were stuck the same way.
 *
 * THE FIX: the console shell's WorkspaceProvider — the one surface
 * every authenticated flow converges on (password sign-in, email
 * confirmation via /auth/callback, and immediate-session signup
 * ALL redirect to /dashboard, which the (main) layout wraps in the
 * provider) — ensures a first workspace on load: when the
 * member-derived list comes back empty, it creates one through the
 * SAME POST /api/workspaces route a manual creation would use
 * (which runs the create_workspace RPC: workspace row +
 * 'owner' membership, atomically) and re-reads the list.
 *
 * The decision logic lives here, dependency-injected, so it is
 * unit-testable without React; the provider supplies the apiClient
 * calls. Failure posture: a failed creation NEVER breaks the
 * shell — the caller keeps the honest empty list and the existing
 * empty states render, exactly as before this fix.
 */

export const DEFAULT_WORKSPACE_NAME = 'My workspace';

export interface ProvisionIfEmptyDeps<T> {
  /** Create a workspace with the given name (POST /api/workspaces). */
  create: (name: string) => Promise<unknown>;
  /** Re-read the member-derived workspace list after creation. */
  relist: () => Promise<T[]>;
}

export interface ProvisionIfEmptyResult<T> {
  workspaces: T[];
  /** True only when a workspace was created AND the re-read shows it. */
  provisioned: boolean;
}

/**
 * Given the caller's current workspace list, provision their first
 * workspace when — and only when — the list is empty.
 *
 *  - Non-empty list: returned untouched; create/relist never run.
 *  - Empty + create succeeds: the list is re-read and returned;
 *    `provisioned` reports whether the new workspace is visible.
 *  - Empty + create succeeds: the list is re-read and returned;
 *    `provisioned` reports whether the new workspace is visible.
 *  - Empty + create fails: the empty list is returned with
 *    `provisioned: false` (fail-soft; never throws). A re-read
 *    failure after a successful create is likewise fail-soft —
 *    the workspace exists and the next load will show it.
 */
export async function provisionIfEmpty<T>(
  current: readonly T[],
  deps: ProvisionIfEmptyDeps<T>,
): Promise<ProvisionIfEmptyResult<T>> {
  if (current.length > 0) {
    return { workspaces: [...current], provisioned: false };
  }
  try {
    await deps.create(DEFAULT_WORKSPACE_NAME);
  } catch {
    return { workspaces: [], provisioned: false };
  }
  try {
    const after = await deps.relist();
    return { workspaces: after, provisioned: after.length > 0 };
  } catch {
    return { workspaces: [], provisioned: false };
  }
}
