/**
 * Inbound webhook admission control — Phase 10.4 Workstream C (S-07).
 *
 * ════════════════════════════════════════════════════════════════════════
 * DESIGN (reasoning recorded in phase10.4-scratch-C-inbound.md)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Where this sits: POST /api/webhook verifies the HMAC over the raw body
 * FIRST (403 on failure — unchanged, and this module is never reached for
 * an unverified request), parses the body, returns 200 to Meta, and only
 * then — inside `after()` — runs admission + processing. Admission
 * therefore bounds the background WORK, never the acknowledgement:
 *
 *   invalid   (bad/missing signature) → 403 from the route, before any
 *             limiter cost. This module never sees the request.
 *   duplicate (verified event already admitted once — a Meta retry) →
 *             still 200; the event is classified 'duplicate', removed
 *             before processing, and consumes NO limiter quota. The
 *             job_queue dedupe_key UNIQUE remains as a second layer
 *             (and is the only layer while this limiter fails open).
 *   excessive (verified, distinct, but the account is at its window
 *             limit) → still 200; the event is classified 'shed', NOT
 *             processed, and NOT silently dropped: the limiter store
 *             keeps a metadata-only shed row (account id + event key +
 *             timestamp) and a counts-only debug event is emitted.
 *   admitted  → processed by processWebhookPayload exactly as before.
 *
 * Why never 429 (or any non-200) for verified traffic: Meta retries
 * non-200 webhook deliveries, so throttling at the HTTP layer would
 * amplify the very load it tries to shed, and the retried duplicates
 * would hammer the limiter. Ack-and-shed bounds cost to one cheap RPC
 * per excess event while keeping Meta's delivery state clean.
 *
 * Keying: per IG account, using ONLY the entry id of the HMAC-verified
 * payload (the account IGSID Meta signed over). Never IPs, never client
 * headers — both are spoofable and, behind Meta's delivery fleet,
 * meaningless. Per-account keys mean one flooding account can never
 * consume another account's quota.
 *
 * Store: Postgres (migration 20260730000022, FILE ONLY — not yet in the
 * approved deploy apply-list; owner approval required). One row per
 * distinct event; the UNIQUE (account, event) constraint classifies
 * duplicates, and the count of 'admitted' rows in the rolling window is
 * the limit — the same sliding-window shape as the outbound DM limiter
 * (dm_rate_events / check_and_record_dm_rate_limit).
 *
 * DB-outage behaviour — FAIL OPEN on the throttle only: if the limiter
 * store errors (including "RPC does not exist" before migration …000022
 * is applied), the verified body is admitted unfiltered and a single
 * error debug event is logged. Rationale: the ack has already been sent,
 * so shedding on a store blip would silently lose legitimate, verified
 * events — the worst failure mode for an automation product — while the
 * remaining layers still bound harm (job_queue dedupe prevents duplicate
 * sends, the outbound 180/hr limiter + circuit breaker fail independently
 * of this store). The inverse asymmetry already exists in the codebase
 * by design: opt-out suppression fails CLOSED (a wrong send is worse
 * than a missed one); ingestion throttling fails OPEN (a lost verified
 * trigger is worse than extra processing).
 *
 * Observability: counts and ids only — account IGSID (already logged by
 * processWebhook), event keys (comment ids / message mids, already the
 * dedupe identity elsewhere), counts, the configured limit. No message
 * text, no comment text, no usernames are read or logged here.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import type {
  MetaWebhookBody,
  MetaWebhookChange,
  MetaWebhookEntry,
  MetaWebhookMessaging,
} from '@/lib/types';

const logger = createLogger('inbound-rate-limit');

// ── PROPOSED DEFAULT THRESHOLDS — OWNER APPROVAL REQUIRED ──────────────────
// These numbers are deliberately generous and are NOT owner-approved yet.
// They live here, in exactly one place; the RPC receives them as
// parameters on every call, so changing them needs no migration.
//
// Sizing: the outbound DM limiter caps useful sends at 180/hour/account.
// 3,600 admitted inbound events/hour is 20× that ceiling and ~1 event per
// second sustained — far above normal use, and a viral-post burst (even
// several hundred comments inside a few minutes) fits entirely inside
// the window quota because a sliding-window count can be spent as a
// burst. What it bounds is a pathological flood (delivery loop, abusive
// replay of signed traffic, runaway integration): background DB work and
// queue growth per account stay finite instead of scaling with the flood.
export const INBOUND_LIMIT_PER_HOUR = 3600;
export const INBOUND_WINDOW_SECONDS = 3600;

export type InboundDecision = 'admitted' | 'duplicate' | 'shed';

export interface InboundEventRef {
  /** Verified payload entry id (IG account IGSID). The limiter key. */
  igAccountId: string;
  /** Dedupe identity of the event, e.g. `comment:<id>` / `mid:<mid>`. */
  eventKey: string;
  entryIndex: number;
  kind: 'change' | 'messaging';
  itemIndex: number;
}

