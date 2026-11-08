'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';
import { createBrowserClient } from '@/lib/supabase';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  assertCardImageUploadScope,
  cardImagePathForScope,
  cardImageUploadScopeFromSelection,
  classifyCardImageStorageError,
  type CardImageUploadScope,
} from '@/lib/storage/cardImages';
import { WorkspaceAccessError } from '@/lib/tenancy/context';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';

export interface AutomationFromDB {
  id: string;
  name: string;
  type: 'comment_dm' | 'dm_reply' | 'story_reply';
  is_active: boolean;
  post_id: string | null;
  post_thumbnail_url: string | null;
  post_caption: string | null;
  keywords: string[] | null;
  comment_reply_options: string[];
  public_reply_enabled?: boolean;
  public_reply_options?: string[];
  follow_up_enabled?: boolean;
  follow_up_delay_minutes?: number;
  follow_up_message?: string;
  dm_opening_message_enabled: boolean;
  dm_opening_message: string;
  dm_opening_message_button_title: string | null;
  dm_opening_message_button_link: string | null;
  ask_to_follow_enabled: boolean;
  ask_to_follow_message: string;
  ask_to_follow_visit_profile_button: string;
  ask_to_follow_confirm_button: string;
  dm_responses: DMResponse[];
  total_dms_sent: number;
  created_at: string;
  updated_at: string;
  instagram_account_id: string;
  instagram_accounts: {
    id: string;
    username: string;
    profile_picture_url: string | null;
  } | null;
}

export interface DMResponse {
  id: string;
  type: 'text' | 'card' | 'ask_follow' | 'lead_form';
  content: string;
  buttonTitle?: string;
  buttonLink?: string;
  cardImage?: string;
  cardTitle?: string;
  cardSubtitle?: string;
  cardButtons?: { id: string; title: string; link: string }[];
}

export interface CreateAutomationPayload {
  instagramAccountId: string;
  name: string;
  type: 'comment_dm' | 'dm_reply' | 'story_reply';
  isActive?: boolean;
  postId?: string | null;
  postThumbnailUrl?: string | null;
  postCaption?: string | null;
  keywords?: string[] | null;
  commentReplyOptions?: string[];
  dmOpeningMessageEnabled?: boolean;
  dmOpeningMessage?: string;
  dmOpeningMessageButtonTitle?: string | null;
  dmOpeningMessageButtonLink?: string | null;
  askToFollowEnabled?: boolean;
  askToFollowMessage?: string;
  askToFollowVisitProfileButton?: string;
  askToFollowConfirmButton?: string;
  dmResponses?: DMResponse[];
  publicReplyEnabled?: boolean;
  publicReplyOptions?: string[];
  followUpEnabled?: boolean;
  followUpDelayMinutes?: number;
  followUpMessage?: string;
}

export interface UpdateAutomationPayload {
  is_active?: boolean;
  name?: string;
  keywords?: string[] | null;
  comment_reply_options?: string[];
  dm_opening_message_enabled?: boolean;
  dm_opening_message?: string;
  dm_opening_message_button_title?: string | null;
  dm_opening_message_button_link?: string | null;
  post_thumbnail_url?: string | null;
  post_caption?: string | null;
  ask_to_follow_enabled?: boolean;
  ask_to_follow_message?: string;
  ask_to_follow_visit_profile_button?: string;
  ask_to_follow_confirm_button?: string;
  dm_responses?: DMResponse[];
  public_reply_enabled?: boolean;
  public_reply_options?: string[];
  follow_up_enabled?: boolean;
  follow_up_delay_minutes?: number;
  follow_up_message?: string;
}

