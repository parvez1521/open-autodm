/**
 * AutoDM job processors - battle-tested logic, adapted
 * for serverless execution with three extra safety layers:
 *
 *  1. Postgres rate limiter - check_and_record_dm_rate_limit RPC, atomic,
 *     180 DMs/hour rolling window per account (20-DM buffer under Meta's 200).
 *  2. Human-like jitter - a randomized 2-5s pause before every send, so
 *     automated replies never look machine-instant to Instagram.
 *  3. Circuit breaker - if Meta returns a policy/spam block (code 368), the
 *     entire account is paused for 24h instead of retrying into a ban.
 *
 * processAutoDmJob   - opening DM (comment / dm_reply keyword trigger)
 * processFollowUpDmJob - follow-up after a quick-reply / postback tap
 *
 * Control flow contract with the engine:
 *  - return 'done'                 → job completed or intentionally skipped
 *  - throw RateLimitDelay          → reschedule without counting an attempt
 *  - throw RateLimitUnavailable    → limiter decision UNKNOWN (RPC error /
 *                                    timeout / malformed result): fail
 *                                    closed — no send; rescheduled exactly
 *                                    like RateLimitDelay (it subclasses it)
 *  - throw AccountPausedMetaError  → pause account + fail job
 *  - throw NonRetryableMetaError   → fail job
 *  - throw anything else           → retry with backoff (max_attempts guard)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog, type DebugLevel, type DebugStatus } from '@/lib/debugLog';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import type { AutoDmJobPayload, AutomationRow, InstagramAccountRow, DMResponse } from '@/lib/types';
import {
  sendInstagramDm,
  sendInstagramLinkButtonDm,
  sendInstagramCardDm,
  sendAskToFollowDm,
  replyToComment,
  getAudienceProfile,
  type DmRecipient,
} from '@/lib/instagram/api';
import { updateContactProfile } from '@/lib/automation/contacts';
import { MetaApiError, AccountPausedMetaError, NonRetryableMetaError, AmbiguousDeliveryError, META_RATE_LIMIT_CODES } from '@/lib/instagram/errors';
import {
  reserveCommentPrivateReply,
  confirmCommentPrivateReply,
  releaseCommentPrivateReply,
  markCommentPrivateReplyFailed,
  reserveCommentPublicReply,
  confirmCommentPublicReply,
  releaseCommentPublicReply,
  markCommentPublicReplyFailed,
  reservationDispositionForError,
} from '@/lib/automation/reservations';
import { isRecipientSuppressed } from '@/lib/automation/optOut';
import { resolveWorkspaceForAccount } from '@/lib/tenancy/context';
import { AccountOnTrafficGuardPause } from '@/lib/automation/trafficGuardError';
import {
  recordWaitingResponseFollowUp,
  markFollowUpStatus,
  claimFollowUpForSending,
} from '@/lib/automation/followUps';
import { executeFlowGraph } from '@/lib/automation/flowEngine';

export { AccountOnTrafficGuardPause };

/**
 * True when a failed button-template send should be retried as plain text
 * with an inline link. Template rejections surface as parameter/permission
 * errors; a policy block (368) must propagate so the circuit breaker opens
 * instead of immediately re-hitting Meta.
 */
function shouldFallBackToInlineLink(err: unknown): err is MetaApiError {
  return err instanceof MetaApiError && !(err instanceof AccountPausedMetaError);
}
import { renderTemplate } from '@/lib/automation/personalize';

/** Sends a single configured response (text w/ optional link button, or card). */
async function sendOneResponse(
  igAccountIgsid: string,
  recipient: DmRecipient,
  audienceId: string,
  response: DMResponse,
  username: string | null | undefined,
  accessToken: string
): Promise<void> {
  if (response.type === 'card') {
    const cardImageUrl = response.cardImage?.startsWith('http') ? response.cardImage : undefined;
    await sendInstagramCardDm(igAccountIgsid, audienceId, accessToken, {
      title: response.cardTitle ?? response.content,
      ...(cardImageUrl !== undefined ? { imageUrl: cardImageUrl } : {}),
      ...(response.cardSubtitle !== undefined ? { subtitle: response.cardSubtitle } : {}),
      ...(response.cardButtons !== undefined
        ? { buttons: response.cardButtons.map((b) => ({ title: b.title, url: b.link })) }
        : {}),
    });
    return;
  }

  const messageText = renderTemplate(response.content.trim(), username);
  const link = response.buttonLink?.trim();
  if (link) {
    const buttonTitle = response.buttonTitle?.trim() || 'Open link';
    try {
      await sendInstagramLinkButtonDm(igAccountIgsid, recipient, messageText, buttonTitle, link, accessToken);
    } catch (buttonErr) {
      if (!shouldFallBackToInlineLink(buttonErr)) throw buttonErr;
      await sendInstagramDm(igAccountIgsid, recipient, `${messageText}\n\n${buttonTitle}: ${link}`, accessToken);
    }
  } else {
    await sendInstagramDm(igAccountIgsid, recipient, messageText, accessToken);
  }
}

/**
 * Best-effort sequential delivery of configured responses for the 1-step flow
 * (no reveal button). Per-response failures are logged and skipped rather than
 * thrown - the opening DM already went out and is dedup-recorded, so a retry
 * could never resend it; losing one response beats losing the whole flow.
 */
async function deliverResponsesBestEffort(
  payload: AutoDmJobPayload,
  responses: DMResponse[],
  accessToken: string,
  userId: string | null = null
): Promise<number> {
  let sent = 0;
  for (const [idx, response] of responses.entries()) {
    if (!response.content?.trim() && response.type !== 'card') continue;
    try {
      if (sent > 0) await interMessageJitter();
      await sendOneResponse(
        payload.igAccountIgsid,
        { id: payload.triggerUserId },
        payload.triggerUserId,
        response,
        payload.triggerUsername,
        accessToken
      );
      sent += 1;
      debugLog('worker', 'info', 'responses_send', 'ok', `Response ${idx + 1}/${responses.length} sent (1-step flow)`, {
        responseIndex: idx + 1,
        type: response.type,
        userId,
      });
    } catch (err) {
      if (err instanceof AccountPausedMetaError) throw err; // circuit breaker must still open
      debugLog('worker', 'warn', 'responses_send', 'error',
        `Response ${idx + 1}/${responses.length} failed (1-step flow, skipped): ${err instanceof Error ? err.message : String(err)}`,
        { responseIndex: idx + 1, userId });
    }
  }
  return sent;
}

const logger = createLogger('worker');

/** Meta's DM window: only message users who engaged within the last 24h. */
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/** Hourly DM cap per account (Meta hard limit is 200; 20-DM safety buffer). */
export const DM_LIMIT_PER_HOUR = 180;

/** Randomized pre-send delay - automation that behaves like a human. */
const JITTER_MIN_MS = 2000;
const JITTER_MAX_MS = 5000;

/** Thrown when the hourly window is full - engine reschedules, no attempt counted. */
export class RateLimitDelay extends Error {
  constructor(public readonly retryAfterMs: number, public readonly currentCount: number) {
    super(`Rate limit reached (${currentCount}/${DM_LIMIT_PER_HOUR}/h)`);
    this.name = 'RateLimitDelay';
  }
}

/** Fixed delay before retrying a job whose rate-limit decision was unavailable. */
export const RATE_LIMIT_UNAVAILABLE_RETRY_MS = 60_000;

/**
 * Thrown when the rate-limit DECISION is unknown — the limiter RPC errored,
 * timed out / threw at transport level, or returned no usable row
 * (Phase 10.4, S-04: fail closed). UNKNOWN must never authorize a send:
 * during a database fault the 180/hour accounting is the only thing
 * keeping the account under Meta's 200/hour hard limit.
 *
 * Extends RateLimitDelay so the engine's existing branch reschedules the
 * job with `retryAfterMs` WITHOUT counting an attempt and without failing
 * it — a transient DB blip therefore delays the DM instead of dropping it
 * or sending it unaccounted. `currentCount` is -1 ("unknown"), never a
 * real observed count, so no log or UI can mistake it for a full window.
 */
export class RateLimitUnavailable extends RateLimitDelay {
  constructor(retryAfterMs: number = RATE_LIMIT_UNAVAILABLE_RETRY_MS) {
    super(retryAfterMs, -1);
    this.name = 'RateLimitUnavailable';
    this.message = `Rate limiter unavailable - delaying send (retry in ${Math.ceil(retryAfterMs / 1000)}s)`;
    Object.setPrototypeOf(this, RateLimitUnavailable.prototype);
  }
}

/** Thrown when the account's circuit breaker is open - engine delays the job. */
export class AccountOnPause extends Error {
  constructor(public readonly resumeAtMs: number) {
    super('Account is paused by the safety circuit breaker');
    this.name = 'AccountOnPause';
  }
}

/**
 * Deterministically select a public reply from the configured pool (same
 * comment always picks the same line, so job retries are stable). Ported
 * from release-prep, WITHOUT its DEFAULT_PUBLIC_REPLIES fallback: when the
 * owner configured no reply text, nothing is posted.
 */
