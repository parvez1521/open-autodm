/**
 * Preserve-on-disconnect (owner decision 2026-11-15): disconnecting an
 * Instagram account must NOT delete its automations.
 *
 * The disconnect route soft-disconnects the account row instead of
 * deleting it (the FK ON DELETE CASCADE used to wipe automations, jobs,
 * logs and sessions). These two helpers are the automation half of that
 * contract, shared by the disconnect route and the OAuth callback:
 *
 *  - pauseAutomationsForDisconnect: auto-pauses every ACTIVE automation
 *    of the account and marks it paused_by_disconnect=true. Automations
 *    the user had already paused manually are left untouched (flag stays
 *    false), so a later reconnect does not resurrect them.
 *  - reactivateAutomationsAfterReconnect: reactivates exactly the
 *    automations the disconnect paused (flag true) — nothing else.
 *
 * The engine needs no change for the pause to hold: the webhook router
 * and the job processor both load the account with is_active=true and
 * automations with is_active=true, so a disconnected account's
 * automations can neither match a new event nor send a queued job.
 * Queued jobs for a paused automation are marked skipped by the job
 * processor (they are NOT replayed after a reconnect).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';

const logger = createLogger('automation:disconnect-preservation');

/**
 * Auto-pause the account's ACTIVE automations for a disconnect.
 * Returns the ids that were paused. Only rows with is_active=true are
 * touched, so a manually-paused automation keeps its own state (and
 * its paused_by_disconnect flag stays false).
 */
export async function pauseAutomationsForDisconnect(
  db: SupabaseClient,
  instagramAccountId: string,
  opts?: { userId?: string },
): Promise<string[]> {
  let query = db
    .from('automations')
    .update({ is_active: false, paused_by_disconnect: true })
    .eq('instagram_account_id', instagramAccountId)
    .eq('is_active', true);
  if (opts?.userId) query = query.eq('user_id', opts.userId);
  const { data, error } = await query.select('id');
  if (error) {
    logger.error(
      { err: error, instagramAccountId },
      'Failed to pause automations for Instagram disconnect',
    );
    throw new Error(`Failed to pause automations for disconnect: ${error.message}`);
  }
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

/**
 * Reactivate exactly the automations a disconnect paused, for the SAME
 * Instagram account reconnecting (matched by instagram_account_id — the
 * callback already verified the IG account belongs to the same owner).
 * Returns the ids that were reactivated. A reconnect of a DIFFERENT
 * account never touches these rows: they stay paused with their
 * "account disconnected" badge until the owner deletes or resumes them.
 */
export async function reactivateAutomationsAfterReconnect(
  db: SupabaseClient,
  instagramAccountId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from('automations')
    .update({ is_active: true, paused_by_disconnect: false })
    .eq('instagram_account_id', instagramAccountId)
    .eq('paused_by_disconnect', true)
    .select('id');
  if (error) {
    logger.error(
      { err: error, instagramAccountId },
      'Failed to reactivate automations after Instagram reconnect',
    );
    throw new Error(`Failed to reactivate automations after reconnect: ${error.message}`);
  }
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

// ── Facebook Page twins (2026-11-19) ────────────────────────────────────────
// Same preserve-on-disconnect contract as the Instagram helpers above,
// keyed on facebook_page_id. Disconnecting a Page pauses (never deletes)
// its automations; reconnecting the SAME Page reactivates exactly those.

/**
 * Auto-pause the Page's ACTIVE automations for a disconnect.
 * Returns the ids that were paused.
 */
export async function pauseFacebookAutomationsForDisconnect(
  db: SupabaseClient,
  facebookPageId: string,
  opts?: { userId?: string },
): Promise<string[]> {
  let query = db
    .from('automations')
    .update({ is_active: false, paused_by_disconnect: true })
    .eq('facebook_page_id', facebookPageId)
    .eq('is_active', true);
  if (opts?.userId) query = query.eq('user_id', opts.userId);
  const { data, error } = await query.select('id');
  if (error) {
    logger.error(
      { err: error, facebookPageId },
      'Failed to pause automations for Facebook disconnect',
    );
    throw new Error(`Failed to pause automations for disconnect: ${error.message}`);
  }
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

/**
 * Reactivate exactly the automations a disconnect paused, for the SAME
 * Page reconnecting (matched by facebook_page_id — the callback already
 * verified the Page belongs to the same owner). Returns the ids that
 * were reactivated.
 */
export async function reactivateFacebookAutomationsAfterReconnect(
  db: SupabaseClient,
  facebookPageId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from('automations')
    .update({ is_active: true, paused_by_disconnect: false })
    .eq('facebook_page_id', facebookPageId)
    .eq('paused_by_disconnect', true)
    .select('id');
  if (error) {
    logger.error(
      { err: error, facebookPageId },
      'Failed to reactivate automations after Facebook reconnect',
    );
    throw new Error(`Failed to reactivate automations after reconnect: ${error.message}`);
  }
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}