/**
 * Programme 26 (PF-5): resolve the card-image upload scope from the
 * workspace runtime state. The flag arrives as a server-passed prop on
 * the WorkspaceProvider (there is deliberately no client env var); the
 * selection comes from the provider's member-derived list.
 *
 * Programme 27 (Iteration-4 §4.2): the create/update mutations resolve
 * ONE captured workspace context per mutation attempt — this hook —
 * instead of reading provider state twice. The upload scope (storage
 * prefix) and the request scope (`x-workspace-id` selector) are both
 * derived here, in one render, from the SAME selectedWorkspace object,
 * so the two can never name different workspaces; a selection change
 * mid-operation cannot split the operation across workspaces — it
 * completes (or fails) under the workspace selected when it started.
 * Flag OFF ⇒ both scopes are legacy, always.
 */
function useAutomationWorkspaceContext(): {
  uploadScope: CardImageUploadScope;
  requestScope: WorkspaceRequestScope;
} {
  const { workspaceRuntimeEnabled, selectedWorkspace } = useWorkspace();
  return {
    uploadScope: cardImageUploadScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspace }),
    requestScope: workspaceRequestScopeFromSelection({
      workspaceRuntimeEnabled,
      selectedWorkspaceId: selectedWorkspace?.workspaceId ?? null,
    }),
  };
}

/**
 * Programme 27: the request scope for the automations operations that
 * carry no card-image step (list, toggle, delete). Same discipline as
 * the captured context above (lib/tenancy/clientRequest.ts): flag OFF
 * ⇒ legacy, and sendWorkspaceRequest reproduces the pre-P27 apiClient
 * call exactly; flag ON + no selection ⇒ fail closed before any
 * request.
 */
function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

/**
 * One mutation attempt's upload ledger (Programme 27, Iteration-4
 * §2E): every object processCardImages successfully uploads during
 * the attempt is recorded here, so that when the mutation as a whole
 * definitely fails, the caller can attempt a best-effort orphan
 * reduction over EXACTLY the objects this attempt created — nothing
 * older, nothing belonging to another attempt. (Programme 28 §3:
 * the ledger is a REQUIRED argument of processCardImages, and on an
 * ambiguous-outcome failure the caller deliberately does NOT delete
 * from it — see shouldCleanUpAfterFailedSave; Programme 29: the
 * ambiguous path instead reconciles by read-back over this ledger —
 * see reconcileAmbiguousSaveOutcome.)
 */
export interface CardImageUploadAttempt {
  uploadedPaths: string[];
}

/**
 * Upload base64 card images to Supabase Storage and return responses with public URLs.
 *
 * Programme 26 (PF-5): the upload path is selected by `scope` through
 * src/lib/storage/cardImages.ts; the legacy scope reproduces the
 * historic user-folder path byte-for-byte. In workspace mode the scope
 * is validated BEFORE any write (missing selection ⇒
 * 'workspace-context-required', viewer ⇒ 'insufficient-role', no
 * session ⇒ 'not-a-member') and there is NO fallback to the legacy
 * path.
 *
 * Programme 27 (Iteration-4 dispositions):
 *   - `scope` is a REQUIRED argument (it previously defaulted to
 *     legacy): a future caller that omits it now fails at compile
 *     time instead of silently writing legacy paths.
 *   - A RECOVERABLE storage failure keeps the flow's long-standing
 *     semantics in both modes: warn and return that response unchanged
 *     (its `data:` image flows into the payload as-is).
 *   - An abort-worthy storage write (Programme 27: distinguished
 *     from a recoverable failure by isCardImageStorageDenial) ABORTS
 *     the whole mutation in workspace mode with a typed
 *     WorkspaceAccessError — a workspace save must never persist a
 *     `data:` image because storage refused the workspace prefix.
 *     Legacy mode never aborts on an upload error.
 *
 * Programme 28 dispositions:
 *   - `attempt` is a REQUIRED argument (§3i — it was optional in
 *     P27): every caller passes its attempt ledger explicitly, and
 *     each successful upload's path is recorded in it for the
 *     caller's failure-path best-effort orphan reduction.
 *   - The abort's error code follows the classifier
 *     (classifyCardImageStorageError, §1/§1b): class
 *     'authorization-denied' ⇒ WorkspaceAccessError
 *     ('insufficient-role'); class 'session-expired' ⇒
 *     WorkspaceAccessError ('session-expired') — a 401 is an
 *     authentication/session refusal and is NO LONGER described as
 *     an insufficient-role (membership/role) failure.
 *   - Settle-before-throw (§3iii): the per-response tasks run under
 *     Promise.allSettled, not Promise.all. A rejection therefore
 *     surfaces only after EVERY sibling upload has settled, so the
 *     attempt ledger is complete before any throw propagates to the
 *     caller's cleanup; the error thrown is the FIRST rejection in
 *     response order.
 */
