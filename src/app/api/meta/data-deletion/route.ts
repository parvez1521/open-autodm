/**
 * Meta data deletion request callback.
 *
 * POST (form-encoded, single `signed_request` param) - sent by Meta when a
 * user removes the app AND requests deletion of their data.
 *
 * Meta's contract (Data Deletion Request Callback doc):
 *  - Verify the signed_request; on failure process nothing.
 *  - Initiate deletion of the user's data.
 *  - Return HTTP 200 JSON: { "url": "<status URL>", "confirmation_code":
 *    "<alphanumeric code>" } - Meta shows both to the user.
 *
 * Behaviour here:
 *  - Invalid/missing signature → 400/401 and NO record is created.
 *  - App not configured → 500 (fail closed, no record).
 *  - Valid signature → a durable data_deletion_requests record is created
 *    (or the existing non-failed record for the same user is reused, so
 *    Meta retries return the same confirmation code), the scoped deletion
 *    runs synchronously (connected account + cascade, and/or the audience
 *    sweep for that IGSID), and the {url, confirmation_code} JSON is
 *    returned. If processing itself errors, the record is marked failed
 *    (the status page reports that honestly) but the contract response is
 *    still returned - the code remains valid and a later callback re-drives
 *    the same record.
 *  - Unknown user → record resolves to status not_found; still a valid
 *    completion state, never an error, never another tenant's data.
 *
 * Dashboard registration: Instagram product → API setup with Instagram
 * login → Business login settings → "Data deletion request URL".
 */

import { createServiceClient } from '@/lib/supabase/service';
import { getAppUrl } from '@/lib/env';
import { verifyMetaCallback } from '@/lib/meta/callback';
import { getOrCreateDeletionRequest, processDeletionRequest, redactId } from '@/lib/meta/accountData';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('meta-data-deletion');

export async function POST(request: Request): Promise<Response> {
  const verified = await verifyMetaCallback(request);
  if (!verified.ok) {
    logger.warn({ status: verified.status }, 'Data deletion callback rejected before processing');
    return Response.json({ error: verified.error }, { status: verified.status });
  }

  const idFingerprint = redactId(verified.userId);

  let confirmationCode: string;
  try {
    // Inside the try (Phase 10.3 fix): createServiceClient() can throw on
    // invalid env, and that must surface as the controlled 500 below -
    // letting Meta retry - not as an unhandled framework error. This now
    // matches the deauthorize and status routes, which already construct
    // their client inside their try blocks.
    const db = createServiceClient();
    const { row, created } = await getOrCreateDeletionRequest(db, verified.userId);
    confirmationCode = row.confirmation_code;
    logger.info(
      { idFingerprint, created },
      created ? 'Data deletion request recorded' : 'Data deletion request reused (retry-safe)'
    );

    try {
      const processed = await processDeletionRequest(db, row);
      // Phase D1: audit the sweep per workspace — processDeletionRequest
      // reports the deleted account's binding on its return value.
      const workspaceId =
        typeof processed.workspace_id === 'string' && processed.workspace_id.length > 0
          ? processed.workspace_id
          : null;
      logger.info(
        { idFingerprint, status: processed.status, workspaceId },
        'Data deletion processing finished'
      );
      debugLog('oauth', 'info', 'account_data_deleted', 'ok',
        `Data deletion processing finished (${processed.status})`, {
          ...(workspaceId ? { workspaceId } : {}),
        });
    } catch (err) {
      // Record is already marked failed inside processDeletionRequest; the
      // Meta contract response below is still owed for a valid signature.
      logger.error({ idFingerprint, err }, 'Data deletion processing failed - record marked failed');
    }
  } catch (err) {
    // Could not even persist the request record - without a code there is
    // nothing meaningful to return, so fail the callback and let Meta retry.
    logger.error({ idFingerprint, err }, 'Data deletion request could not be recorded');
    return Response.json({ error: 'Processing failed' }, { status: 500 });
  }

  const url = `${getAppUrl(request)}/data-deletion/status?code=${encodeURIComponent(confirmationCode)}`;
  return Response.json({ url, confirmation_code: confirmationCode }, { status: 200 });
}
