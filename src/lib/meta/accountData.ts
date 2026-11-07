/**
 * Scoped data operations for the Meta deauthorize / data-deletion callbacks.
 *
 * Two identity cases, both keyed by the app-scoped ID from a *verified*
 * signed_request (callers must verify before calling anything here):
 *
 *  1. Connected account (the ID is an account owner who connected their IG):
 *     the row in instagram_accounts whose instagram_user_id matches. That
 *     column stores the IG-scoped ID returned as `id` by the IG /me endpoint
 *     at connect time - the same ID space the callbacks use.
 *  2. Audience member (the ID interacted with someone else's automations):
 *     rows keyed by that IGSID in contacts / automation_sessions /
 *     dm_sent_log / dm_jobs, plus pending job_queue payloads.
 *
 * STRICT SCOPING: every delete is filtered by the exact ID (and, for the
 * account row, by BOTH the row PK and the IG ID). A given app-scoped IGSID
 * identifies exactly one Instagram user within this app, so rows matching
 * it are that person's rows by definition; nothing else can match.
 *
 * Cascade map (verified in supabase/migrations/20260729000001 + ...03 +
 * 20260730000001): deleting an instagram_accounts row cascades to
 * automations (→ dm_jobs, dm_sent_log, automation_sessions → dm_logs),
 * dm_jobs, dm_sent_log, automation_sessions, contacts and dm_rate_events.
 * job_queue has NO foreign keys, so pending jobs are matched on the payload
 * JSONB instead (payload.triggerUserId is the audience IGSID for auto_dm /
 * follow_up jobs).
 *
 * debug_events is deliberately out of scope: it has no identity column,
 * only fuzzy JSONB metadata, and the housekeeping RPC purges it after
 * 7 days.
 *
 * All functions take the Supabase client as a parameter so they can be
 * unit-tested with a fake client - no real database is touched in tests.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Connected accounts ──────────────────────────────────────────────────────

export interface ConnectedAccountRow {
  id: string;
  user_id: string;
  instagram_user_id: string;
  username: string;
  /** Phase D1: workspace binding (…000026); null/absent for legacy rows. */
  workspace_id?: string | null;
}

export async function findConnectedAccountByIgId(
  db: SupabaseClient,
  igId: string
): Promise<ConnectedAccountRow | null> {
  const { data, error } = await db
    .from('instagram_accounts')
    .select('id, user_id, instagram_user_id, username, workspace_id')
    .eq('instagram_user_id', igId)
    .maybeSingle<ConnectedAccountRow>();
  if (error) throw new Error(`instagram_accounts lookup failed: ${error.message}`);
  return data ?? null;
}

/**
 * Delete a connected account row. Double-scoped by PK + IG ID so a stale or
 * mismatched row object can never delete the wrong tenant's connection.
 * All account-owned data (automations, jobs, logs, sessions, contacts,
 * rate events, the encrypted token) goes with it via ON DELETE CASCADE.
 * Idempotent: deleting an already-deleted row is a no-op success.
 */
export async function deleteConnectedAccount(db: SupabaseClient, account: ConnectedAccountRow): Promise<void> {
  const { error } = await db
    .from('instagram_accounts')
    .delete()
    .eq('id', account.id)
    .eq('instagram_user_id', account.instagram_user_id);
  if (error) throw new Error(`instagram_accounts delete failed: ${error.message}`);
}

// ── Audience data ───────────────────────────────────────────────────────────

export interface AudienceDeletionCounts {
  contacts: number;
  automationSessions: number; // dm_logs rows under these sessions cascade with them
  dmSentLog: number;
  dmJobs: number;
  queuedJobs: number;
  total: number;
}

/**
 * Delete every audience row keyed by the given IGSID. Each delete is
 * filtered by that exact IGSID only. Throws an aggregate error naming the
 * failed tables if any delete fails - deletes that already succeeded stay
 * deleted, and the whole operation is idempotent, so a retry safely
 * completes whatever remains.
 */
