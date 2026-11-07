/**
 * Phase D2 / Programme 16 — card-image storage paths and write gating.
 *
 * Both card-image path conventions live in this one documented place:
 *
 *   - Legacy (pre-tenancy, the live write path whenever the workspace
 *     runtime flag is OFF — the default): processCardImages()
 *     in src/hooks/useAutomations.ts uploads through the browser client
 *     to `${session.user.id}/${Date.now()}-${random}.${ext}` — the first
 *     folder is the uploader's auth user id. Migration …000023's storage
 *     policies enforce exactly that folder rule.
 *   - Workspace (SaaS transition): the same `<id>/<timestamp>-<rand>.<ext>`
 *     shape, but the first folder is the WORKSPACE id. Migration
 *     …000033 adds workspace-member storage policies ALONGSIDE the
 *     …000023 user-folder policies (permissive policies OR together), so
 *     both conventions are valid during the transition window.
 *
 * The two shapes are syntactically identical — a bare first segment
 * cannot say whether it names a user or a workspace. That question is
 * answered by the database (…000033 checks for a matching workspaces
 * row; `cardImageOwnerScope` below mirrors that for audit code by
 * consulting caller-supplied known-id sets and reporting 'unknown'
 * rather than guessing when it cannot tell).
 *
 * Programme 26 (PF-5) wiring: processCardImages() now selects between
 * the two conventions through `CardImageUploadScope` (below) instead of
 * always building the legacy path inline. The scope is derived from
 * the WorkspaceProvider's member-derived selection (the provider's
 * list comes from GET /api/workspaces, which resolves membership
 * server-side per request, and drops selections whose membership was
 * revoked) — a bare client-supplied workspace id is never sufficient:
 * an id that is not in the member-derived list maps to the
 * 'unavailable' scope, which fails closed. The residual gap between
 * list-load and write is closed by …000033 itself: the storage
 * policies re-check LIVE membership (has_workspace_role) on every
 * write under the caller's own authenticated session.
 */

import {
  canWrite,
  WorkspaceAccessError,
  type WorkspaceContext,
  type WorkspaceRole,
} from '@/lib/tenancy/context';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

function buildPath(ownerId: string, ext: string, now: number, rand: string): string {
  return `${ownerId}/${now}-${rand}.${normalizeExt(ext)}`;
}

function defaultRand(): string {
  // Same generator shape as the legacy inline code in useAutomations.ts.
  return Math.random().toString(36).slice(2);
}

/**
 * Workspace-scoped card-image path: `<workspaceId>/<timestamp>-<rand>.<ext>`.
 * `now` / `rand` are injectable for deterministic tests; production
 * callers omit them.
 */
export function workspaceCardImagePath(
  workspaceId: string,
  ext: string,
  now: number = Date.now(),
  rand: string = defaultRand(),
): string {
  return buildPath(workspaceId, ext, now, rand);
}

/**
 * Legacy user-scoped card-image path: `<userId>/<timestamp>-<rand>.<ext>`
 * — byte-for-byte the shape processCardImages() in useAutomations.ts
 * has always produced, kept here so both conventions are documented
 * together.
 */
export function userCardImagePath(
  userId: string,
  ext: string,
  now: number = Date.now(),
  rand: string = defaultRand(),
): string {
  return buildPath(userId, ext, now, rand);
}

/**
 * Gate a card-image write on the workspace context's role.
 *
 * @throws {WorkspaceAccessError} code 'insufficient-role' unless
 *   canWrite(ctx.role) — viewers are read-only (Programme 16 role table).
 */
export function assertCardImageWrite(ctx: WorkspaceContext): void {
  if (!canWrite(ctx.role)) {
    throw new WorkspaceAccessError(
      'insufficient-role',
      `Role '${ctx.role}' may not write card images; viewers are read-only.`,
    );
  }
}

/**
 * Which prefix convention a card-image upload must use, resolved by
 * the caller from the workspace runtime state (Programme 26 / PF-5):
 *
 *   - 'legacy': the workspace runtime flag is OFF (the default). The
 *     upload uses the legacy user-folder path, exactly as the flow has
 *     always behaved.
 *   - 'workspace': the flag is ON and a workspace is selected from the
 *     member-derived list (see the header note — the id alone is never
 *     proof; the list is membership-resolved server-side and …000033
 *     re-checks live membership at write time). `role` is the caller's
 *     role in THAT workspace, from the same member-derived list.
 *   - 'unavailable': the flag is ON but no verified workspace selection
 *     exists (none selected, still loading, or the selection was
 *     dropped after revocation). Uploads FAIL CLOSED in this state —
 *     there is no silent fallback to the legacy path in workspace mode.
 */
export type CardImageUploadScope =
  | { kind: 'legacy' }
  | { kind: 'workspace'; workspaceId: string; role: WorkspaceRole }
  | { kind: 'unavailable' };