export async function processCardImages(
  responses: DMResponse[],
  scope: CardImageUploadScope,
  attempt: CardImageUploadAttempt,
): Promise<DMResponse[]> {
  const supabase = createBrowserClient();
  const { data: { session } } = await supabase.auth.getSession();

  const needsUpload = responses.some((r) => r.type === 'card' && !!r.cardImage?.startsWith('data:'));

  if (!session) {
    if (needsUpload && scope.kind !== 'legacy') {
      throw new WorkspaceAccessError(
        'not-a-member',
        'Card-image upload requires an authenticated session in workspace mode.',
      );
    }
    return responses;
  }

  if (needsUpload) assertCardImageUploadScope(scope, session.user.id);

  // Programme 28 (§3iii): settle semantics — see the doc comment.
  // Every per-response task runs to settlement via Promise.allSettled;
  // fulfilled values are collected in response order, and only after
  // ALL tasks have settled is the FIRST rejection (in response order)
  // thrown. Ledger pushes happen inside each task on success, so the
  // ledger is complete before any throw propagates.
  const settled = await Promise.allSettled(
    responses.map(async (r) => {
      if (r.type !== 'card' || !r.cardImage?.startsWith('data:')) return r;

      const mimeMatch = r.cardImage.match(/^data:([^;]+);base64,/);
      const mimeType = mimeMatch?.[1] ?? 'image/jpeg';
      const base64Data = r.cardImage.split(',')[1];
      if (!base64Data) return r;

      const byteArray = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const blob = new Blob([byteArray], { type: mimeType });

      const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
      const path = cardImagePathForScope(scope, session.user.id, ext);

      const { data: uploadData, error } = await supabase.storage
        .from('card-images')
        .upload(path, blob, { contentType: mimeType, upsert: false });

      if (error || !uploadData) {
        const errorClass =
          error && scope.kind === 'workspace' ? classifyCardImageStorageError(error) : null;
        if (errorClass === 'session-expired') {
          // Programme 28 (§1b): an authentication/session refusal
          // (401-shaped — e.g. an expired session). Abort the whole
          // mutation, but claim NO membership/role cause: the code
          // and message name only the session-shaped refusal.
          throw new WorkspaceAccessError(
            'session-expired',
            'Card-image upload was refused with an authentication/session error (for example, an expired session); the save was aborted and nothing was submitted.',
          );
        }
        if (errorClass === 'authorization-denied') {
          // Authorization denial in workspace mode (…000033 live
          // membership re-check failed at write time — revoked or
          // demoted since the workspace list loaded). Abort the whole
          // mutation: no record may be saved carrying this `data:`
          // image under a workspace it could not write to. The code
          // names the failed capability (the workspace write check);
          // the storage error cannot distinguish revocation from a
          // role reduction, and the message claims neither.
          throw new WorkspaceAccessError(
            'insufficient-role',
            'Card-image upload was denied by storage authorization for the selected workspace; the save was aborted and nothing was submitted.',
          );
        }
        console.warn('Card image upload failed:', error?.message);
        return r;
      }

      attempt.uploadedPaths.push(uploadData.path);

      const { data: { publicUrl } } = supabase.storage.from('card-images').getPublicUrl(uploadData.path);
      return { ...r, cardImage: publicUrl };
    }),
  );

  const processed: DMResponse[] = [];
  let firstRejection: unknown;
  let hasRejection = false;
  for (const result of settled) {
    if (result.status === 'rejected') {
      if (!hasRejection) {
        hasRejection = true;
        firstRejection = result.reason;
      }
    } else {
      processed.push(result.value);
    }
  }
  if (hasRejection) throw firstRejection;
  return processed;
}