export async function deleteAudienceData(db: SupabaseClient, igId: string): Promise<AudienceDeletionCounts> {
  const counts: AudienceDeletionCounts = {
    contacts: 0,
    automationSessions: 0,
    dmSentLog: 0,
    dmJobs: 0,
    queuedJobs: 0,
    total: 0,
  };
  const failures: string[] = [];

  const attempt = async (
    table: string,
    run: () => PromiseLike<{ count: number | null; error: { message: string } | null }>
  ): Promise<number> => {
    const { count, error } = await run();
    if (error) failures.push(`${table}: ${error.message}`);
    return count ?? 0;
  };

  counts.contacts = await attempt('contacts', () =>
    db.from('contacts').delete({ count: 'exact' }).eq('audience_ig_user_id', igId)
  );

  // Deleting a session cascades to its dm_logs (conversation history).
  counts.automationSessions = await attempt('automation_sessions', () =>
    db.from('automation_sessions').delete({ count: 'exact' }).eq('audience_ig_user_id', igId)
  );

  counts.dmSentLog = await attempt('dm_sent_log', () =>
    db.from('dm_sent_log').delete({ count: 'exact' }).eq('trigger_user_id', igId)
  );

  counts.dmJobs = await attempt('dm_jobs', () =>
    db.from('dm_jobs').delete({ count: 'exact' }).eq('trigger_user_id', igId)
  );

  // job_queue has no FK/identity column: match the audience IGSID inside the
  // payload JSONB (payload->>'triggerUserId'). Only not-yet-executed jobs
  // are removed; done/failed rows are transient queue history purged by the
  // cleanup_old_rows housekeeping RPC within 7 days.
  counts.queuedJobs = await attempt('job_queue', () =>
    db
      .from('job_queue')
      .delete({ count: 'exact' })
      .filter('payload->>triggerUserId', 'eq', igId)
      .in('status', ['pending', 'processing'])
  );

  counts.total =
    counts.contacts + counts.automationSessions + counts.dmSentLog + counts.dmJobs + counts.queuedJobs;

  if (failures.length > 0) {
    throw new Error(`Audience deletion incomplete - failed tables: ${failures.join('; ')}`);
  }
  return counts;
}

// ── Deletion-request records ────────────────────────────────────────────────

export type DeletionRequestStatus = 'received' | 'processing' | 'completed' | 'failed' | 'not_found';

export interface DeletionRequestRow {
  id: string;
  meta_user_id: string;
  confirmation_code: string;
  status: DeletionRequestStatus;
  account_id: string | null;
  operator_user_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /**
   * Phase D1 (not a table column): processDeletionRequest fills this on
   * its RETURN value with the deleted account's workspace binding, so
   * callers can audit the sweep per workspace. Stored rows never carry it.
   */
  workspace_id?: string | null;
}

const REQUEST_COLUMNS =
  'id, meta_user_id, confirmation_code, status, account_id, operator_user_id, error, created_at, updated_at, completed_at';

// Unambiguous alphanumeric alphabet (no 0/O/1/l/I) for user-facing codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function generateConfirmationCode(length = 16): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Idempotency anchor for the deletion callback: if a non-failed request
 * already exists for this Meta user, reuse it (and its confirmation code)
 * so Meta retries of the same request return the same code. A history of
 * only-failed requests starts fresh.
 *
 * Note: reusing the record does NOT skip processing - processDeletionRequest
 * runs the deletion sweep on every valid callback, so data created after a
 * previous request (e.g. the user reconnected, then asked again) is still
 * deleted under the same record.
 */