/**
 * The limiter store. The production implementation is one Postgres RPC;
 * tests inject an in-memory equivalent. Implementations must classify a
 * previously-admitted eventKey as 'duplicate' (no quota consumed) and a
 * previously-shed one as 'shed'.
 */
export interface InboundEventStore {
  checkAndRecord(input: {
    igAccountId: string;
    eventKey: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ decision: InboundDecision; windowCount: number }>;
}

export interface InboundAdmissionStats {
  admitted: number;
  duplicates: number;
  shed: number;
  /** Non-actionable items (receipts, echoes, other change fields). */
  passthrough: number;
  /** True when the store failed and the body was admitted unfiltered. */
  failOpen: boolean;
  shedByAccount: Record<string, number>;
}

export interface InboundAdmissionResult {
  /** Body with duplicate + shed events removed; null when nothing remains. */
  body: MetaWebhookBody | null;
  stats: InboundAdmissionStats;
}

function createSupabaseInboundStore(): InboundEventStore {
  // Phase H (Programme 18): the …000022 RPC keys rows by IGSID TEXT and
  // predates tenancy, so the workspace is resolved ONCE per store (per
  // admitted body) from the trusted IGSID→account binding and stamped
  // onto each row the RPC newly creates (admitted/shed). Duplicate
  // classifications create no row and need no stamp. Unbound/unknown
  // IGSID ⇒ no stamp (legacy NULL). Best-effort: a stamp failure never
  // changes the admission decision.
  const workspaceByIgsid = new Map<string, Promise<string | null>>();
  const resolveWorkspace = (
    db: ReturnType<typeof createServiceClient>,
    igsid: string
  ): Promise<string | null> => {
    let pending = workspaceByIgsid.get(igsid);
    if (!pending) {
      pending = (async () => {
        try {
          const { data, error } = await db
            .from('instagram_accounts')
            .select('workspace_id')
            .eq('instagram_user_id', igsid)
            .maybeSingle();
          if (error || !data) return null;
          const ws = (data as { workspace_id?: unknown }).workspace_id;
          return typeof ws === 'string' && ws.length > 0 ? ws : null;
        } catch {
          return null;
        }
      })();
      workspaceByIgsid.set(igsid, pending);
    }
    return pending;
  };

  return {
    async checkAndRecord(input) {
      const db = createServiceClient();
      const { data, error } = await db.rpc('check_and_record_inbound_event', {
        p_ig_account_id: input.igAccountId,
        p_event_key: input.eventKey,
        p_limit: input.limit,
        p_window_seconds: input.windowSeconds,
      });
      if (error) throw new Error(`inbound limiter RPC failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as
        | { decision?: unknown; window_count?: unknown }
        | null
        | undefined;
      if (!row || (row.decision !== 'admitted' && row.decision !== 'duplicate' && row.decision !== 'shed')) {
        throw new Error('inbound limiter RPC returned an unexpected shape');
      }
      const decision = row.decision as InboundDecision;
      if (decision !== 'duplicate') {
        try {
          const workspaceId = await resolveWorkspace(db, input.igAccountId);
          if (workspaceId) {
            await db
              .from('inbound_webhook_events')
              .update({ workspace_id: workspaceId })
              .eq('ig_account_id', input.igAccountId)
              .eq('event_key', input.eventKey);
          }
        } catch {
          // stamping is audit-only; admission must not fail over it
        }
      }
      return {
        decision,
        windowCount: typeof row.window_count === 'number' ? row.window_count : 0,
      };
    },
  };
}

/**
 * Classifies one messaging item. Returns its event key when the item is
 * actionable work, or null for items that must pass through uncounted
 * (read/delivery receipts and echoes — processWebhookPayload filters
 * them cheaply, and echoes are bounded by the outbound limiter anyway).
 */
function messagingEventKey(messaging: MetaWebhookMessaging): string | null {
  if (messaging.read || messaging.delivery) return null;
  if (messaging.message?.is_echo) return null;
  if (messaging.message?.mid) return `mid:${messaging.message.mid}`;
  if (messaging.postback) {
    // Postback-only taps carry no mid; sender + timestamp + the routing
    // payload is their stable delivery identity.
    return `postback:${messaging.sender.id}:${messaging.timestamp}:${messaging.postback.payload}`;
  }
  if (messaging.message) {
    // A message with no mid is not expected from Meta; key it on sender +
    // timestamp so identical redeliveries still dedupe.
    return `msg:${messaging.sender.id}:${messaging.timestamp}`;
  }
  return null;
}

/** Lists the actionable (quota-bearing) events of a verified body, in order. */
export function extractActionableEvents(body: MetaWebhookBody): InboundEventRef[] {
  const events: InboundEventRef[] = [];
  body.entry.forEach((entry, entryIndex) => {
    entry.changes?.forEach((change, itemIndex) => {
      // Only comment changes create automation work; other fields
      // (mentions, insights, …) are ignored downstream and pass through.
      if (change.field === 'comments' && change.value?.id) {
        events.push({
          igAccountId: entry.id,
          eventKey: `comment:${change.value.id}`,
          entryIndex,
          kind: 'change',
          itemIndex,
        });
      }
    });
    entry.messaging?.forEach((messaging, itemIndex) => {
      const eventKey = messagingEventKey(messaging);
      if (eventKey) {
        events.push({ igAccountId: entry.id, eventKey, entryIndex, kind: 'messaging', itemIndex });
      }
    });
  });
  return events;
}

function countPassthrough(body: MetaWebhookBody, actionable: InboundEventRef[]): number {
  const actionableChanges = new Set(
    actionable.filter((e) => e.kind === 'change').map((e) => `${e.entryIndex}:${e.itemIndex}`)
  );
  const actionableMessaging = new Set(
    actionable.filter((e) => e.kind === 'messaging').map((e) => `${e.entryIndex}:${e.itemIndex}`)
  );
  let n = 0;
  body.entry.forEach((entry, entryIndex) => {
    entry.changes?.forEach((_change, itemIndex) => {
      if (!actionableChanges.has(`${entryIndex}:${itemIndex}`)) n += 1;
    });
    entry.messaging?.forEach((_messaging, itemIndex) => {
      if (!actionableMessaging.has(`${entryIndex}:${itemIndex}`)) n += 1;
    });
  });
  return n;
}

/** Rebuilds the body without the removed (duplicate/shed) items. */
function buildFilteredBody(
  body: MetaWebhookBody,
  removed: Set<string>
): MetaWebhookBody | null {
  const entries: MetaWebhookEntry[] = [];
  body.entry.forEach((entry, entryIndex) => {
    const hadItems = (entry.changes?.length ?? 0) + (entry.messaging?.length ?? 0) > 0;
    const changes: MetaWebhookChange[] = (entry.changes ?? []).filter(
      (_c, itemIndex) => !removed.has(`change:${entryIndex}:${itemIndex}`)
    );
    const messaging: MetaWebhookMessaging[] = (entry.messaging ?? []).filter(
      (_m, itemIndex) => !removed.has(`messaging:${entryIndex}:${itemIndex}`)
    );
    if (hadItems && changes.length === 0 && messaging.length === 0) {
      return; // every item was a duplicate or shed — drop the whole entry
    }
    const next: MetaWebhookEntry = { ...entry };
    if (entry.changes) next.changes = changes;
    if (entry.messaging) next.messaging = messaging;
    entries.push(next);
  });
  if (entries.length === 0) return null;
  return { ...body, entry: entries };
}

export interface AdmitOptions {
  store?: InboundEventStore;
  limit?: number;
  windowSeconds?: number;
}

/**
 * Admission for one verified webhook body. NEVER throws: any store
 * failure fails open (the original body is returned unfiltered) per the
 * design note above.
 */
export async function admitInboundWebhook(
  body: MetaWebhookBody,
  options: AdmitOptions = {}
): Promise<InboundAdmissionResult> {
  const stats: InboundAdmissionStats = {
    admitted: 0,
    duplicates: 0,
    shed: 0,
    passthrough: 0,
    failOpen: false,
    shedByAccount: {},
  };

  // Non-Instagram objects are rejected downstream by
  // processWebhookPayload; admission does not second-guess that.
  if (body.object !== 'instagram' || !Array.isArray(body.entry) || body.entry.length === 0) {
    return { body, stats };
  }

  const actionable = extractActionableEvents(body);
  stats.passthrough = countPassthrough(body, actionable);
  if (actionable.length === 0) {
    return { body, stats };
  }

  const store = options.store ?? createSupabaseInboundStore();
  const limit = options.limit ?? INBOUND_LIMIT_PER_HOUR;
  const windowSeconds = options.windowSeconds ?? INBOUND_WINDOW_SECONDS;

  const removed = new Set<string>();
  for (const event of actionable) {
    let decision: InboundDecision;
    try {
      ({ decision } = await store.checkAndRecord({
        igAccountId: event.igAccountId,
        eventKey: event.eventKey,
        limit,
        windowSeconds,
      }));
    } catch (err) {
      // FAIL OPEN on the throttle only (see header): stop consulting the
      // store for the rest of this body, admit everything unfiltered,
      // and say so once — counts/metadata only.
      stats.failOpen = true;
      logger.error({ err }, 'Inbound limiter store unavailable - failing open (verified ingestion continues)');
      debugLog('webhook', 'error', 'inbound_rate_limit_error', 'error',
        'Inbound limiter store unavailable - failing open; verified webhook admitted without throttling', {
          igAccountId: event.igAccountId,
        });
      return { body, stats };
    }

    if (decision === 'admitted') {
      stats.admitted += 1;
    } else if (decision === 'duplicate') {
      stats.duplicates += 1;
      removed.add(`${event.kind === 'change' ? 'change' : 'messaging'}:${event.entryIndex}:${event.itemIndex}`);
    } else {
      stats.shed += 1;
      stats.shedByAccount[event.igAccountId] = (stats.shedByAccount[event.igAccountId] ?? 0) + 1;
      removed.add(`${event.kind === 'change' ? 'change' : 'messaging'}:${event.entryIndex}:${event.itemIndex}`);
    }
  }

  if (stats.shed > 0) {
    // Counts-only observability for shed work: the events are recorded in
    // inbound_webhook_events (decision='shed') and summarised here. No
    // content, no usernames.
    for (const [igAccountId, shedCount] of Object.entries(stats.shedByAccount)) {
      debugLog('webhook', 'warn', 'inbound_rate_limit_shed', 'skipped',
        `Inbound rate limit: shed ${shedCount} verified event(s) for account ${igAccountId} (window limit ${limit})`, {
          igAccountId,
          shedCount,
          limitPerWindow: limit,
          windowSeconds,
        });
    }
  }

  if (removed.size === 0) return { body, stats };
  return { body: buildFilteredBody(body, removed), stats };
}
