/**
 * Programme 27 — the client-side companion to routeContext.ts.
 *
 * Server routes in workspace mode resolve their context from the
 * `x-workspace-id` SELECTOR (header preferred) via
 * resolveRouteWorkspaceContext, and a missing selector fails closed
 * with 'workspace-context-required' (HTTP 400). Before this module,
 * the automation builder's mutations (and the builder's account/post
 * reads) called plain `apiClient` and never attached the selector, so
 * with WORKSPACE_RUNTIME_ENABLED on, every builder save met that 400
 * even though the card-image uploads (Programme 26) were already
 * workspace-scoped. This module gives client callers the same
 * three-state discipline the storage scope established in P26:
 *
 *   - flag OFF                ⇒ 'legacy': the request goes through
 *                               apiClient EXACTLY as before — same
 *                               function, same arguments, no header.
 *   - flag ON + a selection   ⇒ 'workspace': the request carries the
 *                               selector for the selected workspace.
 *   - flag ON + no selection  ⇒ 'unavailable': the request is refused
 *                               BEFORE it is sent, with the tenancy
 *                               layer's own WorkspaceAccessError code
 *                               'workspace-context-required'. There is
 *                               NO silent fallback to a legacy request.
 *
 * The selection is only ever an id from the WorkspaceProvider's
 * member-derived list (server-resolved at GET /api/workspaces,
 * re-validated on load, dropped on revocation) — a bare client-
 * supplied id is never accepted here, and the server re-resolves
 * membership on every request regardless: the header is a selector,
 * never proof.
 *
 * Snapshot rule: callers resolve ONE scope per operation from the
 * provider state of a single render and pass that same scope to every
 * step of the operation (P26 card-image uploads + this request), so a
 * selection change mid-operation can never split an operation across
 * two workspaces — the in-flight operation completes under the
 * workspace that was selected when it started.
 */

import { apiClient } from '@/lib/api/client';
import { WorkspaceAccessError } from './context';

export type WorkspaceRequestScope =
  | { kind: 'legacy' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'unavailable' };

/**
 * Pure mapping from provider state to a request scope. Flag OFF ⇒
 * legacy (even if a stale selection object is present); flag ON + a
 * selected workspace id ⇒ workspace; flag ON + none ⇒ unavailable.
 */
export function workspaceRequestScopeFromSelection(input: {
  workspaceRuntimeEnabled: boolean;
  selectedWorkspaceId: string | null | undefined;
}): WorkspaceRequestScope {
  if (!input.workspaceRuntimeEnabled) return { kind: 'legacy' };
  return input.selectedWorkspaceId
    ? { kind: 'workspace', workspaceId: input.selectedWorkspaceId }
    : { kind: 'unavailable' };
}

/**
 * The up-front gate: 'unavailable' throws the tenancy layer's typed
 * error BEFORE any request is attempted. Legacy and workspace scopes
 * pass.
 *
 * @throws {WorkspaceAccessError} code 'workspace-context-required'
 */
export function assertWorkspaceRequestScope(
  scope: WorkspaceRequestScope,
): asserts scope is Exclude<WorkspaceRequestScope, { kind: 'unavailable' }> {
  if (scope.kind === 'unavailable') {
    throw new WorkspaceAccessError(
      'workspace-context-required',
      'Workspace mode is on but no workspace is selected; the request was not sent.',
    );
  }
}

/** The transport seam — apiClient in production, a fake in tests. */
export type WorkspaceRequestClient = <T>(path: string, options?: RequestInit) => Promise<T>;

/**
 * Send one API request under a resolved scope.
 *
 * - legacy:    `client(path, options)` — the exact pre-P27 call,
 *              options passed through by reference, headers untouched.
 * - workspace: the same call with the `x-workspace-id` header for the
 *              scope's workspace merged over any caller headers via
 *              Headers normalization — `new Headers(options?.headers)`
 *              preserves plain-object, `Headers`-instance and
 *              tuple-array `HeadersInit` forms without corruption,
 *              then `headers.set('x-workspace-id', scope.workspaceId)`
 *              makes the scope's selector win over any caller-supplied
 *              value (the selector convention routeContext.ts
 *              documents; this is exactly what
 *              WorkspaceProvider.workspaceFetch produces, except the
 *              id comes from the caller's operation snapshot rather
 *              than a live read at send time — see the snapshot rule
 *              in the header).
 * - unavailable: throws before the client is invoked; zero requests.
 */
export async function sendWorkspaceRequest<T>(
  scope: WorkspaceRequestScope,
  path: string,
  options?: RequestInit,
  client: WorkspaceRequestClient = apiClient,
): Promise<T> {
  assertWorkspaceRequestScope(scope);
  if (scope.kind === 'legacy') return client<T>(path, options);
  const headers = new Headers(options?.headers);
  headers.set('x-workspace-id', scope.workspaceId);
  return client<T>(path, { ...options, headers });
}
