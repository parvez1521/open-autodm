/**
 * Meta deauthorize callback.
 *
 * POST (form-encoded, single `signed_request` param) - sent by Meta when a
 * user removes the app. Meta has already expired the user's access tokens
 * by the time this fires; our job is to remove the stored connection.
 *
 * Contract:
 *  - Invalid/missing signature → 400/401, NOTHING is processed.
 *  - App not configured (no secrets to verify against) → 500, fail closed.
 *  - Valid signature → 200 always: if the user_id matches a connected
 *    account, its row is deleted (encrypted token + automations + logs go
 *    with it via ON DELETE CASCADE); if nothing matches, success no-op.
 *    Repeats are idempotent - an already-removed connection is success.
 *  - No response-body contract exists for this callback; a small JSON ack
 *    is returned. Secrets, tokens and the raw signed_request are never
 *    logged (only a hashed ID fingerprint).
 *
 * Dashboard registration: Instagram product → API setup with Instagram
 * login → Business login settings → "Deauthorize callback URL".
 */

import { createServiceClient } from '@/lib/supabase/service';
import { verifyMetaCallback } from '@/lib/meta/callback';
import { findConnectedAccountByIgId, deleteConnectedAccount, redactId } from '@/lib/meta/accountData';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('meta-deauthorize');

export async function POST(request: Request): Promise<Response> {
  const verified = await verifyMetaCallback(request);
  if (!verified.ok) {
    logger.warn({ status: verified.status }, 'Deauthorize callback rejected before processing');
    return Response.json({ error: verified.error }, { status: verified.status });
  }

  const idFingerprint = redactId(verified.userId);

  try {
    const db = createServiceClient();
    const account = await findConnectedAccountByIgId(db, verified.userId);
    if (account) {
      // Phase D1: the sweep is audited per workspace — the account's
      // binding (…000026) rides into both the structured log and the
      // debug event (debug_events.workspace_id). The sweep itself stays
      // account-scoped, exactly as before.
      const workspaceId =
        typeof account.workspace_id === 'string' && account.workspace_id.length > 0
          ? account.workspace_id
          : null;
      await deleteConnectedAccount(db, account);
      logger.info({ idFingerprint, workspaceId }, 'Deauthorize: connected account removed');
      debugLog('oauth', 'info', 'account_deauthorized', 'ok',
        'Deauthorize: connected account removed', {
          userId: account.user_id,
          ...(workspaceId ? { workspaceId } : {}),
        });
    } else {
      // Unknown user (or repeat callback after removal) - no-op success.
      logger.info({ idFingerprint }, 'Deauthorize: no connected account matched - no-op');
    }
  } catch (err) {
    // 500 lets Meta retry; the operation is idempotent, so a retry is safe.
    logger.error({ idFingerprint, err }, 'Deauthorize: processing failed');
    return Response.json({ error: 'Processing failed' }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