export function selectPublicReplyOption(options: string[] | undefined, seedKey: string): string {
  const cleanOptions = (options ?? []).map((o) => o.trim()).filter(Boolean);
  if (cleanOptions.length === 0) return '';
  let hash = 0;
  for (let i = 0; i < seedKey.length; i++) {
    hash = (hash << 5) - hash + seedKey.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % cleanOptions.length;
  return cleanOptions[index] ?? '';
}

function jitter(): Promise<void> {
  const ms = JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shorter humanized pause BETWEEN consecutive responses in one flow. */
function interMessageJitter(): Promise<void> {
  const ms = 1200 + Math.floor(Math.random() * 1300);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truthful rate accounting: each flow reserves ONE window slot up front, but a
 * flow can deliver several messages. Record the extras so the next jobs see
 * the real send count and throttle correctly (fire-and-forget - accounting
 * must never break a delivery that already happened).
 */
function recordExtraSends(accountId: string, extraCount: number, workspaceId?: string | null): void {
  if (extraCount <= 0) return;
  void (async (): Promise<void> => {
    try {
      const db = createServiceClient();
      // Phase H (Programme 18): stamp the account's VERIFIED workspace
      // (resolved by the calling processor) — omitted for unbound accounts.
      await db.from('dm_rate_events').insert(
        Array.from({ length: extraCount }, () => ({
          instagram_account_id: accountId,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
        }))
      );
    } catch (err) {
      logger.warn({ err, accountId, extraCount }, 'Failed to record extra rate events');
    }
  })();
}

/**
 * FAIL CLOSED (Phase 10.4, S-04 — reverses the previous fail-open choice).
 *
 * The RPC is the ONLY source of the rate-limit decision, and its contract
 * makes "unknown" distinguishable from every real answer:
 *  - success returns EXACTLY ONE row: allowed=true (a window slot was
 *    atomically recorded; current_count is the post-record count) or
 *    allowed=false with current_count >= limit (NO slot recorded).
 *  - an RPC error, a transport-level throw (timeout abort, network
 *    reset), or an empty/malformed result therefore means the decision
 *    is UNKNOWN — it can never be read as "count is 0, send freely".
 * On UNKNOWN this throws RateLimitUnavailable: no send happens, and the
 * engine reschedules the job without counting an attempt, so a transient
 * fault delays rather than drops or overshoots. (If the fault struck
 * after the RPC's internal INSERT committed, at most one window slot is
 * wasted — the safe direction of the asymmetry.)
 *
 * This runs BEFORE token decrypt, BEFORE the comment reservations and
 * BEFORE any Meta call at every call site, so a limiter outage consumes
 * no reservation and no follow-up claim. Logs carry account/count only —
 * never message content; the thrown error is a fixed generic string that
 * never embeds upstream error detail.
 */
async function checkRateLimit(db: SupabaseClient, accountId: string, userId: string | null = null): Promise<void> {
  let data: unknown = null;
  let error: { message: string } | null = null;
  try {
    const result = await db.rpc('check_and_record_dm_rate_limit', {
      p_account_id: accountId,
      p_limit: DM_LIMIT_PER_HOUR,
    });
    data = result.data;
    error = result.error;
  } catch (err) {
    logger.error({ err, accountId }, 'Rate limiter RPC threw - failing closed, delaying send');
    debugLog('worker', 'warn', 'rate_limit_check', 'skipped',
      'Rate limiter unavailable (RPC threw) - delaying send, failing closed',
      { accountId, userId });
    throw new RateLimitUnavailable();
  }
  if (error) {
    logger.error({ err: error, accountId }, 'Rate limiter RPC error - failing closed, delaying send');
    debugLog('worker', 'warn', 'rate_limit_check', 'skipped',
      'Rate limiter unavailable (RPC error) - delaying send, failing closed',
      { accountId, userId });
    throw new RateLimitUnavailable();
  }
  const row = (data as Array<{ allowed: boolean; current_count: number; retry_after_seconds: number }> | null)?.[0];
  if (!row || typeof row.allowed !== 'boolean') {
    logger.error({ accountId }, 'Rate limiter RPC returned no usable row - failing closed, delaying send');
    debugLog('worker', 'warn', 'rate_limit_check', 'skipped',
      'Rate limiter unavailable (empty/malformed result) - delaying send, failing closed',
      { accountId, userId });
    throw new RateLimitUnavailable();
  }
  if (!row.allowed) {
    debugLog('worker', 'warn', 'rate_limit_check', 'skipped',
      `Rate limit reached (${row.current_count}/${DM_LIMIT_PER_HOUR}/h) - delaying ${Math.ceil(row.retry_after_seconds / 60)}min`,
      { accountId, currentCount: row.current_count, userId });
    throw new RateLimitDelay(row.retry_after_seconds * 1000, row.current_count);
  }
  debugLog('worker', 'info', 'rate_limit_check', 'ok', `Rate limit OK - ${row.current_count}/${DM_LIMIT_PER_HOUR} this hour`, {
    accountId,
    userId,
  });
}

/** Circuit breaker: skip sends while the account is paused. */
function assertAccountNotPaused(account: InstagramAccountRow): void {
  if (account.paused_until && new Date(account.paused_until).getTime() > Date.now()) {
    debugLog('worker', 'warn', 'circuit_breaker', 'skipped',
      `Account @${account.username ?? account.id} is paused until ${account.paused_until} (${account.pause_reason ?? 'policy block'})`,
      { accountId: account.id, pausedUntil: account.paused_until, userId: account.user_id });
    throw new AccountOnPause(new Date(account.paused_until).getTime());
  }
}

/** Opens the circuit breaker: pause all sends for this account. */
export async function pauseAccount(accountId: string, reason: string, hours = 24): Promise<void> {
  const db = createServiceClient();
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  const { data: pausedRow } = await db
    .from('instagram_accounts')
    .update({ paused_until: until, pause_reason: reason.slice(0, 500) })
    .eq('id', accountId)
    .select('user_id')
    .maybeSingle();
  debugLog('worker', 'error', 'circuit_breaker', 'error',
    `CIRCUIT BREAKER OPENED - account paused for ${hours}h: ${reason}`,
    { accountId, pausedUntil: until, userId: (pausedRow?.user_id as string | undefined) ?? null });
}

// ── Phase D1: payload workspace validation ─────────────────────────────────
/**
 * The account's ACTUAL workspace binding (server-side truth) for a job.
 *
 * The primary source is the owner lookup each processor already performs
 * (its select now also carries workspace_id), so the legacy path pays NO
 * extra query. `resolveWorkspaceForAccount` is the authoritative fallback,
 * consulted only when a payload ASSERTS a workspace the owner row could
 * not answer for (missing row / legacy row shape). Never throws.
 */
async function resolveActualWorkspaceId(
  db: SupabaseClient,
  payload: AutoDmJobPayload,
  ownerRow: Record<string, unknown> | null | undefined
): Promise<string | null> {
  if (ownerRow) {
    if (typeof ownerRow['workspace_id'] === 'string' && (ownerRow['workspace_id'] as string).length > 0) {
      return ownerRow['workspace_id'] as string;
    }
    if ('workspace_id' in ownerRow) return null; // explicitly unbound
    if (!payload.workspaceId) return null; // legacy row shape, nothing asserted
  }
  if (payload.workspaceId) {
    try {
      return await resolveWorkspaceForAccount(db, payload.instagramAccountId);
    } catch {
      return null;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Opening DM processor
// ═══════════════════════════════════════════════════════════════════════════

export async function processAutoDmJob(payload: AutoDmJobPayload, attempt: number): Promise<void> {
  const db = createServiceClient();
  const env = getEnv();

  // Owner of the connected account - scopes every debug event this job
  // writes (debug_events.user_id, finding #6). One PK lookup per job;
  // null when the account row is gone (events then stay system-owned).
  // Phase D1: the same lookup also carries workspace_id, the primary
  // source for the workspace validation below.
  const { data: ownerRow } = await db
    .from('instagram_accounts')
    .select('user_id, workspace_id')
    .eq('id', payload.instagramAccountId)
    .maybeSingle();
  const ownerUserId = (ownerRow?.user_id as string | undefined) ?? null;
  let resolvedWorkspaceId: string | null = null;
  const logEvent = (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata: Record<string, unknown> = {}
  ): void =>
    debugLog('worker', level, eventType, status, message, {
      ...metadata,
      userId: ownerUserId,
      ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
    });

  // ── 0: Workspace validation (Phase D1, fail closed) ─────────────────────
  // A payload workspaceId is an assertion, never evidence. On mismatch the
  // job is NOT processed against any tenant's data: it is completed as
  // 'skipped' via the same markJobStatus convention as the other
  // intentionally-skipped paths below (window / dedup / inactive), and the
  // mismatch is audited in debug_events (event tenant_context_mismatch).
  const actualWorkspaceId = await resolveActualWorkspaceId(
    db,
    payload,
    ownerRow as Record<string, unknown> | null
  );
  if (payload.workspaceId && payload.workspaceId !== actualWorkspaceId) {
    resolvedWorkspaceId = payload.workspaceId;
    logEvent('error', 'tenant_context_mismatch', 'error',
      `Job payload workspace does not match the account's workspace binding - refusing to process`, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        payloadWorkspaceId: payload.workspaceId,
        actualWorkspaceId,
      });
    await markJobStatus(db, payload, 'skipped', 'Tenant context mismatch: payload workspace does not match account binding');
    return;
  }
  if (actualWorkspaceId) {
    // Server-side truth wins: adopt the resolved workspace when the
    // payload carried none (or confirm the one it carried).
    resolvedWorkspaceId = actualWorkspaceId;
    if (!payload.workspaceId) payload.workspaceId = actualWorkspaceId;
  }

  logEvent( 'info', 'job_started', 'processing', `AutoDM job started - ${payload.triggerType} trigger`, {
    automationId: payload.automationId,
    triggerType: payload.triggerType,
    triggerUserId: payload.triggerUserId,
    triggerEventId: payload.triggerEventId,
    attempt,
  });

  // ── 1: 24-hour window ────────────────────────────────────────────────────
  // Flow-graph continuation jobs (Phase 5, row 19) resume a comment-triggered
  // flow after a delay node; Meta's private-reply window for comments is 7
  // days, so — exactly as release-prep — a comment flow continuation uses
  // the 7-day window. Linear jobs and DM-triggered flows keep the 24h rule
  // restored by the safety workstream, unchanged.
  const isFlowContinuation = Boolean(payload.flowNodeId);
  const maxEventAgeMs =
    isFlowContinuation && payload.triggerType === 'comment'
      ? 7 * 24 * 60 * 60 * 1000
      : MAX_EVENT_AGE_MS;
  const eventAge = Date.now() - payload.triggerTimestamp;
  if (eventAge > maxEventAgeMs) {
    logEvent( 'warn', 'window_check', 'skipped', `Event ${Math.round(eventAge / 3600000)}h old - outside 24h DM window`, {
      ageHours: Math.round(eventAge / 3600000),
    });
    await markJobStatus(db, payload, 'skipped', 'Event outside 24-hour DM window');
    return;
  }

  // ── 2: Dedup (application-level; DB unique constraints are the backstop) ─
  // Continuation steps (flow graph node resumptions or follow-up jobs) bypass
  // initial-contact deduplication since the initial DM was already sent and
  // logged (release-prep semantics). No linear-pipeline job carries
  // flowNodeId, so restored linear behaviour is untouched.
  const isContinuationStep = Boolean(payload.flowNodeId || payload.isFollowUp);
  if (!isContinuationStep) {
    const { data: existingLog } = await db
      .from('dm_sent_log')
      .select('id')
      .eq('automation_id', payload.automationId)
      .eq('trigger_event_id', payload.triggerEventId)
      .maybeSingle();
    if (existingLog) {
      logEvent( 'info', 'dedup_check', 'skipped', `Event ${payload.triggerEventId} already processed`, {});
      await markJobStatus(db, payload, 'skipped', 'Duplicate event');
      return;
    }

    const { data: userLog } = await db
      .from('dm_sent_log')
      .select('id')
      .eq('automation_id', payload.automationId)
      .eq('trigger_user_id', payload.triggerUserId)
      .maybeSingle();
    if (userLog) {
      logEvent( 'info', 'dedup_check', 'skipped', `User ${payload.triggerUserId} already received this automation`, {});
      await markJobStatus(db, payload, 'skipped', 'User already received this automation');
      return;
    }
  }

  // ── 3: Load automation + account, verify circuit breaker ─────────────────
  const { data: automation } = await db
    .from('automations')
    .select('*')
    .eq('id', payload.automationId)
    .eq('is_active', true)
    .single<AutomationRow>();
  if (!automation) {
    // A Traffic Guard pause flips is_active=false on the automations it
    // paused — that must HOLD this job, not silently skip it as "inactive".
    const { data: tgPaused } = await db
      .from('automations')
      .select('id')
      .eq('id', payload.automationId)
      .eq('is_traffic_guard_paused', true)
      .maybeSingle();
    if (tgPaused) {
      throw new AccountOnTrafficGuardPause(payload.instagramAccountId, payload.automationId);
    }
    logEvent( 'warn', 'automation_fetch', 'skipped', `Automation ${payload.automationId} not found or inactive`, {});
    await markJobStatus(db, payload, 'skipped', 'Automation not found or inactive');
    return;
  }

  // ── Tenant pair validation (Phase E, fail closed) ───────────────────────
  // The payload's automationId and instagramAccountId are independent
  // assertions; every legitimate enqueue path derives both from the same
  // account-scoped query, so they always agree. A disagreement means the
  // job would run one tenant's automation content under another tenant's
  // account/token (comment triggers were already backstopped by the
  // reservation RPC's pair check; DM/story/reel triggers were not).
  // Refuse before any account data is used or any send is attempted.
  if (automation.instagram_account_id !== payload.instagramAccountId) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      `Job payload account does not match the automation's account binding - refusing to process`, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        automationAccountId: automation.instagram_account_id,
      });
    await markJobStatus(db, payload, 'skipped', 'Tenant context mismatch: automation does not belong to payload account');
    return;
  }

  const { data: igAccount } = await db
    .from('instagram_accounts')
    .select('*')
    .eq('id', payload.instagramAccountId)
    .eq('is_active', true)
    .single<InstagramAccountRow>();
  if (!igAccount) {
    logEvent( 'error', 'ig_account_fetch', 'error', `IG account ${payload.instagramAccountId} not found`, {});
    throw new Error('Instagram account not found or inactive');
  }

  // ── Traffic Guard pause: hold (never dispatch) while the guard is on ────
  if (igAccount.traffic_guard_paused || automation.is_traffic_guard_paused) {
    logEvent('warn', 'traffic_guard_hold', 'skipped',
      `Account @${igAccount.username ?? igAccount.id} is paused by Traffic Guard - holding job`, {
        accountId: igAccount.id,
        automationId: payload.automationId,
      });
    throw new AccountOnTrafficGuardPause(igAccount.id, payload.automationId);
  }

  assertAccountNotPaused(igAccount);

  // ── Recipient opt-out suppression (fail closed on lookup error) ─────────
  if (await isRecipientSuppressed(db, payload.instagramAccountId, payload.triggerUserId)) {
    logEvent('warn', 'recipient_suppressed', 'skipped',
      `Recipient ${payload.triggerUserId} is opted-out/suppressed - blocking outbound auto_dm`, {
        recipientId: payload.triggerUserId,
        automationId: payload.automationId,
      });
    await markJobStatus(db, payload, 'skipped', 'Recipient has opted out of automated messages');
    return;
  }

  // ── 4: Rate limit (atomic, per-account) ──────────────────────────────────
  await checkRateLimit(db, payload.instagramAccountId, ownerUserId);

  // ── 5: Decrypt token ─────────────────────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = decrypt(igAccount.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    logEvent( 'error', 'token_decrypt', 'error', 'Token decryption failed - TOKEN_ENCRYPTION_KEY mismatch?', {});
    throw new Error('Token decryption failed');
  }

  // ── 5.5: Atomic Comment Private Reply Reservation (Phase 6, row 13) ────
  // Meta policy invariant: AT MOST ONE private reply per comment across ALL
  // automations on the account. The reservation is acquired BEFORE any Meta
  // send in the guarded section below and is the pre-send record the
  // candidate previously lacked: a worker crash after this point can no
  // longer lose the only evidence that a send was authorized/in flight.
  // Placement is an adaptation of release-prep (which reserves before its
  // rate-limit step): here every pre-send guard that can skip/hold the job
  // without sending (window, dedupe, Traffic Guard, opt-out, local rate
  // limit, circuit breaker, token decrypt) has ALREADY run, so a held
  // reservation always guards a real send window and pre-send failures
  // never need to release one. Continuation steps (flow-node resumptions,
  // follow-ups) do not use the private-reply channel — they send via
  // { id: triggerUserId } — so they neither acquire nor consult the
  // reservation (release-prep reserves unconditionally; see reservations.ts).
  let privateReservationHeld = false;
  let privateSendAttempted = false;
  if (!isContinuationStep && payload.triggerType === 'comment' && payload.triggerEventId) {
    const reservation = await reserveCommentPrivateReply(
      db,
      payload.instagramAccountId,
      payload.triggerEventId,
      payload.automationId
    );
    if (!reservation.authorized) {
      logEvent('info', 'comment_reservation_denied', 'skipped',
        `Comment ${payload.triggerEventId} cannot be reserved (${reservation.reason}) - one-private-reply-per-comment enforced`, {
          commentId: payload.triggerEventId,
          status: reservation.status,
          reason: reservation.reason,
        });
      await markJobStatus(db, payload, 'skipped', 'Comment already received a private reply');
      return;
    }
    privateReservationHeld = true;
  }

  await markJobStatus(db, payload, 'processing', null);

  // Guarded send section: every Meta send for this comment (public reply,
  // flow graph, opening DM) happens inside this try. The catch applies the
  // release-prep reservation disposition (reservations.ts):
  // release / mark-failed / fail-closed-as-ambiguous.
  try {
  // ── 6: Human-like jitter before touching Meta ────────────────────────────
  await jitter();

  // ── 7: Public comment reply (GATED, idempotent across retries) ──────────
  // Release-prep gate restored (row 6): a public reply is posted ONLY when
  // public_reply_enabled is true. Text comes from public_reply_options,
  // falling back to comment_reply_options. The AI branch
  // (public_reply_mode='ai_generated') is deliberately NOT ported — manual /
  // pre-written replies only. Posted BEFORE the DM and tracked via
  // public_reply_sent_at so a retried job never spams a second visible reply.
  if (payload.triggerType === 'comment' && payload.triggerEventId) {
    if (automation.public_reply_enabled !== true) {
      logEvent('info', 'comment_reply', 'skipped', 'Public replies disabled for this automation (public_reply_enabled=false) - not posting', {});
    } else {
      const { data: jobRow } = await db
        .from('dm_jobs')
        .select('public_reply_sent_at')
        .eq('automation_id', payload.automationId)
        .eq('trigger_event_id', payload.triggerEventId)
        .maybeSingle();

      if (jobRow?.public_reply_sent_at) {
        logEvent( 'info', 'comment_reply', 'skipped', 'Public reply already posted on an earlier attempt', {});
      } else {
        const options = automation.public_reply_options?.length
          ? automation.public_reply_options
          : automation.comment_reply_options;
        const replyText = selectPublicReplyOption(options, payload.triggerEventId);
        if (replyText) {
          // Phase 6: pre-send PUBLIC reply reservation (its own table/RPCs,
          // same state machine as the private reservation). A denied
          // reservation skips ONLY the public reply — the private DM below
          // still proceeds (release-prep semantics). Adaptation: the
          // candidate's replyToComment returns void and swallows HTTP
          // errors internally, so a resolved call is confirmed 'sent'; a
          // THROWN call (network-level failure, outcome unknown) fails the
          // reservation closed instead of releasing it for a repost.
          const pubRes = await reserveCommentPublicReply(
            db,
            payload.instagramAccountId,
            payload.triggerEventId,
            payload.automationId
          );
          if (!pubRes.authorized) {
            logEvent('info', 'comment_reply', 'skipped',
              `Public reply reservation denied (${pubRes.reason}) - skipping duplicate public reply`, {
                commentId: payload.triggerEventId,
                reason: pubRes.reason,
              });
          } else {
            try {
              await replyToComment(payload.triggerEventId, renderTemplate(replyText, payload.triggerUsername), accessToken);
              await confirmCommentPublicReply(db, payload.instagramAccountId, payload.triggerEventId);
              await db
                .from('dm_jobs')
                .update({ public_reply_sent_at: new Date().toISOString() })
                .eq('automation_id', payload.automationId)
                .eq('trigger_event_id', payload.triggerEventId);
            } catch (pubErr) {
              if (
                pubErr instanceof MetaApiError &&
                pubErr.code !== undefined &&
                (META_RATE_LIMIT_CODES as readonly number[]).includes(pubErr.code)
              ) {
                // Definitive pre-delivery rejection — safe to re-reserve on retry.
                await releaseCommentPublicReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
              } else {
                await markCommentPublicReplyFailed(
                  db,
                  payload.instagramAccountId,
                  payload.triggerEventId,
                  pubErr instanceof Error ? pubErr.message : String(pubErr)
                );
              }
              logEvent('warn', 'comment_reply', 'error',
                `Public reply to comment ${payload.triggerEventId} failed - proceeding to send private DM`, {
                  commentId: payload.triggerEventId,
                });
            }
          }
        } else {
          logEvent('info', 'comment_reply', 'skipped', 'Public replies enabled but no reply text configured - not posting', {});
        }
      }
    }
  }

  // ── 7.5: Flow Graph Execution Engine (Phase 5, row 19) ──────────────────
  // Automations carrying a canonical flow_graph execute through the graph
  // engine instead of the linear pipeline below — the same decision point
  // release-prep uses (after the public-reply gate, before the opening DM).
  // All guards above (window, Traffic Guard hold, circuit breaker, opt-out
  // suppression, rate limit) have already run, and the flow engine
  // re-checks suppression before every send. Automations without a graph
  // are completely unaffected. Phase 6: the private-reply reservation held
  // for this job is confirmed when the graph sent at least one message and
  // released when it sent none (a delayed graph's continuation sends via
  // { id: triggerUserId }, not the private-reply channel, so holding the
  // reservation would guard nothing). The dm_sent_log insert below remains
  // the candidate's per-automation dedupe record, layered UNDER the
  // reservation's account-wide guarantee.
  if (automation.flow_graph && Array.isArray(automation.flow_graph.nodes) && automation.flow_graph.nodes.length > 0) {
    logEvent('info', 'flow_graph_execution', 'processing',
      `Executing flow graph for automation ${automation.id}`, {
        automationId: automation.id,
        nodeCount: automation.flow_graph.nodes.length,
        startNodeId: payload.flowNodeId || 'root',
      });

    // The graph may send this comment's private reply as its first message:
    // from here a throw is treated as a possibly-delivered send (ambiguous)
    // by the outer disposition, never as a safe-to-release pre-send error.
    // (Release-prep only flags its linear sends; flagging the graph too is
    // a deliberate fail-closed strengthening, since executeFlowGraph throws
    // on send errors after earlier nodes may already have sent.)
    if (privateReservationHeld) privateSendAttempted = true;
    const flowResult = await executeFlowGraph(db, automation.flow_graph, payload, automation, accessToken);
    if (flowResult.status === 'completed' || flowResult.status === 'delayed' || flowResult.status === 'skipped') {
      if (privateReservationHeld && payload.triggerEventId) {
        if (flowResult.messagesSent > 0) {
          await confirmCommentPrivateReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
        } else {
          await releaseCommentPrivateReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
        }
        privateReservationHeld = false;
      }
      if (flowResult.messagesSent > 0 && !payload.flowNodeId) {
        if (payload.triggerEventId) {
          const { error: logErr } = await db.from('dm_sent_log').insert({
            instagram_account_id: payload.instagramAccountId,
            automation_id: payload.automationId,
            trigger_user_id: payload.triggerUserId,
            trigger_event_id: payload.triggerEventId,
            ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
          });
          if (logErr && logErr.code !== '23505') {
            logger.error({ err: logErr }, 'Failed to insert dm_sent_log for flow graph');
          }
        }

        const { error: counterError } = await db.rpc('increment_automation_dms_sent', {
          automation_id: payload.automationId,
        });
        if (counterError) logger.warn({ err: counterError }, 'Failed to increment DM counter for flow graph');

        // Extra flow messages beyond the first are additional sends against
        // the hourly window (the up-front check reserved one slot).
        recordExtraSends(payload.instagramAccountId, flowResult.messagesSent - 1, resolvedWorkspaceId);
      }

      await markJobStatus(
        db,
        payload,
        flowResult.status === 'skipped' ? 'skipped' : 'sent',
        flowResult.reason ?? null,
        flowResult.status === 'completed' ? new Date() : undefined
      );
      logEvent('info', 'flow_graph_execution', flowResult.status === 'skipped' ? 'skipped' : 'ok',
        `Flow graph execution ${flowResult.status} (${flowResult.messagesSent} message(s) sent)`, {
          automationId: automation.id,
          reason: flowResult.reason ?? null,
        });
      return;
    }

    // flowResult.status === 'failed' (e.g. no valid starting node): fall
    // through to the linear pipeline, exactly as release-prep does.
    logEvent('warn', 'flow_graph_execution', 'error',
      `Flow graph execution failed (${flowResult.reason ?? 'unknown'}) - falling back to linear pipeline`, {
        automationId: automation.id,
      });
  }

  // ── 8: Compose + send the opening DM ─────────────────────────────────────
  if (!automation.dm_opening_message_enabled || !automation.dm_opening_message.trim()) {
    // Opening message is off - the FIRST response becomes the initial DM.
    const responses = automation.dm_responses ?? [];
    const firstResponse = responses.find((r) => r.content?.trim() || r.type === 'card');
    if (!firstResponse) {
      logEvent( 'info', 'opening_dm', 'skipped', 'Opening DM disabled and no responses configured - nothing to send', {});
      await markJobStatus(db, payload, 'skipped', 'DM disabled');
      if (privateReservationHeld && payload.triggerEventId) {
        await releaseCommentPrivateReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
        privateReservationHeld = false;
      }
      return;
    }

    // Comment triggers deliver the initial contact via private reply.
    const directRecipient: DmRecipient =
      payload.triggerType === 'comment' && payload.triggerEventId && firstResponse.type !== 'card'
        ? { commentId: payload.triggerEventId }
        : { id: payload.triggerUserId };

    logEvent( 'info', 'opening_dm', 'processing', 'Opening message off - sending first response directly', {
      recipientId: payload.triggerUserId,
      viaPrivateReply: 'commentId' in directRecipient,
    });

    if (privateReservationHeld) privateSendAttempted = true;
    try {
      await sendOneResponse(
        payload.igAccountIgsid,
        directRecipient,
        payload.triggerUserId,
        firstResponse,
        payload.triggerUsername,
        accessToken
      );
    } catch (err) {
      await markJobStatus(db, payload, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }

    const { error: directLogError } = await db.from('dm_sent_log').insert({
      instagram_account_id: payload.instagramAccountId,
      automation_id: payload.automationId,
      trigger_user_id: payload.triggerUserId,
      trigger_event_id: payload.triggerEventId,
      ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
    });
    if (directLogError && directLogError.code !== '23505') {
      logger.error({ err: directLogError }, 'Failed to insert dm_sent_log entry (direct response)');
    }
    await markJobStatus(db, payload, 'sent', null, new Date());
    await db.rpc('increment_automation_dms_sent', { automation_id: payload.automationId });

    if (privateReservationHeld && payload.triggerEventId) {
      await confirmCommentPrivateReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
      privateReservationHeld = false;
    }

    // Follow-up compliance (comment triggers): record intent only — the
    // follow-up is scheduled when the recipient genuinely responds.
    if (payload.triggerType === 'comment' && automation.follow_up_enabled && automation.follow_up_message?.trim()) {
      await recordWaitingResponseFollowUp(db, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        recipientId: payload.triggerUserId,
        recipientUsername: payload.triggerUsername ?? null,
        commentId: payload.triggerEventId,
        commentTimestamp: payload.triggerTimestamp,
        delayMinutes: automation.follow_up_delay_minutes || 60,
        message: automation.follow_up_message,
      });
    }

    logEvent( 'info', 'job_completed', 'ok', `Direct response delivered to ${payload.triggerUserId}`, {
      automationId: payload.automationId,
    });
    return;
  }

  const hasQuickReply = !!automation.dm_opening_message_button_title?.trim();
  let sessionId: string | null = null;
  let quickReplyPayload: string | undefined;

  if (hasQuickReply) {
    // Session row FIRST - its ID is the routing key embedded in the button payload.
    const expiresAt = new Date(Date.now() + MAX_EVENT_AGE_MS);
    const { data: session, error: sessionError } = await db
      .from('automation_sessions')
      .insert({
        automation_id: payload.automationId,
        instagram_account_id: payload.instagramAccountId,
        audience_ig_user_id: payload.triggerUserId,
        current_step: 1,
        completed: false,
        expires_at: expiresAt.toISOString(),
        ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
      })
      .select('id')
      .single();

    if (sessionError) {
      if (sessionError.code === '23505') {
        logEvent( 'info', 'session_create', 'skipped', `Active session already exists for ${payload.triggerUserId}`, {});
        await markJobStatus(db, payload, 'skipped', 'Session already active');
        if (privateReservationHeld && payload.triggerEventId) {
          await releaseCommentPrivateReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
          privateReservationHeld = false;
        }
        return;
      }
      logger.warn({ err: sessionError }, 'Session insert failed - degrading to plain DM');
      logEvent( 'warn', 'session_create', 'error', 'Session insert failed - sending plain DM without button', {
        error: sessionError.message,
      });
    } else {
      sessionId = session.id as string;
      quickReplyPayload = `SESSION_${sessionId}_STEP_1`;
      logEvent( 'info', 'session_create', 'ok', `Session created - id=${sessionId}`, { sessionId });
    }
  }

  // If variations exist, one is picked at random for this DM - same
  // rotation pattern as the public comment replies above. Falls back
  // to the legacy single opening message when no variations are stored.
  const openingVariations = (automation.dm_opening_message_variations ?? []).filter((v) => v.trim());
  const openingText = openingVariations.length > 0
    ? openingVariations[Math.floor(Math.random() * openingVariations.length)]!
    : automation.dm_opening_message;
  const messageText = renderTemplate(openingText.trim(), payload.triggerUsername);
  const openingLink = automation.dm_opening_message_button_link?.trim();

  // Comment triggers go out as PRIVATE REPLIES (recipient: comment_id) -
  // Meta's purpose-built comment-to-DM channel: separate 750/h allowance,
  // valid 7 days after the comment, more deliverable than general messaging.
  const recipient: DmRecipient =
    payload.triggerType === 'comment' && payload.triggerEventId
      ? { commentId: payload.triggerEventId }
      : { id: payload.triggerUserId };

  logEvent( 'info', 'opening_dm', 'processing', `Sending opening DM to ${payload.triggerUserId}`, {
    recipientId: payload.triggerUserId,
    viaPrivateReply: 'commentId' in recipient,
    hasQuickReply,
    sessionId,
  });

  let messageId: string;
  if (privateReservationHeld) privateSendAttempted = true;
  try {
    if (hasQuickReply && quickReplyPayload) {
      // 2-step flow: opening message + postback button ("Send me the link")
      messageId = await sendInstagramDm(payload.igAccountIgsid, recipient, messageText, accessToken, {
        title: automation.dm_opening_message_button_title!.trim(),
        payload: quickReplyPayload,
      });
    } else if (openingLink) {
      // 1-step flow with a link: try a tappable web_url button template first;
      // if Meta rejects it for this recipient, fall back to an inline link.
      const buttonTitle = automation.dm_opening_message_button_title?.trim() || 'Open link';
      try {
        messageId = await sendInstagramLinkButtonDm(
          payload.igAccountIgsid,
          recipient,
          messageText,
          buttonTitle,
          openingLink,
          accessToken
        );
      } catch (buttonErr) {
        if (!shouldFallBackToInlineLink(buttonErr)) throw buttonErr;
        logEvent( 'warn', 'opening_dm', 'processing', 'Link button rejected - falling back to inline link', {});
        messageId = await sendInstagramDm(
          payload.igAccountIgsid,
          recipient,
          `${messageText}\n\n${buttonTitle}: ${openingLink}`,
          accessToken
        );
      }
    } else {
      messageId = await sendInstagramDm(payload.igAccountIgsid, recipient, messageText, accessToken);
    }
  } catch (err) {
    // Orphaned session cleanup on hard failures - the engine classifies the error
    if (sessionId) {
      await db.from('automation_sessions').delete().eq('id', sessionId);
    }
    await markJobStatus(db, payload, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }

  // ── 9: Record the send ───────────────────────────────────────────────────
  const { error: logError } = await db.from('dm_sent_log').insert({
    instagram_account_id: payload.instagramAccountId,
    automation_id: payload.automationId,
    trigger_user_id: payload.triggerUserId,
    trigger_event_id: payload.triggerEventId,
    ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
  });
  if (logError && logError.code !== '23505') {
    logger.error({ err: logError }, 'Failed to insert dm_sent_log entry');
  }

  await markJobStatus(db, payload, 'sent', null, new Date());

  if (sessionId) {
    await db.from('dm_logs').insert({
      session_id: sessionId,
      direction: 'outbound',
      step: 1,
      message_text: messageText,
      ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
    });
  }

  const { error: counterError } = await db.rpc('increment_automation_dms_sent', {
    automation_id: payload.automationId,
  });
  if (counterError) logger.warn({ err: counterError }, 'Failed to increment DM counter');

  // Phase 6: the private reply is recorded — confirm the reservation. From
  // here the reservation is settled; any later failure (extra 1-step
  // responses are best-effort and outside the private-reply channel) must
  // not touch it.
  if (privateReservationHeld && payload.triggerEventId) {
    await confirmCommentPrivateReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
    privateReservationHeld = false;
  }

  // Follow-up compliance (comment triggers): record intent only — Meta
  // allows ONE private reply per comment, so the check-in is scheduled when
  // the recipient genuinely responds in the DM thread (webhook tap/DM paths).
  if (payload.triggerType === 'comment' && automation.follow_up_enabled && automation.follow_up_message?.trim()) {
    await recordWaitingResponseFollowUp(db, {
      automationId: payload.automationId,
      instagramAccountId: payload.instagramAccountId,
      sessionId,
      recipientId: payload.triggerUserId,
      recipientUsername: payload.triggerUsername ?? null,
      commentId: payload.triggerEventId,
      commentTimestamp: payload.triggerTimestamp,
      delayMinutes: automation.follow_up_delay_minutes || 60,
      message: automation.follow_up_message,
    });
  }

  // 1-step flow: no reveal button (or session creation degraded) → there is
  // no tap coming, so deliver the configured responses right away.
  if (!sessionId && automation.dm_responses?.length) {
    logEvent( 'info', 'responses_send', 'processing',
      `No reveal button - delivering ${automation.dm_responses.length} response(s) immediately`, {
        responseCount: automation.dm_responses.length,
      });
    const sentCount = await deliverResponsesBestEffort(payload, automation.dm_responses, accessToken, ownerUserId);
    // Opening DM used the reserved slot; responses are extra sends.
    recordExtraSends(payload.instagramAccountId, sentCount, resolvedWorkspaceId);
  }

  // Contacts: DM/story webhooks don't carry a username - enrich it (and the
  // follow flag) from the profile API now that they've messaged us.
  if (payload.triggerType !== 'comment') {
    void getAudienceProfile(payload.triggerUserId, accessToken).then((p) => {
      if (p) {
        updateContactProfile({
          instagramAccountId: payload.instagramAccountId,
          audienceIgUserId: payload.triggerUserId,
          username: p.username,
          followsBusiness: p.followsBusiness,
        });
      }
    });
  }

  logEvent( 'info', 'job_completed', 'ok', `Opening DM delivered to ${payload.triggerUserId}`, {
    automationId: payload.automationId,
    messageId,
    sessionId,
  });
  } catch (err) {
    // ── Reservation disposition (Phase 6; release-prep catch taxonomy) ─────
    if (privateReservationHeld && payload.triggerEventId) {
      const disposition = reservationDispositionForError(err, privateSendAttempted);
      if (disposition === 'release') {
        // Sending never began, or Meta definitively rejected the send
        // before delivery (rate-limit codes): safe for a retry to
        // re-reserve and send exactly once.
        await releaseCommentPrivateReply(db, payload.instagramAccountId, payload.triggerEventId, payload.automationId);
      } else if (disposition === 'mark_failed') {
        // Definitive permanent Meta failure (policy block / non-retryable).
        await markCommentPrivateReplyFailed(
          db,
          payload.instagramAccountId,
          payload.triggerEventId,
          payload.automationId,
          err instanceof Error ? err.message : String(err)
        );
      } else {
        // AMBIGUOUS OUTCOME: the send was initiated and its result is
        // unknown — Meta may have delivered. FAIL CLOSED: mark the
        // reservation failed so no retry/replay is ever authorized, and
        // surface AmbiguousDeliveryError so the engine fails (never
        // reschedules) this job.
        const errorMsg = err instanceof Error ? err.message : String(err);
        await markCommentPrivateReplyFailed(
          db,
          payload.instagramAccountId,
          payload.triggerEventId,
          payload.automationId,
          `Ambiguous delivery failure: ${errorMsg}`
        );
        await markJobStatus(db, payload, 'failed', `Ambiguous delivery outcome: ${errorMsg}`);
        throw new AmbiguousDeliveryError(`Ambiguous send outcome for comment ${payload.triggerEventId}: ${errorMsg}`);
      }
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Follow-up processor (quick-reply / postback tap)
// ═══════════════════════════════════════════════════════════════════════════

export async function processFollowUpDmJob(payload: AutoDmJobPayload): Promise<void> {
  // Scheduled check-in follow-ups have their own processor (durable claim,
  // 24h window, suppression + Traffic Guard guards).
  if (payload.isScheduledFollowUp) {
    return processScheduledFollowUpDm(payload);
  }

  const db = createServiceClient();
  const env = getEnv();

  // Owner-scoped debug logging (see processAutoDmJob).
  const { data: ownerRow } = await db
    .from('instagram_accounts')
    .select('user_id, workspace_id')
    .eq('id', payload.instagramAccountId)
    .maybeSingle();
  const ownerUserId = (ownerRow?.user_id as string | undefined) ?? null;
  let resolvedWorkspaceId: string | null = null;
  const logEvent = (
    level: DebugLevel,
    eventType: string,
    status: DebugStatus,
    message: string,
    metadata: Record<string, unknown> = {}
  ): void =>
    debugLog('worker', level, eventType, status, message, {
      ...metadata,
      userId: ownerUserId,
      ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
    });

  // ── Tenant pair pre-check (B-F3 / Programme 19, fail closed) ───────────
  // DIRECT automation↔account validation for the interactive follow-up
  // path. Until now this processor had NO direct check: it loaded the
  // automation (below) without even selecting instagram_account_id, so
  // cross-tenant safety rested indirectly on the session-ownership check
  // further down. That backstop only proves the SESSION row claims the
  // payload's automation+account — a session whose (automation_id,
  // instagram_account_id) pair was crafted to match the payload, or an
  // automation rebound to another account after its session was created,
  // would pass it and then deliver the automation owner's content under
  // the payload account's token. Mirror the scheduled processor's A-2
  // pre-check (Programme 17): resolve the pair FIRST, before the session
  // fetch, before the suppression branch and before ANY session-mutating
  // or send-capable operation (the A-1 ordering lesson: validation
  // precedes ALL writes). A missing automation falls through to the
  // existing handling below unchanged. Terminal behaviour follows this
  // processor's own convention for every other mismatch (workspace /
  // session, below): log tenant_context_mismatch and drop the job
  // (return) — this processor never writes a dm_jobs row.
  {
    const { data: pairAutomation } = await db
      .from('automations')
      .select('instagram_account_id')
      .eq('id', payload.automationId)
      .maybeSingle();
    if (pairAutomation && pairAutomation.instagram_account_id !== payload.instagramAccountId) {
      logEvent('error', 'tenant_context_mismatch', 'error',
        `Follow-up payload account does not match the automation's account binding - refusing to process`, {
          automationId: payload.automationId,
          instagramAccountId: payload.instagramAccountId,
          automationAccountId: pairAutomation.instagram_account_id,
        });
      return;
    }
  }

  // ── Workspace validation (Phase D1, fail closed — see processAutoDmJob).
  // Follow-up convention for an unprocessable job is to log and drop it
  // (return), exactly like the missing-session path below.
  const actualWorkspaceId = await resolveActualWorkspaceId(
    db,
    payload,
    ownerRow as Record<string, unknown> | null
  );
  if (payload.workspaceId && payload.workspaceId !== actualWorkspaceId) {
    resolvedWorkspaceId = payload.workspaceId;
    logEvent('error', 'tenant_context_mismatch', 'error',
      `Follow-up payload workspace does not match the account's workspace binding - refusing to process`, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        payloadWorkspaceId: payload.workspaceId,
        actualWorkspaceId,
      });
    return;
  }
  if (actualWorkspaceId) {
    resolvedWorkspaceId = actualWorkspaceId;
    if (!payload.workspaceId) payload.workspaceId = actualWorkspaceId;
  }

  logEvent( 'info', 'followup_started', 'processing', `Follow-up job started - step ${payload.sessionStep}`, {
    sessionId: payload.sessionId ?? null,
    sessionStep: payload.sessionStep ?? null,
    triggerUserId: payload.triggerUserId,
  });

  if (!payload.sessionId) {
    logEvent( 'warn', 'followup_started', 'error', 'Follow-up job has no sessionId - dropping', {});
    return;
  }

  // ── 1: Verify session ────────────────────────────────────────────────────
  // P17: the session fetch + tenant pair validation run BEFORE the
  // suppression branch below. The suppression branch mutates the session
  // row (marks it completed by bare id); when it ran first, a job naming
  // tenant A's account/automation but tenant B's session — with the
  // recipient suppressed under A's account (or the suppression lookup
  // failing closed) — completed B's session without any pair check.
  const { data: session } = await db
    .from('automation_sessions')
    .select('id, automation_id, instagram_account_id, audience_ig_user_id, current_step, expires_at, completed')
    .eq('id', payload.sessionId)
    .maybeSingle();

  if (!session) {
    logEvent( 'warn', 'session_verify', 'error', `Session ${payload.sessionId} not found`, {});
    return;
  }
  // ── Tenant pair validation (Phase E, fail closed) ───────────────────────
  // The session row is tenant data: it must belong to the payload's own
  // automation AND account. A foreign session is dropped WITHOUT touching
  // it (no completion, no step update) and nothing is sent — previously a
  // job naming tenant A's account/automation but tenant B's session would
  // deliver A's content and mark B's session completed.
  if (
    session.instagram_account_id !== payload.instagramAccountId ||
    session.automation_id !== payload.automationId
  ) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      `Follow-up session does not belong to the payload's automation/account - refusing to process`, {
        sessionId: payload.sessionId,
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        sessionAutomationId: session.automation_id,
        sessionAccountId: session.instagram_account_id,
      });
    return;
  }

  // ── 1.5: Recipient opt-out suppression (fail closed on lookup error) ────
  // Runs only after the pair validation above, so the session completion
  // here can only ever touch the payload's OWN tenant session.
  if (await isRecipientSuppressed(db, payload.instagramAccountId, payload.triggerUserId)) {
    logEvent('warn', 'followup_suppressed', 'skipped',
      `Recipient ${payload.triggerUserId} is suppressed (opted out) - dropping follow-up`, {
        recipientId: payload.triggerUserId,
        sessionId: payload.sessionId,
      });
    await db.from('automation_sessions').update({ completed: true }).eq('id', payload.sessionId);
    return;
  }
  if (session.completed as boolean) {
    logEvent( 'info', 'session_verify', 'skipped', `Session ${payload.sessionId} already completed`, {});
    return;
  }
  if (new Date(session.expires_at as string) < new Date()) {
    logEvent( 'warn', 'session_verify', 'skipped', `Session ${payload.sessionId} expired`, {});
    await db.from('automation_sessions').update({ completed: true }).eq('id', payload.sessionId);
    return;
  }

  const expectedStep = session.current_step as number;
  if (payload.sessionStep !== undefined && payload.sessionStep !== expectedStep) {
    logEvent( 'warn', 'session_verify', 'skipped',
      `Step mismatch: tap says ${payload.sessionStep}, session expects ${expectedStep} - stale button tap`, {});
    return;
  }

  // ── 2: Load automation + account, breaker + rate limit ───────────────────
  const { data: automation } = await db
    .from('automations')
    .select('instagram_account_id, dm_responses, dm_opening_message_button_link, ask_to_follow_enabled, ask_to_follow_message, ask_to_follow_visit_profile_button, ask_to_follow_confirm_button')
    .eq('id', payload.automationId)
    .eq('is_active', true)
    .single<AutomationRow>();
  if (!automation) {
    logEvent( 'warn', 'automation_fetch', 'skipped', `Automation ${payload.automationId} inactive - completing session`, {});
    await db.from('automation_sessions').update({ completed: true }).eq('id', payload.sessionId);
    return;
  }

  // ── Tenant pair validation (B-F3 defense-in-depth, fail closed) ────────
  // Same direct automation↔account check as the pre-check at the top of
  // this processor (which is the one that runs before suppression / any
  // session mutation), repeated on the row actually loaded for delivery —
  // the Phase E pattern used in processAutoDmJob and the scheduled
  // follow-up processor, both of which keep their later check alongside
  // the early one. On mismatch the session is NOT completed (unlike the
  // inactive branch above): it does not belong to this payload's pair.
  if (automation.instagram_account_id !== payload.instagramAccountId) {
    logEvent('error', 'tenant_context_mismatch', 'error',
      `Follow-up payload account does not match the automation's account binding - refusing to process`, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        automationAccountId: automation.instagram_account_id,
      });
    return;
  }

  const { data: igAccount } = await db
    .from('instagram_accounts')
    .select('*')
    .eq('id', payload.instagramAccountId)
    .eq('is_active', true)
    .single<InstagramAccountRow>();
  if (!igAccount) {
    throw new Error('Instagram account not found');
  }

  // Traffic Guard pause holds the follow-up job (engine parks it as 'held').
  if (igAccount.traffic_guard_paused) {
    logEvent('warn', 'traffic_guard_hold', 'skipped',
      `Account @${igAccount.username ?? igAccount.id} is paused by Traffic Guard - holding follow-up job`, {
        accountId: igAccount.id,
      });
    throw new AccountOnTrafficGuardPause(igAccount.id);
  }

  assertAccountNotPaused(igAccount);
  await checkRateLimit(db, payload.instagramAccountId, ownerUserId);

  let accessToken: string;
  try {
    accessToken = decrypt(igAccount.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new Error('Token decryption failed');
  }

  await jitter();

  // ── 3: Ask-to-follow gate (REAL follow check) ────────────────────────────
  // Instagram's User Profile API exposes is_user_follow_business for anyone
  // who has messaged the account - and a button tap IS a message, so we can
  // genuinely verify. Flow:
  //   step 1 tap → check: follower? deliver straight away : send ask card, step 2
  //   step 2 tap ("I'm following") → RE-CHECK: follower? deliver : gentle nudge
  // Unknown check results FAIL OPEN (deliver) - never block a real person
  // because Meta's profile endpoint hiccuped.
  if (automation.ask_to_follow_enabled && expectedStep === 1) {
    const audienceProfile = await getAudienceProfile(payload.triggerUserId, accessToken);
    const follows = audienceProfile?.followsBusiness ?? null;
    updateContactProfile({
      instagramAccountId: payload.instagramAccountId,
      audienceIgUserId: payload.triggerUserId,
      username: audienceProfile?.username ?? null,
      followsBusiness: follows,
    });

    if (follows === false) {
      const confirmPayload = `SESSION_${payload.sessionId}_STEP_2`;
      await sendAskToFollowDm(payload.igAccountIgsid, payload.triggerUserId, accessToken, {
        message: automation.ask_to_follow_message,
        creatorUsername: igAccount.username ?? '',
        visitProfileButtonTitle: automation.ask_to_follow_visit_profile_button,
        confirmButtonTitle: automation.ask_to_follow_confirm_button,
        confirmPayload,
      });

      await db
        .from('automation_sessions')
        .update({ current_step: 2, last_activity_at: new Date().toISOString() })
        .eq('id', payload.sessionId);

      logEvent( 'info', 'ask_to_follow_dm', 'ok', 'Not a follower - ask-to-follow card sent, session at step 2', {
        sessionId: payload.sessionId,
      });
      return;
    }

    logEvent( 'info', 'follow_check', 'ok',
      follows === true
        ? 'Audience member already follows - skipping ask-to-follow, delivering content'
        : 'Follow status unknown - failing open, delivering content',
      { sessionId: payload.sessionId, triggerUserId: payload.triggerUserId });
    // Fall through to responses
  }

  if (automation.ask_to_follow_enabled && expectedStep === 2) {
    const audienceProfile = await getAudienceProfile(payload.triggerUserId, accessToken);
    const follows = audienceProfile?.followsBusiness ?? null;
    updateContactProfile({
      instagramAccountId: payload.instagramAccountId,
      audienceIgUserId: payload.triggerUserId,
      username: audienceProfile?.username ?? null,
      followsBusiness: follows,
    });

    if (follows === false) {
      // Still not following - nudge and keep the session at step 2 so the
      // card's buttons stay live and they can tap "I'm following" again.
      await sendInstagramDm(
        payload.igAccountIgsid,
        { id: payload.triggerUserId },
        `Hmm, I still can't see your follow 👀 Tap "${automation.ask_to_follow_visit_profile_button}" above, hit Follow, then tap "${automation.ask_to_follow_confirm_button}" again 🙏`,
        accessToken
      );
      await db
        .from('automation_sessions')
        .update({ last_activity_at: new Date().toISOString() })
        .eq('id', payload.sessionId);

      logEvent( 'info', 'follow_check', 'skipped', 'Re-check: still not following - nudge sent, session stays at step 2', {
        sessionId: payload.sessionId,
        triggerUserId: payload.triggerUserId,
      });
      return;
    }

    logEvent( 'info', 'follow_check', 'ok',
      follows === true ? 'Re-check passed - audience member now follows, delivering content' : 'Re-check unknown - failing open, delivering content',
      { sessionId: payload.sessionId });
    // Fall through to responses
  }

  // ── 4: Deliver dm_responses sequentially ─────────────────────────────────
  if (!automation.dm_responses?.length) {
    logEvent( 'warn', 'responses_send', 'skipped', 'Automation has 0 dm_responses - session completed with no content', {
      hint: 'Add at least one response (text or card) in the automation configuration',
    });
    await db.from('automation_sessions').update({ completed: true, last_activity_at: new Date().toISOString() }).eq('id', payload.sessionId);
    return;
  }

  logEvent( 'info', 'responses_send', 'processing', `Sending ${automation.dm_responses.length} response(s) to ${payload.triggerUserId}`, {
    sessionId: payload.sessionId,
    responseCount: automation.dm_responses.length,
  });

  let lastMessageText = '';
  let deliveredCount = 0;
  for (const [idx, response] of automation.dm_responses.entries()) {
    if (!response.content?.trim() && response.type !== 'card') continue;
    if (deliveredCount > 0) await interMessageJitter();

    if (response.type === 'card') {
      const cardImageUrl = response.cardImage?.startsWith('http') ? response.cardImage : undefined;
      await sendInstagramCardDm(payload.igAccountIgsid, payload.triggerUserId, accessToken, {
        title: response.cardTitle ?? response.content,
        ...(cardImageUrl !== undefined ? { imageUrl: cardImageUrl } : {}),
        ...(response.cardSubtitle !== undefined ? { subtitle: response.cardSubtitle } : {}),
        ...(response.cardButtons !== undefined
          ? { buttons: response.cardButtons.map((b) => ({ title: b.title, url: b.link })) }
          : {}),
      });
      lastMessageText = response.cardTitle ?? response.content ?? 'Card message';
    } else {
      const messageText = renderTemplate(response.content.trim(), payload.triggerUsername);
      const link = response.buttonLink?.trim();
      if (link) {
        // Tappable link button first; inline-link fallback if Meta rejects it.
        const buttonTitle = response.buttonTitle?.trim() || 'Open link';
        try {
          await sendInstagramLinkButtonDm(
            payload.igAccountIgsid,
            { id: payload.triggerUserId },
            messageText,
            buttonTitle,
            link,
            accessToken
          );
          lastMessageText = messageText;
        } catch (buttonErr) {
          if (!shouldFallBackToInlineLink(buttonErr)) throw buttonErr;
          logEvent( 'warn', 'responses_send', 'processing', 'Link button rejected - falling back to inline link', {});
          const fallback = `${messageText}\n\n${buttonTitle}: ${link}`;
          await sendInstagramDm(payload.igAccountIgsid, { id: payload.triggerUserId }, fallback, accessToken);
          lastMessageText = fallback;
        }
      } else {
        await sendInstagramDm(payload.igAccountIgsid, { id: payload.triggerUserId }, messageText, accessToken);
        lastMessageText = messageText;
      }
    }
    deliveredCount += 1;
    logEvent( 'info', 'responses_send', 'ok', `Response ${idx + 1}/${automation.dm_responses.length} sent`, {
      responseIndex: idx + 1,
      type: response.type,
    });
  }

  // The tap reserved one slot; anything beyond the first message is extra.
  recordExtraSends(payload.instagramAccountId, deliveredCount - 1, resolvedWorkspaceId);

  // ── 5: Log + complete session ────────────────────────────────────────────
  if (payload.messageText) {
    await db.from('dm_logs').insert({
      session_id: payload.sessionId,
      direction: 'inbound',
      step: expectedStep,
      message_text: payload.messageText,
      ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
    });
  }
  if (lastMessageText) {
    await db.from('dm_logs').insert({
      session_id: payload.sessionId,
      direction: 'outbound',
      step: expectedStep,
      message_text: lastMessageText,
      ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
    });
  }

  await db
    .from('automation_sessions')
    .update({ completed: true, last_activity_at: new Date().toISOString() })
    .eq('id', payload.sessionId);

  await db.rpc('increment_automation_dms_sent', { automation_id: payload.automationId });

  logEvent( 'info', 'session_completed', 'ok', `All responses delivered to ${payload.triggerUserId}`, {
    sessionId: payload.sessionId,
    step: expectedStep,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduled follow-up processor (delayed check-in after a qualifying response)
// ═══════════════════════════════════════════════════════════════════════════

const STANDARD_DM_WINDOW_MS = 24 * 60 * 60 * 1000;

async function processScheduledFollowUpDm(payload: AutoDmJobPayload): Promise<void> {
  const db = createServiceClient();
  const env = getEnv();

  const originalEventId = payload.triggerEventId.replace(/^scheduled_/, '');

  // ── Tenant pair pre-check (P17, fail closed) ────────────────────────────
  // Every branch below this point (workspace mismatch / window expiry /
  // inactive automation / suppression) may write the durable follow-up
  // row via markFollowUpStatus, which is keyed by (automation_id,
  // recipient_id, qualified_event_id) with NO account filter. The Phase E
  // pair check further down therefore ran too late: a payload naming
  // tenant A's account with tenant B's automation had B's follow-up row
  // marked skipped/expired by those earlier branches before the pair
  // check was ever reached. Resolve the pair FIRST: when the automation
  // exists and belongs to a different account, complete ONLY the job as
  // skipped — the foreign follow-up row is never touched (the same
  // convention as the Phase E check below, which stays as
  // defense-in-depth). A missing automation falls through to the existing
  // step-2 handling unchanged.
  {
    const { data: pairAutomation } = await db
      .from('automations')
      .select('instagram_account_id')
      .eq('id', payload.automationId)
      .maybeSingle();
    if (pairAutomation && pairAutomation.instagram_account_id !== payload.instagramAccountId) {
      debugLog('worker', 'error', 'tenant_context_mismatch', 'error',
        `Scheduled follow-up payload account does not match the automation's account binding - refusing to process`, {
          automationId: payload.automationId,
          instagramAccountId: payload.instagramAccountId,
          automationAccountId: pairAutomation.instagram_account_id,
          ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
        });
      await markJobStatus(db, payload, 'skipped', 'Tenant context mismatch: automation does not belong to payload account');
      return;
    }
  }

  // ── Workspace validation (Phase D1, fail closed — see processAutoDmJob).
  // This processor has no owner lookup to reuse, so the account's binding
  // is resolved directly; on mismatch the follow-up row and the job are
  // both completed as 'skipped' (this processor's existing convention)
  // and nothing is claimed or sent.
  let scheduledActualWorkspaceId: string | null = null;
  try {
    scheduledActualWorkspaceId = await resolveWorkspaceForAccount(db, payload.instagramAccountId);
  } catch {
    scheduledActualWorkspaceId = null;
  }
  if (payload.workspaceId && payload.workspaceId !== scheduledActualWorkspaceId) {
    debugLog('worker', 'error', 'tenant_context_mismatch', 'error',
      `Scheduled follow-up payload workspace does not match the account's workspace binding - refusing to process`, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        workspaceId: payload.workspaceId,
        payloadWorkspaceId: payload.workspaceId,
        actualWorkspaceId: scheduledActualWorkspaceId,
      });
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'skipped', 'Tenant context mismatch: payload workspace does not match account binding');
    await markJobStatus(db, payload, 'skipped', 'Tenant context mismatch: payload workspace does not match account binding');
    return;
  }
  if (!payload.workspaceId && scheduledActualWorkspaceId) {
    payload.workspaceId = scheduledActualWorkspaceId;
  }

  debugLog('worker', 'info', 'scheduled_followup_start', 'processing',
    `Executing scheduled follow-up for recipient ${payload.triggerUserId}`, {
      automationId: payload.automationId,
      triggerUserId: payload.triggerUserId,
      triggerEventId: payload.triggerEventId,
      ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    });

  // 1: 24-hour messaging window, anchored at the qualifying response.
  if (!payload.triggerTimestamp || typeof payload.triggerTimestamp !== 'number') {
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'failed', 'Invalid trigger timestamp');
    return;
  }
  const responseAge = Date.now() - payload.triggerTimestamp;
  if (responseAge < 0 || responseAge > STANDARD_DM_WINDOW_MS) {
    debugLog('worker', 'warn', 'window_check', 'skipped',
      `Qualified response is ${Math.round(responseAge / 3600000)}h old - 24h messaging window closed`, {
        responseAgeHours: Math.round(responseAge / 3600000),
      });
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'expired', 'Messaging window closed');
    await markJobStatus(db, payload, 'skipped', 'Messaging window expired');
    return;
  }

  // 2: Automation must still be active with follow-ups enabled.
  const { data: automation } = await db
    .from('automations')
    .select('id, instagram_account_id, is_active, follow_up_enabled, follow_up_message, is_traffic_guard_paused')
    .eq('id', payload.automationId)
    .maybeSingle();
  if (!automation || !automation.is_active || !automation.follow_up_enabled) {
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'skipped', 'Automation inactive or follow-up disabled');
    await markJobStatus(db, payload, 'skipped', 'Automation inactive or follow-up disabled');
    return;
  }

  // ── Tenant pair validation (Phase E, fail closed) ───────────────────────
  // Same invariant as processAutoDmJob: the automation must belong to the
  // payload's account, otherwise the job would send one tenant's follow-up
  // content under another tenant's account. The follow-up ROW belongs to
  // the automation's tenant, so it is deliberately NOT touched here — only
  // the job itself is completed as skipped.
  if (automation.instagram_account_id !== payload.instagramAccountId) {
    debugLog('worker', 'error', 'tenant_context_mismatch', 'error',
      `Scheduled follow-up payload account does not match the automation's account binding - refusing to process`, {
        automationId: payload.automationId,
        instagramAccountId: payload.instagramAccountId,
        automationAccountId: automation.instagram_account_id,
        ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      });
    await markJobStatus(db, payload, 'skipped', 'Tenant context mismatch: automation does not belong to payload account');
    return;
  }

  // 3: Recipient opt-out suppression (fail closed on lookup error).
  if (await isRecipientSuppressed(db, payload.instagramAccountId, payload.triggerUserId)) {
    debugLog('worker', 'warn', 'scheduled_followup_suppressed', 'skipped',
      `Recipient ${payload.triggerUserId} is suppressed (opted out) - cancelling scheduled follow-up`, {
        recipientId: payload.triggerUserId,
        automationId: payload.automationId,
        ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      });
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'skipped', 'Recipient has opted out');
    await markJobStatus(db, payload, 'skipped', 'Recipient has opted out of automated messages');
    return;
  }

  // 4: Account must still be connected/active.
  const { data: igAccount } = await db
    .from('instagram_accounts')
    .select('*')
    .eq('id', payload.instagramAccountId)
    .eq('is_active', true)
    .maybeSingle<InstagramAccountRow>();
  if (!igAccount) {
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'skipped', 'Account inactive or disconnected');
    await markJobStatus(db, payload, 'skipped', 'Account inactive or disconnected');
    return;
  }

  // 5: Traffic Guard pause — row goes to 'held'; the engine parks the job as
  // held too. When the guard resumes, held jobs return to pending and the
  // claim below accepts 'held' rows, so the follow-up still fires exactly once.
  if (igAccount.traffic_guard_paused || automation.is_traffic_guard_paused) {
    debugLog('worker', 'warn', 'traffic_guard_hold', 'skipped',
      `Account @${igAccount.username ?? igAccount.id} is paused by Traffic Guard - holding follow-up job`, {
        accountId: igAccount.id,
        ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      });
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'held', 'Held by Traffic Guard pause');
    throw new AccountOnTrafficGuardPause(igAccount.id);
  }

  // 6: Circuit breaker + rate limit (both throw BEFORE the claim, so the row
  // stays 'scheduled' and a later attempt can still claim it).
  assertAccountNotPaused(igAccount);
  await checkRateLimit(db, payload.instagramAccountId);

  let accessToken: string;
  try {
    accessToken = decrypt(igAccount.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new Error('Token decryption failed');
  }

  await jitter();

  // 7: Atomic claim — exactly one worker may move scheduled/held → sending.
  // No claim, no send: this is the exactly-once guarantee across retries and
  // concurrent drains.
  const claimed = await claimFollowUpForSending(db, payload.automationId, payload.triggerUserId, originalEventId);
  if (!claimed) {
    debugLog('worker', 'info', 'scheduled_followup_claim', 'skipped',
      'Follow-up already claimed/sent by another worker - skipping duplicate send', {
        automationId: payload.automationId,
        triggerUserId: payload.triggerUserId,
        ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      });
    await markJobStatus(db, payload, 'skipped', 'Follow-up already claimed or sent');
    return;
  }

  // 8: Stored text only — the snapshot taken at schedule time wins; NO AI.
  const rawText = claimed.message_snapshot || payload.followUpText || automation.follow_up_message;
  if (!rawText?.trim()) {
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'skipped', 'Follow-up message is empty');
    await markJobStatus(db, payload, 'skipped', 'Follow-up message is empty');
    return;
  }
  const messageText = renderTemplate(rawText.trim(), payload.triggerUsername);

  // 9: Send.
  try {
    await sendInstagramDm(payload.igAccountIgsid, { id: payload.triggerUserId }, messageText, accessToken);
  } catch (err) {
    if (err instanceof MetaApiError && err.code !== undefined && (META_RATE_LIMIT_CODES as readonly number[]).includes(err.code)) {
      // Meta-side rate limit: release the claim so the rescheduled job can send later.
      await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'scheduled', null);
      throw err;
    }
    if (err instanceof AccountPausedMetaError || err instanceof NonRetryableMetaError) {
      await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'failed', err.message);
      await markJobStatus(db, payload, 'failed', err.message);
      throw err;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'failed', `Ambiguous outcome: ${errorMsg}`);
    await markJobStatus(db, payload, 'failed', `Ambiguous outcome: ${errorMsg}`);
    // Phase 6 parity with release-prep: an ambiguous follow-up outcome is
    // surfaced as AmbiguousDeliveryError so the engine fails the job
    // terminally instead of rescheduling a possibly-delivered send. (The
    // follow-up row is already 'failed', so its atomic claim would refuse
    // a resend either way — this makes the job outcome honest too.)
    throw new AmbiguousDeliveryError(`Ambiguous delivery outcome for follow-up: ${errorMsg}`);
  }

  // 10: Record success.
  const sentAt = new Date();
  await markFollowUpStatus(db, payload.automationId, payload.triggerUserId, originalEventId, 'sent', null, sentAt);
  await markJobStatus(db, payload, 'sent', null, sentAt);
  await db.rpc('increment_automation_dms_sent', { automation_id: payload.automationId });

  if (claimed.session_id) {
    await db.from('dm_logs').insert({
      session_id: claimed.session_id,
      direction: 'outbound',
      step: 99,
      message_text: messageText,
      // Phase H: payload.workspaceId here is the VALIDATED value (set
      // from the server-side derivation above when absent, and the job
      // was refused earlier on any mismatch).
      ...(payload.workspaceId ? { workspace_id: payload.workspaceId } : {}),
    });
  }

  debugLog('worker', 'info', 'scheduled_followup_delivered', 'ok',
    `Follow-up message delivered to ${payload.triggerUserId}`, {
      automationId: payload.automationId,
      triggerUserId: payload.triggerUserId,
      ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type JobStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'skipped';

export async function markJobStatus(
  db: SupabaseClient,
  payload: AutoDmJobPayload,
  status: JobStatus,
  errorMessage: string | null,
  sentAt?: Date
): Promise<void> {
  // Phase H (Programme 18): the dm_jobs row is stamped with the workspace
  // derived server-side from the payload ACCOUNT's binding — never from
  // payload.workspaceId, which is an unverified assertion at the call
  // sites that run before validation (e.g. the scheduled follow-up pair
  // pre-check). Derivation failure / unbound account ⇒ legacy unstamped
  // upsert, exactly as before.
  let derivedWorkspaceId: string | null = null;
  try {
    derivedWorkspaceId = await resolveWorkspaceForAccount(db, payload.instagramAccountId);
  } catch {
    derivedWorkspaceId = null;
  }
  const { error } = await db.from('dm_jobs').upsert(
    {
      automation_id: payload.automationId,
      instagram_account_id: payload.instagramAccountId,
      trigger_type: payload.triggerType,
      trigger_user_id: payload.triggerUserId,
      trigger_event_id: payload.triggerEventId,
      trigger_timestamp: new Date(payload.triggerTimestamp).toISOString(),
      status,
      error_message: errorMessage,
      sent_at: sentAt?.toISOString() ?? null,
      ...(derivedWorkspaceId ? { workspace_id: derivedWorkspaceId } : {}),
    },
    { onConflict: 'automation_id,trigger_event_id', ignoreDuplicates: false }
  );
  if (error) logger.warn({ err: error, status }, 'Failed to upsert dm_job status');
}