/**
 * Is this HTTP status one the automation save routes demonstrably
 * emit ONLY before any persistence — i.e. does an `ApiError`
 * carrying it PROVE the save did not commit (or, for the one
 * documented 404 sub-path, that no surviving record can reference
 * the attempt's uploads)?
 *
 * Programme 29 (§1) established the route truth from the handlers
 * but stated it as the whole 400–499 range; ChatGPT's Iteration-7
 * review REJECTED that breadth as the P0 correction: the handlers
 * emit only four 4xx statuses, and a range claim also blessed
 * statuses the routes never emit (409, 422) and 499 — an
 * intermediary/client-close status that proves nothing about
 * whether the origin committed. Programme 31 therefore narrowed
 * this predicate to the explicit allowlist below, re-verified
 * return-point by return-point against the current code (full
 * evidence table in
 * `saas/PHASE_31_PROVEN_RESPONSE_CLASSIFICATION_CORRECTION.md` §1;
 * the P29 enumeration is in
 * `saas/PHASE_29_SAVE_OUTCOME_RECONCILIATION.md` §1).
 *
 * The allowlist, with its per-status basis:
 *
 *   - 401 — `unauthorized()` (lib/auth) is the first statement of
 *     POST /api/automations and PUT /api/automations/[id]; it
 *     precedes every database call in the legacy AND workspace
 *     branches (the workspace branch is entered only after auth).
 *   - 400 — invalid JSON, Zod validation and flow-graph validation
 *     returns in both handlers (both branches, all before the
 *     persistence call), plus the workspace layer's
 *     missing-selector failure (routeContext maps
 *     'workspace-context-required' → 400; resolution runs before
 *     any repository use).
 *   - 403 — pre-write checks only: the legacy POST's IG-account
 *     ownership READ (before the insert); workspace-resolution
 *     failures (not-a-member / insufficient-role /
 *     cross-workspace-row / unbound-row → 403) during
 *     pre-persistence resolution; requireCapability's
 *     insufficient-role gate, thrown before repository use; and
 *     the tenant repository's own pre-write throws inside
 *     insert/updateById (assertWrite, rejectForeignWorkspace, and
 *     updateById's pre-update row assertion — all thrown before
 *     the DB write). The single post-write WorkspaceAccessError
 *     source — updateById's post-update re-read row assertion —
 *     is UNREACHABLE for the row just written: the pre-update read
 *     asserted that row's workspace_id equals the context's,
 *     updateById strips `workspace_id` from the patch, and the
 *     update is scope-filtered to the same workspace, so the
 *     re-read row cannot fail the assertion. Every reachable
 *     post-commit failure in the workspace PUT therefore maps to
 *     500, not 403.
 *   - 404 — no-row reads: the legacy PUT's existing-row fetch; the
 *     workspace POST's bound-account lookup; the workspace PUT's
 *     by-id load; and updateById returning null. That null has
 *     two sub-paths: (i) its pre-update read found no row — no
 *     write was attempted; (ii) its post-update re-read found no
 *     row — reachable only when the row was concurrently deleted
 *     (between pre-read and update ⇒ the update matched zero rows
 *     and nothing committed; or between update and re-read ⇒ the
 *     save committed but the only record that could reference the
 *     attempt's uploads was itself deleted). In every 404
 *     sub-path no surviving record can reference the uploads, so
 *     cleanup cannot break a live record.
 *
 * Everything else is NOT proven non-commit:
 *   - 409, 422, 499 and every other 4xx are not emitted by these
 *     handlers at all; nothing about their origin semantics is
 *     established, so they stay ambiguous.
 *   - 5xx proves NOTHING at the client: although each route's own
 *     500 follows a rolled-back single PostgREST write, apiClient
 *     builds `ApiError` from ANY non-OK response, including
 *     platform/gateway 5xx generated after the origin committed —
 *     and the workspace PUT has an in-code commit-then-500 path
 *     (its repository update re-reads the row after the write; a
 *     failure there returns 500 with the write already committed).
 *
 * Provenance boundary (Iteration-7 finding 10, still open as an
 * external-validation item): this allowlist is proven for
 * responses emitted by these ORIGIN handlers. Route code cannot
 * establish whether an intermediary (CDN/WAF/gateway) on a given
 * deployment path could originate or rewrite a response into an
 * allowlisted status; statuses intermediaries commonly originate
 * (429, 499) are deliberately excluded for exactly that reason.
 *
 * STANDING WARNING — re-establish before extending: any future
 * handler or repository change that (a) emits a new
 * pre-persistence status, (b) moves any allowlisted status to a
 * post-persistence return point, or (c) changes updateById's
 * patch-stripping / scope-filtering (the basis for the 403
 * re-read unreachability above) invalidates this list until it
 * is re-established from the route code, the same discipline
 * Programme 29's repository-assumption note imposed.
 */