export async function getOrCreateDeletionRequest(
  db: SupabaseClient,
  metaUserId: string
): Promise<{ row: DeletionRequestRow; created: boolean }> {
  const { data: existing, error: lookupError } = await db
    .from('data_deletion_requests')
    .select(REQUEST_COLUMNS)
    .eq('meta_user_id', metaUserId)
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<DeletionRequestRow>();
  if (lookupError) throw new Error(`data_deletion_requests lookup failed: ${lookupError.message}`);
  if (existing) return { row: existing, created: false };

  // Insert with a fresh random code; retry once on a code collision
  // (unique constraint) - vanishingly unlikely, but free to handle.
  for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
    const { data, error } = await db
      .from('data_deletion_requests')
      .insert({ meta_user_id: metaUserId, confirmation_code: generateConfirmationCode(), status: 'received' })
      .select(REQUEST_COLUMNS)
      .single<DeletionRequestRow>();
    if (!error && data) return { row: data, created: true };
    if (error && !/duplicate|unique/i.test(error.message)) {
      throw new Error(`data_deletion_requests insert failed: ${error.message}`);
    }
    if (attemptNo === 1 && error) {
      throw new Error(`data_deletion_requests insert failed: ${error.message}`);
    }
  }
  // Unreachable, but keeps the type checker honest.
  throw new Error('data_deletion_requests insert failed: exhausted retries');
}

export async function findDeletionRequestByCode(
  db: SupabaseClient,
  confirmationCode: string
): Promise<DeletionRequestRow | null> {
  const { data, error } = await db
    .from('data_deletion_requests')
    .select(REQUEST_COLUMNS)
    .eq('confirmation_code', confirmationCode)
    .maybeSingle<DeletionRequestRow>();
  if (error) throw new Error(`data_deletion_requests lookup failed: ${error.message}`);
  return data ?? null;
}

async function updateDeletionRequest(
  db: SupabaseClient,
  id: string,
  patch: Partial<{
    status: DeletionRequestStatus;
    account_id: string | null;
    operator_user_id: string | null;
    error: string | null;
    completed_at: string | null;
  }>
): Promise<void> {
  const { error } = await db.from('data_deletion_requests').update(patch).eq('id', id);
  if (error) throw new Error(`data_deletion_requests update failed: ${error.message}`);
}

/**
 * Run the deletion workflow for a request record:
 *   processing → (connected account? delete it, cascades included)
 *              → (always) sweep audience rows for the same IGSID
 *              → completed if anything was deleted (or a previous run had
 *                already completed), else not_found.
 * On any error the record is marked failed with a sanitised message and
 * the error is rethrown so the caller can log it; a later valid callback
 * (or Meta retry) re-drives the same record to completion.
 */
export async function processDeletionRequest(
  db: SupabaseClient,
  request: DeletionRequestRow
): Promise<DeletionRequestRow> {
  const previousStatus = request.status;
  await updateDeletionRequest(db, request.id, { status: 'processing', error: null });

  try {
    let deletedSomething = false;
    let deletedAccountWorkspaceId: string | null = null;

    const account = await findConnectedAccountByIgId(db, request.meta_user_id);
    if (account) {
      deletedAccountWorkspaceId =
        typeof account.workspace_id === 'string' && account.workspace_id.length > 0
          ? account.workspace_id
          : null;
      // Record the linkage BEFORE deleting the account (account_id then
      // becomes NULL via ON DELETE SET NULL; operator_user_id preserves it).
      await updateDeletionRequest(db, request.id, {
        account_id: account.id,
        operator_user_id: account.user_id,
      });
      await deleteConnectedAccount(db, account);
      deletedSomething = true;
    }

    const audience = await deleteAudienceData(db, request.meta_user_id);
    if (audience.total > 0) deletedSomething = true;

    const finalStatus: DeletionRequestStatus = deletedSomething
      ? 'completed'
      : previousStatus === 'completed'
        ? 'completed' // a prior run already deleted this user's data
        : 'not_found';

    await updateDeletionRequest(db, request.id, {
      status: finalStatus,
      completed_at: new Date().toISOString(),
      error: null,
    });
    return { ...request, status: finalStatus, workspace_id: deletedAccountWorkspaceId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown processing error';
    await updateDeletionRequest(db, request.id, {
      status: 'failed',
      error: message.slice(0, 500),
    }).catch(() => {
      // If even the failure-marking update fails, surface the original error.
    });
    throw err;
  }
}

// ── Logging helper ──────────────────────────────────────────────────────────

/** Short irreversible fingerprint of an ID, safe to put in logs. */
export function redactId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}
