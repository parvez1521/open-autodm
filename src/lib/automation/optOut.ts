/**
 * Recipient Opt-Out & Suppression Engine
 *
 * Implements persistent, recipient-level opt-out suppression to guarantee
 * compliance with Meta messaging policies and respect explicit user intent.
 *
 * Checks:
 * 1. Webhook Ingestion: Stops job creation immediately when an opt-out phrase is received.
 * 2. Pre-Send Guard: Blocks outbound DMs, public replies, and follow-ups if the recipient is suppressed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { resolveWorkspaceForAccount } from '@/lib/tenancy/context';

const logger = createLogger('opt-out');

/**
 * Standard opt-out keywords when sent as a standalone message or command.
 */
const STANDALONE_OPT_OUT_KEYWORDS = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'quit',
  'end',
  'optout',
  'opt out',
  'opt-out',
]);

/**
 * Negative contexts: Phrases containing 'stop' that do NOT indicate an opt-out intent.
 */
const NON_OPT_OUT_PATTERNS = [
  /\b(can'?t|cannot|won'?t|never|don'?t|dont)\s+stop\b/i,
  /\b(bus|one|pit|short|full)\s+stop\b/i,
  /\bstop\s+(by|in|watching|scrolling|laughing|listening|playing)\b/i,
  /\bnon-?stop\b/i,
];

/**
 * Positive explicit opt-out patterns across multi-word phrases.
 */
const EXPLICIT_OPT_OUT_PATTERNS = [
  /\b(don'?t|do not|no)\s+(?:direct\s+messages?|dms?|messages?)\b/i,
  /\b(stop|quit|end|cease)\s+(?:direct\s+messages?|dms?|dm'ing|dming|messaging|sending|contacting)\b/i,
  /\bstop\s+sending\s+me\b/i,
  /\b(remove|delete)\s+me\b/i,
  /\bleave\s+me\s+alone\b/i,
  /\bunsubscribe\b/i,
  /\bopt-?out\b/i,
  /\bstop\s+(?:sending\s+)?(?:me\s+)?(?:direct\s+messages?|dms?|messages?|links?|promos?)\b/i,
];

/**
 * Determines whether a comment or DM expresses an explicit intent to opt-out.
 */
export function isOptOutIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();

  // 1. Check for known non-opt-out false-positive phrases (e.g. "can't stop watching")
  for (const pattern of NON_OPT_OUT_PATTERNS) {
    if (pattern.test(lower)) {
      return false;
    }
  }

  // 2. Clean leading/trailing punctuation & symbols to check standalone commands
  const cleanWord = lower
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();

  if (STANDALONE_OPT_OUT_KEYWORDS.has(cleanWord)) {
    return true;
  }

  // Handle polite variants: "please stop", "stop please"
  const politeMatch = /^(?:please\s+)?(stop|unsubscribe|cancel|quit|end|optout|opt out|opt-out)(?:\s+please)?$/i.exec(cleanWord);
  if (politeMatch) {
    return true;
  }

  // 3. Check explicit multi-word opt-out patterns
  for (const pattern of EXPLICIT_OPT_OUT_PATTERNS) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  return false;
}

export interface RecordOptOutParams {
  instagramAccountId: string;
  recipientId: string;
  triggerEventId?: string | null;
  text?: string | null;
  reason?: string;
}

/**
 * Persists an opt-out record for the recipient under the specified account.
 */
export async function recordRecipientOptOut(
  db: SupabaseClient,
  params: RecordOptOutParams
): Promise<boolean> {
  const { instagramAccountId, recipientId, triggerEventId, text, reason = 'keyword' } = params;

  // Phase H (Programme 18): workspace derived server-side from the
  // parent account binding — used by the fallback upsert directly and by
  // a post-RPC stamp for the RPC path (the …000006 RPC predates tenancy).
  // Unbound account ⇒ null ⇒ legacy unstamped behaviour, as before.
  let workspaceId: string | null = null;
  try {
    workspaceId = await resolveWorkspaceForAccount(db, instagramAccountId);
  } catch {
    workspaceId = null;
  }

  try {
    const { data, error } = await db.rpc('record_recipient_opt_out', {
      p_instagram_account_id: instagramAccountId,
      p_recipient_id: recipientId,
      p_trigger_event_id: triggerEventId || null,
      p_opt_out_text: text || null,
      p_reason: reason,
    });

    if (error) {
      // Fallback to direct upsert in case RPC is missing in testing environment
      const { error: upsertErr } = await db.from('recipient_opt_outs').upsert(
        {
          instagram_account_id: instagramAccountId,
          recipient_id: recipientId,
          trigger_event_id: triggerEventId || null,
          opt_out_text: text || null,
          reason,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
        },
        { onConflict: 'instagram_account_id,recipient_id' }
      );
      if (upsertErr) {
        // Phase 10.4 §9: never log the audience's opt-out message text —
        // identifiers + reason only (the text itself lives in the table).
        logger.error({ err: upsertErr, instagramAccountId, recipientId, triggerEventId, reason }, 'Failed to record recipient opt-out');
        return false;
      }
    } else if (workspaceId) {
      // RPC path: stamp the row it created (idempotent same-value update).
      const { error: stampErr } = await db
        .from('recipient_opt_outs')
        .update({ workspace_id: workspaceId })
        .eq('instagram_account_id', instagramAccountId)
        .eq('recipient_id', recipientId);
      if (stampErr) logger.warn({ err: stampErr, instagramAccountId, recipientId }, 'opt-out workspace stamp failed');
    }

    debugLog('webhook', 'warn', 'recipient_opt_out_recorded', 'ok',
      `Recipient ${recipientId} opted out from account ${instagramAccountId}`, {
        instagramAccountId,
        recipientId,
        triggerEventId,
        reason,
        ...(workspaceId ? { workspaceId } : {}),
      });

    return true;
  } catch (err) {
    logger.error({ err, instagramAccountId, recipientId, triggerEventId, reason }, 'Error executing recordRecipientOptOut');
    return false;
  }
}

/**
 * Checks whether an audience member has opted out from receiving messages from this account.
 *
 * FAIL CLOSED (Phase 5 hardening, deliberate deviation from release-prep):
 * release-prep's catch block claimed "fail closed" in its comment but returned
 * `false` (fail open). Here, if BOTH the RPC and the fallback table query fail
 * or error, the recipient is treated as SUPPRESSED — an unverifiable recipient
 * must never be sent an automated message. Empty ids also fail closed: a send
 * path that cannot name its recipient/account has nothing legitimate to send.
 */
export async function isRecipientSuppressed(
  db: SupabaseClient,
  instagramAccountId: string,
  recipientId: string
): Promise<boolean> {
  if (!instagramAccountId || !recipientId) return true;

  try {
    const { data, error } = await db.rpc('is_recipient_suppressed', {
      p_instagram_account_id: instagramAccountId,
      p_recipient_id: recipientId,
    });

    if (!error && typeof data === 'boolean') {
      return data;
    }

    // Fallback to direct query (RPC missing/erroring must not open the gate)
    const { data: row, error: queryError } = await db
      .from('recipient_opt_outs')
      .select('id')
      .eq('instagram_account_id', instagramAccountId)
      .eq('recipient_id', recipientId)
      .maybeSingle();

    if (queryError) {
      logger.error(
        { err: queryError, instagramAccountId, recipientId },
        'Suppression fallback query failed - failing closed (treating recipient as suppressed)'
      );
      return true;
    }

    return !!row;
  } catch (err) {
    logger.error({ err, instagramAccountId, recipientId }, 'Suppression check error - failing closed');
    // If we cannot verify suppression due to an error, default to suppressed to prevent policy violations
    return true;
  }
}