const PROVEN_NON_COMMIT_API_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

export function isProvenNonCommitApiStatus(status: number): boolean {
  return PROVEN_NON_COMMIT_API_STATUSES.has(status);
}

/**
 * The ambiguous-outcome rule for failure-path cleanup — should the
 * caller delete this attempt's uploaded card images after a failed
 * save? PURE decision helper (the mutations supply the facts; this
 * function decides).
 *
 * Programme 28 (§3ii) introduced the rule with three definite
 * classes; Programme 29 NARROWED the `ApiError` class after
 * ChatGPT's Iteration-6 review rejected it as specified (an HTTP
 * error response — above all a 5xx — does not prove the save did
 * not commit) and §1 of the P29 report established the route truth.
 * Cleanup now runs ONLY on VERIFIED non-commit:
 *   - `requestSent` is false — anything thrown BEFORE the mutation
 *     request phase was reached (the processCardImages phase: scope
 *     gates, storage-denial / session-expired aborts, recoverable
 *     processing errors). The save request was never sent, so no
 *     server record can reference the uploaded images ⇒ definite.
 *   - The request phase was reached and the error is a
 *     `WorkspaceAccessError` — sendWorkspaceRequest's fail-closed
 *     pre-request throw (e.g. 'workspace-context-required'), raised
 *     BEFORE the transport ran, so again nothing was sent ⇒ definite.
 *   - The request phase was reached and the error is an `ApiError`
 *     whose status is in the proven non-commit allowlist
 *     (isProvenNonCommitApiStatus: exactly {400, 401, 403, 404} —
 *     see its doc for the per-status route evidence; Programme 31
 *     narrowed Programme 29's original 400–499 range after
 *     ChatGPT's Iteration-7 P0) ⇒ definite.
 *
 * ANY other error escaping the request phase is AMBIGUOUS: an
 * `ApiError` 5xx (the save may have committed before a gateway or
 * post-write failure produced the response) and transport failures
 * (fetch TypeError / abort / timeout — no response received; the
 * server may have committed before the connection failed).
 * Deleting the images could then break a live record that
 * references them, so cleanup is SKIPPED and the caller runs the
 * Programme 29 reconciliation instead (read-back + log — see
 * reconcileAmbiguousSaveOutcome); possible orphans are accepted.
 *
 * @param requestSent whether the mutation had reached its request
 *   phase (the sendWorkspaceRequest call) when the error was thrown.
 */
export function shouldCleanUpAfterFailedSave(error: unknown, requestSent: boolean): boolean {
  if (!requestSent) return true;
  if (error instanceof WorkspaceAccessError) return true;
  if (error instanceof ApiError) return isProvenNonCommitApiStatus(error.status);
  return false;
}