/** The slice of a workspace selection the scope decision needs. */
export interface CardImageWorkspaceSelection {
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * Map the workspace runtime state to an upload scope (pure — the
 * React-side caller is a one-line adapter over the WorkspaceProvider's
 * values). Flag OFF always yields the legacy scope, even if a stale
 * selection object is present; flag ON with no selection yields
 * 'unavailable' (fail closed), never a guessed workspace.
 */
export function cardImageUploadScopeFromSelection(input: {
  workspaceRuntimeEnabled: boolean;
  selectedWorkspace: CardImageWorkspaceSelection | null | undefined;
}): CardImageUploadScope {
  if (!input.workspaceRuntimeEnabled) return { kind: 'legacy' };
  if (!input.selectedWorkspace) return { kind: 'unavailable' };
  return {
    kind: 'workspace',
    workspaceId: input.selectedWorkspace.workspaceId,
    role: input.selectedWorkspace.role,
  };
}

/**
 * Gate a card-image upload on its resolved scope. Callers invoke this
 * ONCE, before any write is attempted:
 *
 *   - legacy scope always passes (flag-off behaviour is untouched);
 *   - 'unavailable' throws `WorkspaceAccessError`
 *     ('workspace-context-required') — the same code the server-side
 *     resolver uses for a missing workspace context;
 *   - a workspace scope is role-gated exactly like
 *     `assertCardImageWrite` (viewers are read-only ⇒
 *     'insufficient-role').
 */
export function assertCardImageUploadScope(scope: CardImageUploadScope, userId: string): void {
  switch (scope.kind) {
    case 'legacy':
      return;
    case 'unavailable':
      throw new WorkspaceAccessError(
        'workspace-context-required',
        'Card-image upload requires a selected workspace while the workspace runtime is enabled.',
      );
    case 'workspace':
      assertCardImageWrite({ workspaceId: scope.workspaceId, userId, role: scope.role });
      return;
  }
}

/**
 * Build the upload path for a resolved scope. Pure construction (the
 * role/context gate is `assertCardImageUploadScope`, invoked by the
 * caller before any write); the 'unavailable' scope has no path and
 * throws the same 'workspace-context-required' error, so a caller that
 * skips the gate still cannot obtain a path in workspace mode without
 * a selection. `now` / `rand` are injectable for deterministic tests.
 */
export function cardImagePathForScope(
  scope: CardImageUploadScope,
  userId: string,
  ext: string,
  now: number = Date.now(),
  rand: string = defaultRand(),
): string {
  switch (scope.kind) {
    case 'legacy':
      return userCardImagePath(userId, ext, now, rand);
    case 'workspace':
      return workspaceCardImagePath(scope.workspaceId, ext, now, rand);
    case 'unavailable':
      throw new WorkspaceAccessError(
        'workspace-context-required',
        'Card-image upload requires a selected workspace while the workspace runtime is enabled.',
      );
  }
}

/**
 * Programme 28 (§1, Iteration-5 disposition): parse an HTTP status
 * from EITHER status field of a storage error — symmetrically.
 * Accepts a number, or a string of digits only (/^\d+$/); anything
 * else yields undefined. `statusCode` takes precedence over `status`
 * when both parse (mirroring the pre-P28 precedence, which parsed a
 * numeric-string `statusCode` but — the gap P28 closes — not a
 * numeric-string `status`, so { status: "403" } used to miss).
 */
function parseCardImageStorageStatus(error: {
  statusCode?: unknown;
  status?: unknown;
}): number | undefined {
  const parse = (value: unknown): number | undefined => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return undefined;
  };
  return parse(error.statusCode) ?? parse(error.status);
}

/**
 * Programme 28 (§1): normalize a storage error message before
 * matching — lowercase, replace every run of hyphens/underscores
 * with a single space, and collapse whitespace. The documented
 * denial vocabulary is hyphenated ("row-level-security",
 * "permission-denied", "not-authorized") while storage messages may
 * use the space-separated forms (or underscores); normalization lets
 * one space-separated pattern set match every variant.
 */
