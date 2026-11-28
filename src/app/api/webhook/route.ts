/**
 * Meta webhook endpoint.
 *
 * GET  → subscription verification challenge (Meta portal setup)
 * POST → live events (comments, DMs, postbacks)
 *
 * Non-negotiable contract with Meta:
 *  1. HMAC-SHA256 signature verified over the RAW body BEFORE any processing.
 *     Invalid → 403 immediately. No DB queries before this check.
 *  2. 200 returned within 5 seconds. All real work happens in `after()` -
 *     the response is sent first, processing continues in the background of
 *     the same invocation (supported on Vercel and Cloudflare via OpenNext).
 */

import { after } from 'next/server';
import { getMetaSettings } from '@/lib/settings';
import { hmacSha256Hex, safeCompare } from '@/lib/crypto';
import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { processFacebookWebhook } from '@/lib/facebook/processFacebookWebhook';
import { admitInboundWebhook } from '@/lib/automation/inboundRateLimit';
import { processDueJobs } from '@/lib/automation/engine';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import type { MetaWebhookBody } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const logger = createLogger('webhook-route');

/**
 * Max jobs drained inline by one webhook invocation.
 *
 * Cloudflare Workers free plan allows 50 subrequests (fetch calls) per
 * invocation, and the webhook's after() callback runs in the SAME
 * invocation as the admission + enqueue path. Per-job subrequest
 * estimate for a full-featured IG comment job (public reply on, 1-step,
 * no flow graph):
 *   ~17 awaited Supabase calls (owner lookup, dedup x2, automation,
 *   account, opt-out, rate-limit RPC, reservation RPC, markJobStatus,
 *   public-reply select + reservation + confirm + dm_jobs update,
 *   dm_sent_log insert, counter RPC, confirm-reservation RPC,
 *   markJobDone RPC)
 *   + 2 Meta Graph API calls (public reply + opening DM)
 *   + ~8 fire-and-forget debug_events inserts
 *   ≈ 27 subrequests per job.
 * Admission + enqueue add ~8-10 more in the same invocation, so ONE job
 * lands at ~35-37 (safely under 50) while TWO would land at ~62-64
 * (over — an FB job already logged 'Too many subrequests' from a
 * 5-job drain, 2026-11-27). The cap is therefore 1.
 *
 * Throughput impact is bounded: each comment arrival is itself a
 * webhook event, and each event drains the oldest pending job, so the
 * backlog clears at the arrival rate. Jobs with no webhook behind them
 * (retries, follow-ups) still depend on the /api/cron/process-jobs
 * safety net, which drains with its own limit.
 *
 * NOTE: intentionally NOT exported — Next.js route modules may only
 * export route handlers/config, and the generated .next/types check
 * rejects any other export. Tests assert the literal value instead.
 */
const WEBHOOK_INLINE_DRAIN_MAX_JOBS = 1;

// ── GET /api/webhook - Meta verification challenge ──────────────────────────
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const challenge = url.searchParams.get('hub.challenge');
  const verifyToken = url.searchParams.get('hub.verify_token');

  const settings = await getMetaSettings();

  // Constant-time comparison (S-15): the POST HMAC path already uses
  // safeCompare; the verify token is a shared secret and gets the same
  // treatment. A missing token parameter never reaches the comparison.
  if (mode === 'subscribe' && settings && verifyToken !== null && safeCompare(verifyToken, settings.webhookVerifyToken)) {
    debugLog('webhook', 'info', 'webhook_verify', 'ok', 'Meta webhook verification successful', {});
    return new Response(challenge ?? '', { status: 200 });
  }

  debugLog('webhook', 'warn', 'webhook_verify', 'error', 'Webhook verification failed - token mismatch or setup incomplete', {
    mode,
    configured: !!settings,
  });
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

/**
 * Phase D1 — workspace attribution for admission records.
 *
 * Admission rows (inbound_webhook_events) are created by the
 * check_and_record_inbound_event RPC, whose signature predates tenancy
 * and deliberately keys ONLY on the verified payload's IGSID — it runs
 * before any account lookup and must also bound work for entries that
 * resolve to no connected account. The RPC therefore cannot stamp
 * workspace_id itself. What this helper does instead, AFTER admission
 * and with the HMAC already verified:
 *
 *   1. Resolve each admitted entry's account binding
 *      (instagram_accounts.workspace_id, looked up by IGSID).
 *   2. Best-effort UPDATE the account's admission rows to carry that
 *      workspace_id (…000032). The binding is an account-level invariant,
 *      so an account-scoped update is exact, not approximate. Any failure
 *      (column absent pre-…000032, store blip) is swallowed — attribution
 *      must never change admission semantics, limits, the fail-open
 *      throttle behaviour, or block processing.
 *   3. Emit the workspace attribution as a structured debug event, which
 *      is the guaranteed floor even when the update path is unavailable.
 *
 * Unbound accounts (the legacy world) resolve to null and are skipped
 * silently — behaviour is unchanged for them.
 */