/**
 * Programme 27 (Iteration-4 §2E), language corrected in Programme 28
 * (§3iv): best-effort orphan REDUCTION for a failed mutation attempt
 * — delete exactly the objects that attempt uploaded
 * (CardImageUploadAttempt). This is a best-effort reduction only; it
 * does NOT prevent or guarantee against orphaned card images:
 *   - on an ambiguous-outcome failure the caller does not invoke it
 *     at all (Programme 28 §3ii — the save may have committed and may
 *     reference the images, so possible orphans are accepted there);
 *   - a cleanup attempt itself can fail — including a storage-RLS
 *     refusal (…000033's DELETE policy requires owner/admin, so a
 *     member's own cleanup can be denied) — in which case the objects
 *     stay orphaned under the uploader's own prefix, where the
 *     standing orphan-cleanup decision applies.
 * NEVER throws and NEVER masks the original mutation error: a cleanup
 * failure is logged. Confined to failure paths: the success path of
 * every mutation is untouched.
 */
export async function removeUploadedCardImages(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const supabase = createBrowserClient();
    const { error } = await supabase.storage.from('card-images').remove([...paths]);
    if (error) console.warn('Card image cleanup failed:', error.message);
  } catch (cleanupError) {
    console.warn('Card image cleanup failed:', cleanupError);
  }
}

/**
 * Programme 29 (§3): reconciliation for an AMBIGUOUS save outcome
 * (shouldCleanUpAfterFailedSave returned false). The save may have
 * committed despite the error the caller saw (a 5xx after the write,
 * or a response lost in transport), so the attempt's uploads must
 * NOT be deleted on suspicion. This read-back — the local-tier
 * reconciliation path — performs ONE list read through the same
 * request path the builder itself uses (the captured request scope's
 * GET /automations, which returns `dm_responses`) and checks whether
 * any saved automation references any of this attempt's uploaded
 * images (by the exact public URL the upload produced, or by the
 * storage path as a URL suffix, so a differing public-URL origin
 * cannot hide a reference).
 *
 * Outcomes:
 *   - 'referenced' — a saved record references at least one uploaded
 *     image: the save DID commit (at least in part). Those images
 *     must never be deleted for this attempt.
 *   - 'not-referenced' — the read completed and no saved record
 *     references the uploads. This does NOT prove non-commit (a
 *     commit could still be invisible to this read), so deletion
 *     STILL does not run — the read-back can only ever VETO a
 *     deletion or confirm a commit, never enable a deletion.
 *   - 'inconclusive' — the read itself failed; commit state stays
 *     unknown.
 *
 * Pure orchestration over injected seams (the caller supplies the
 * real list loader and URL mapper; tests supply fakes). NEVER
 * throws.
 */
export type SaveOutcomeReconciliation =
  | { outcome: 'referenced'; referencedPaths: string[] }
  | { outcome: 'not-referenced'; referencedPaths: string[] }
  | { outcome: 'inconclusive'; referencedPaths: string[] };

export async function reconcileAmbiguousSaveOutcome(input: {
  uploadedPaths: readonly string[];
  publicUrlForPath: (storagePath: string) => string;
  loadAutomations: () => Promise<
    readonly { dm_responses?: readonly { cardImage?: string }[] | null }[]
  >;
}): Promise<SaveOutcomeReconciliation> {
  if (input.uploadedPaths.length === 0) {
    return { outcome: 'not-referenced', referencedPaths: [] };
  }
  let rows: readonly { dm_responses?: readonly { cardImage?: string }[] | null }[];
  try {
    rows = await input.loadAutomations();
  } catch {
    return { outcome: 'inconclusive', referencedPaths: [] };
  }
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const response of row.dm_responses ?? []) {
      const image = response?.cardImage;
      if (!image) continue;
      for (const storagePath of input.uploadedPaths) {
        if (image === input.publicUrlForPath(storagePath) || image.endsWith(`/${storagePath}`)) {
          referenced.add(storagePath);
        }
      }
    }
  }
  return referenced.size > 0
    ? { outcome: 'referenced', referencedPaths: [...referenced] }
    : { outcome: 'not-referenced', referencedPaths: [] };
}