function normalizeCardImageStorageMessage(message: unknown): string {
  if (typeof message !== 'string') return '';
  return message
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The two abort-worthy classes of card-image storage error
 * (Programme 28 §1):
 *   - 'authorization-denied': the write was refused on authorization
 *     grounds (403, or row-level-security / permission-denied /
 *     not-authorized vocabulary) — e.g. …000033 storage RLS found the
 *     caller's live membership no longer authorizes the workspace
 *     prefix (revoked, or demoted to viewer, after the workspace
 *     list was loaded).
 *   - 'session-expired': the write was refused with an
 *     authentication/session error (401, or unauthorized wording
 *     without the strong denial vocabulary) — e.g. an expired
 *     session. This makes NO membership/role claim.
 */
export type CardImageStorageErrorClass = 'authorization-denied' | 'session-expired';

/**
 * Programme 28 (§1): classify a storage error into one of the two
 * abort-worthy classes, or null when it is not abort-worthy.
 *
 * Identification (against the storage client's error shape — an
 * object that may carry `statusCode` / `status` and `message`):
 *   - status is parsed symmetrically from EITHER field (number or
 *     /^\d+$/ string; `statusCode` wins when both parse — see
 *     parseCardImageStorageStatus);
 *   - the message is normalized before matching (lowercase;
 *     [-_]+ runs become a single space; whitespace collapsed — see
 *     normalizeCardImageStorageMessage), so hyphenated,
 *     space-separated and underscored phrasings match identically;
 *   - status 403, OR a normalized message matching the strong denial
 *     vocabulary /row level security|permission denied|not
 *     authorized/ ⇒ 'authorization-denied' (checked FIRST, so a 401
 *     carrying RLS vocabulary is still 'authorization-denied');
 *   - otherwise status 401, OR a normalized message matching
 *     /unauthori[sz]ed/ ⇒ 'session-expired';
 *   - otherwise null.
 * Everything else — network failures, 5xx, 409 conflicts, 413
 * payload-too-large, generic messages, non-object values — is null
 * and stays on the recoverable path.
 *
 * Residual ambiguity, stated plainly: the storage API does not return
 * a dedicated machine-readable "RLS denied" code, so this is a
 * heuristic over the shapes above. An authorization failure phrased
 * in other vocabulary would be misclassified as recoverable; a 401
 * is reported as 'session-expired' on the strength of the status
 * alone, and while an expired session is the expected cause, the
 * classifier cannot prove the root cause — only that the write was
 * refused with an authentication/session-shaped error. Either class
 * aborts a workspace-mode save (see isCardImageStorageDenial): the
 * safe direction, since the write was not authorized as attempted
 * either way.
 */
export function classifyCardImageStorageError(
  error: unknown,
): CardImageStorageErrorClass | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown };
  const status = parseCardImageStorageStatus(e);
  const message = normalizeCardImageStorageMessage(e.message);
  if (status === 403 || /row level security|permission denied|not authorized/.test(message)) {
    return 'authorization-denied';
  }
  if (status === 401 || /unauthori[sz]ed/.test(message)) {
    return 'session-expired';
  }
  return null;
}

/**
 * Programme 27 (Iteration-4 disposition), re-derived in Programme 28
 * (§1) as `classifyCardImageStorageError(error) !== null`: is this
 * storage error one that MUST ABORT a workspace-mode save, as opposed
 * to a recoverable upload failure?
 *
 * The upload flow's long-standing contract treats a failed write as
 * recoverable (warn; that response is returned unchanged). In
 * WORKSPACE mode that contract is unsafe for either abort-worthy
 * class: letting the save proceed would persist the base64 `data:`
 * image inside a workspace-scoped automation record even though
 * storage refused the workspace-prefixed write. The caller therefore
 * classifies the error (classifyCardImageStorageError, which see for
 * the exact identification rules — symmetric status parsing,
 * hyphen/space-normalized message matching, and the residual
 * ambiguity) and ABORTS the mutation whenever this predicate holds;
 * the class then decides WHICH typed error the abort carries
 * ('authorization-denied' ⇒ 'insufficient-role', 'session-expired'
 * ⇒ 'session-expired'). The boolean contract of THIS predicate is
 * unchanged from P27: true exactly for the 401/403 statuses and the
 * denial/unauthorized message vocabulary (now matched after
 * normalization, and with `status` parsed symmetrically with
 * `statusCode`). Legacy mode never consults this predicate: its
 * warn-and-unchanged behaviour is unchanged.
 */
export function isCardImageStorageDenial(error: unknown): boolean {
  return classifyCardImageStorageError(error) !== null;
}

export type CardImageOwnerKind = 'workspace' | 'user' | 'unknown';

export interface CardImageOwnerScope {
  kind: CardImageOwnerKind;
  /** The path's first segment, or null when the path has no usable first segment. */
  id: string | null;
}

export interface CardImageOwnerScopeHints {
  /** Ids known (e.g. loaded from public.workspaces) to be workspaces. */
  workspaceIds?: ReadonlySet<string> | readonly string[];
  /** Ids known (e.g. loaded from auth.users / profiles) to be users. */
  userIds?: ReadonlySet<string> | readonly string[];
}

function contains(ids: ReadonlySet<string> | readonly string[] | undefined, id: string): boolean {
  if (!ids) return false;
  return Array.isArray(ids) ? ids.includes(id) : (ids as ReadonlySet<string>).has(id);
}

/**
 * Report which owner scope a card-image path belongs to, for policy /
 * audit use: parses the path's first segment and classifies it.
 *
 * A UUID-shaped segment is classified 'workspace' or 'user' ONLY when
 * the caller's known-id hints contain it (the audit-time analogue of
 * …000033's workspaces-row existence check). An unmatched UUID, a
 * non-UUID segment, and an empty path are all reported 'unknown' —
 * this helper never guesses ownership from shape alone.
 */
export function cardImageOwnerScope(
  path: string,
  hints: CardImageOwnerScopeHints = {},
): CardImageOwnerScope {
  const first = typeof path === 'string' ? path.split('/')[0] : undefined;
  if (!first) return { kind: 'unknown', id: null };
  if (!UUID_RE.test(first)) return { kind: 'unknown', id: first };
  if (contains(hints.workspaceIds, first)) return { kind: 'workspace', id: first };
  if (contains(hints.userIds, first)) return { kind: 'user', id: first };
  return { kind: 'unknown', id: first };
}