async function attributeAdmissionWorkspaces(body: MetaWebhookBody): Promise<void> {
  try {
    const db = createServiceClient();
    const entryIds = [...new Set(body.entry.map((e) => e.id))];
    for (const igsid of entryIds) {
      try {
        const { data, error } = await db
          .from('instagram_accounts')
          .select('workspace_id')
          .eq('instagram_user_id', igsid)
          .maybeSingle();
        if (error || !data) continue;
        const workspaceId =
          typeof data.workspace_id === 'string' && data.workspace_id.length > 0
            ? (data.workspace_id as string)
            : null;
        if (!workspaceId) continue;
        debugLog('webhook', 'info', 'webhook_workspace_attribution', 'ok',
          `Admission records for IG account ${igsid} attributed to workspace ${workspaceId}`, {
            igAccountId: igsid,
            workspaceId,
          });
        // Post-admission update (best-effort; see header). The result is
        // intentionally ignored beyond this comment: pre-…000032 stores
        // error here, and that must not affect processing.
        await db
          .from('inbound_webhook_events')
          .update({ workspace_id: workspaceId })
          .eq('ig_account_id', igsid);
      } catch {
        // Per-entry attribution failure never blocks the entry's processing.
      }
    }
  } catch {
    // Service client unavailable (e.g. env not configured in a test
    // harness) — attribution is observability only; processing proceeds.
  }
}

// ── POST /api/webhook - live events ─────────────────────────────────────────
export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('x-hub-signature-256');
  const rawBody = await request.text();

  debugLog('webhook', 'info', 'webhook_received', 'processing', 'POST /api/webhook received from Meta', {
    hasSignature: !!signature,
    bytes: rawBody.length,
  });

  if (!signature) {
    debugLog('webhook', 'error', 'signature_check', 'error', 'Missing x-hub-signature-256 header', {});
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const settings = await getMetaSettings();
  if (!settings) {
    // Setup wizard not completed - we cannot verify anything. Reject.
    debugLog('webhook', 'error', 'signature_check', 'error', 'Meta credentials not configured - complete the Setup Wizard first', {});
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Meta signs with the Instagram app secret for IG-Login apps and the
  // Facebook app secret for FB-Login apps. Accept a match against either
  // configured secret - avoids a config guess that silently kills webhooks.
  const signingSecrets = [settings.metaAppSecret, settings.metaFbAppSecret].filter(
    (s): s is string => Boolean(s)
  );
  const bodyBuffer = Buffer.from(rawBody, 'utf8');
  const signatureValid = signingSecrets.some((secret) =>
    safeCompare(signature, `sha256=${hmacSha256Hex(secret, bodyBuffer)}`)
  );
  if (!signatureValid) {
    logger.warn({}, 'Webhook signature verification FAILED - rejecting');
    debugLog('webhook', 'error', 'signature_check', 'error',
      'HMAC-SHA256 signature mismatch - request rejected', {
        hint: 'If this keeps happening on real events, add your Facebook App Secret in the Setup Wizard - some Meta apps sign webhooks with it instead of the Instagram app secret.',
      });
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  debugLog('webhook', 'info', 'signature_check', 'ok', 'HMAC-SHA256 signature verified', {});

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaWebhookBody;
  } catch {
    // Signed but unparseable - acknowledge so Meta doesn't retry forever.
    return Response.json({ status: 'ignored' }, { status: 200 });
  }

  // All heavy lifting AFTER the 200 is on the wire.
  after(async () => {
    try {
      // S-07 inbound admission (Phase 10.4): per-account, keyed on the
      // verified payload's entry ids. Runs only now — after HMAC — so an
      // invalid request never pays limiter cost, and its outcome never
      // changes the 200 above: duplicates are dropped before processing,
      // excess verified events are shed (recorded, counts-only logged),
      // and a limiter-store failure fails open. See
      // src/lib/automation/inboundRateLimit.ts for the full reasoning.
      const admission = await admitInboundWebhook(body);
      // Phase D1: attribute the admission records to their workspace
      // where resolvable (best-effort, never blocks — see helper header).
      if (admission.body) {
        await attributeAdmissionWorkspaces(admission.body);
      }
      const enqueued = admission.body
        // Facebook Page webhooks (object === 'page') run through the
        // parallel FB pipeline; Instagram stays on processWebhookPayload.
        // Admission passes non-Instagram bodies through unfiltered, and
        // the HMAC above already accepts either app secret, so no other
        // change is needed here. (2026-11-19)
        ? admission.body.object === 'page'
          ? await processFacebookWebhook(admission.body)
          : await processWebhookPayload(admission.body)
        : 0;
      // Fast path: drain what we just enqueued (plus any other due jobs).
      // Capped at WEBHOOK_INLINE_DRAIN_MAX_JOBS (see the constant above):
      // one invocation must stay under the 50-subrequest free-plan limit.
      if (enqueued > 0) {
        await processDueJobs(WEBHOOK_INLINE_DRAIN_MAX_JOBS);
      }
    } catch (err) {
      logger.error({ err }, 'Webhook background processing failed (200 already sent)');
      debugLog('webhook', 'error', 'payload_processing', 'error',
        `Unhandled error during background processing: ${err instanceof Error ? err.message : String(err)}`, {});
    }
  });

  return Response.json({ status: 'ok' }, { status: 200 });
}