/**
 * Programme 29 (§2/§3): the caller-side reconciliation record for an
 * ambiguous save outcome. Runs the read-back and logs ONE structured
 * reconciliation entry (the reconciliation trail at this tier):
 * operation, outcome, the attempt's uploaded paths and — when the
 * save is confirmed committed — exactly which paths are referenced.
 * Deletion NEVER runs here, whatever the outcome (see
 * reconcileAmbiguousSaveOutcome). NEVER throws and NEVER masks the
 * original mutation error: the caller rethrows it after this
 * resolves.
 */
async function reconcileAndLogAmbiguousSave(
  operation: 'create' | 'update',
  requestScope: WorkspaceRequestScope,
  attempt: CardImageUploadAttempt,
): Promise<void> {
  let result: SaveOutcomeReconciliation;
  try {
    result = await reconcileAmbiguousSaveOutcome({
      uploadedPaths: attempt.uploadedPaths,
      publicUrlForPath: (storagePath) =>
        createBrowserClient().storage.from('card-images').getPublicUrl(storagePath).data.publicUrl,
      loadAutomations: async () => {
        const res = await sendWorkspaceRequest<{ automations: AutomationFromDB[] }>(
          requestScope,
          '/automations',
        );
        return res.automations;
      },
    });
  } catch {
    result = { outcome: 'inconclusive', referencedPaths: [] };
  }
  const note =
    result.outcome === 'referenced'
      ? 'A saved automation references this attempt\'s uploaded card images: the save DID commit despite the error. The images were NOT deleted; check the automation before retrying instead of re-saving blindly.'
      : result.outcome === 'not-referenced'
        ? 'Read-back found no saved automation referencing this attempt\'s uploaded card images, but non-commit is not proven; the images were deliberately NOT deleted and possible orphans are accepted.'
        : 'Read-back could not be completed, so the commit state is unknown; the images were deliberately NOT deleted and possible orphans are accepted.';
  console.warn('Card image save-outcome reconciliation:', {
    operation,
    outcome: result.outcome,
    uploadedPaths: [...attempt.uploadedPaths],
    ...(result.outcome === 'referenced' ? { referencedPaths: result.referencedPaths } : {}),
    note,
  });
}

export function useAutomations(accountId?: string | null) {
  const requestScope = useWorkspaceRequestScope();
  return useQuery({
    // Programme 27: in workspace mode the list is scoped to the
    // selected workspace — the selector travels with the request AND
    // the cache key names the workspace, so switching workspaces can
    // never render the previous workspace's cached list. Flag OFF the
    // key is exactly the pre-P27 two-element key.
    queryKey:
      requestScope.kind === 'workspace'
        ? ['automations', accountId ?? 'all', requestScope.workspaceId]
        : ['automations', accountId ?? 'all'],
    queryFn: () =>
      sendWorkspaceRequest<{ automations: AutomationFromDB[] }>(
        requestScope,
        `/automations${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`
      ).then((r) => r.automations),
    // Flakiness fix (2026-11-08, investigation fix-plan item 3): do
    // not fire before the WorkspaceProvider scope resolves. While
    // the scope is 'unavailable' the queryFn would throw
    // workspace-context-required BEFORE any network call — instantly
    // burning React Query's one retry on a scope that was about to
    // exist. Disabled queries simply wait; when the scope lands,
    // the (workspace-named) key's query starts for real.
    enabled: requestScope.kind !== 'unavailable',
  });
}

export function useCreateAutomation() {
  const queryClient = useQueryClient();
  // ONE captured workspace context for the whole attempt (P27).
  const { uploadScope, requestScope } = useAutomationWorkspaceContext();

  return useMutation({
    mutationFn: async (payload: CreateAutomationPayload) => {
      const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
      // Programme 28 (§3ii): tracks whether the request phase was
      // reached, for the ambiguous-outcome cleanup rule below.
      let requestSent = false;
      try {
        const processedResponses = await processCardImages(payload.dmResponses ?? [], uploadScope, attempt);
        requestSent = true;
        return await sendWorkspaceRequest<{ automation: AutomationFromDB }>(requestScope, '/automations', {
          method: 'POST',
          body: JSON.stringify({ ...payload, dmResponses: processedResponses }),
        });
      } catch (err) {
        // Attempt-scoped best-effort orphan reduction (P27 §2E),
        // gated by the ambiguous-outcome rule (P28 §3ii, narrowed by
        // Programme 29): cleanup runs ONLY on VERIFIED non-commit
        // (see shouldCleanUpAfterFailedSave — pre-request failures,
        // the fail-closed WorkspaceAccessError, and ApiError statuses
        // the routes can only emit before persistence). On an
        // ambiguous outcome (ApiError 5xx, transport failure) the
        // save may have committed and may reference the uploaded
        // images, so they are deliberately NOT deleted; instead the
        // Programme 29 reconciliation runs (one read-back + a
        // structured log entry) and possible orphans are accepted.
        // Never masks the original error.
        if (shouldCleanUpAfterFailedSave(err, requestSent)) {
          await removeUploadedCardImages(attempt.uploadedPaths);
        } else {
          await reconcileAndLogAmbiguousSave('create', requestScope, attempt);
        }
        throw err;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useToggleAutomation() {
  const queryClient = useQueryClient();
  const requestScope = useWorkspaceRequestScope();

  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      sendWorkspaceRequest<{ automation: AutomationFromDB }>(requestScope, `/automations/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: isActive }),
      }),
    onMutate: async ({ id, isActive }) => {
      await queryClient.cancelQueries({ queryKey: ['automations'] });
      const previous = queryClient.getQueryData<AutomationFromDB[]>(['automations']);
      queryClient.setQueryData<AutomationFromDB[]>(['automations'], (old) =>
        old?.map((a) => (a.id === id ? { ...a, is_active: isActive } : a)) ?? []
      );
      return { previous };
    },
    onError: (_err: ApiError, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['automations'], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  const requestScope = useWorkspaceRequestScope();

  return useMutation({
    mutationFn: (id: string) =>
      sendWorkspaceRequest<{ success: boolean }>(requestScope, `/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useUpdateAutomation() {
  const queryClient = useQueryClient();
  // ONE captured workspace context for the whole attempt (P27).
  const { uploadScope, requestScope } = useAutomationWorkspaceContext();

  return useMutation({
    mutationFn: async ({ id, ...payload }: { id: string } & UpdateAutomationPayload) => {
      const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
      // Programme 28 (§3ii): tracks whether the request phase was
      // reached, for the ambiguous-outcome cleanup rule below.
      let requestSent = false;
      try {
        const processedResponses = payload.dm_responses
          ? await processCardImages(payload.dm_responses, uploadScope, attempt)
          : undefined;
        requestSent = true;
        return await sendWorkspaceRequest<{ automation: AutomationFromDB }>(requestScope, `/automations/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...payload, dm_responses: processedResponses }),
        });
      } catch (err) {
        // Attempt-scoped best-effort orphan reduction (P27 §2E),
        // gated by the ambiguous-outcome rule (P28 §3ii, narrowed by
        // Programme 29): cleanup runs ONLY on VERIFIED non-commit
        // (see shouldCleanUpAfterFailedSave — pre-request failures,
        // the fail-closed WorkspaceAccessError, and ApiError statuses
        // the routes can only emit before persistence). On an
        // ambiguous outcome (ApiError 5xx, transport failure) the
        // save may have committed and may reference the uploaded
        // images, so they are deliberately NOT deleted; instead the
        // Programme 29 reconciliation runs (one read-back + a
        // structured log entry) and possible orphans are accepted.
        // Never masks the original error.
        if (shouldCleanUpAfterFailedSave(err, requestSent)) {
          await removeUploadedCardImages(attempt.uploadedPaths);
        } else {
          await reconcileAndLogAmbiguousSave('update', requestScope, attempt);
        }
        throw err;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}
