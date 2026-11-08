/**
 * Billing persistence — SaaS subscription wiring (2026-11-08).
 *
 * The data layer over the Phase 13 billing tables:
 *   subscriptions   (…000027 — one row per workspace, UNIQUE workspace_id)
 *   billing_events  (…000028 — the DURABLE form of the Phase 12
 *                    BillingEventStore: sanitized metadata only, with
 *                    UNIQUE (provider, provider_event_id) as the
 *                    database-level idempotency/replay guard)
 *   billing_orders  (…000035 — a Razorpay order bound to its workspace
 *                    at checkout time)
 *
 * All writes here are service-role server code: checkout (after owner
 * checks), the trial route (after owner checks), and the webhook route
 * (after signature verification). No client ever writes these tables
 * directly (the migrations grant authenticated SELECT only).
 *
 * WEBHOOK UNIT OF WORK: the Phase 12 core (processBillingWebhook)
 * works against the SYNCHRONOUS BillingEventStore interface, so a
 * database-backed store cannot be plugged in directly. The pattern
 * here is load → run → persist:
 *   1. loadWebhookStore seeds an InMemoryBillingEventStore with the
 *      workspace's current subscription record and the set of already-
 *      recorded provider event ids (just the incoming one is checked).
 *   2. The core runs unchanged — signature, server-side verification,
 *      idempotency, lifecycle transitions.
 *   3. persistWebhookOutcome writes back: the billing_events row
 *      (unique-guarded), the subscription row (plan/period/dates are
 *      set from the ORDER RECORD — server-side truth — when, and only
 *      when, the final status grants entitlement), and the order's
 *      own status.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import {
  InMemoryBillingEventStore,
  type BillingEventStore,
  type NormalizedPaymentEvent,
  type SubscriptionRecord,
} from './events';
import type { SubscriptionStatus } from './lifecycle';
import type { BillingPeriod, CurrencyCode, PlanId } from './catalogue';
import type { ProviderId } from './provider';

// ── Row shapes ──────────────────────────────────────────────────────────

/** Domain view of a subscriptions row (…000027). */
export interface WorkspaceSubscriptionRow {
  id: string;
  workspaceId: string;
  planId: string;
  /** Lifecycle status; the table also allows 'free' (its default). */
  status: SubscriptionStatus | 'free';
  provider: ProviderId | null;
  providerSubscriptionId: string | null;
  billingPeriod: BillingPeriod | null;
  amountMinor: number;
  currency: CurrencyCode;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  lastProviderEventAt: string | null;
}

/** Domain view of a billing_orders row (…000035). */
export interface BillingOrderRow {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  providerOrderId: string;
  planId: string;
  billingPeriod: BillingPeriod;
  amountMinor: number;
  currency: CurrencyCode;
  status: 'created' | 'paid' | 'failed' | 'expired';
  receipt: string | null;
  providerPaymentId: string | null;
  paidAt: string | null;
  createdAt: string;
}

interface SubscriptionDbRow {
  id: string;
  workspace_id: string;
  plan_id: string;
  lifecycle_status: string;
  provider: string | null;
  provider_subscription_id: string | null;
  billing_period: string | null;
  amount_minor: number;
  currency: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  last_provider_event_at: string | null;
}

interface BillingOrderDbRow {
  id: string;
  workspace_id: string;
  provider: string;
  provider_order_id: string;
  plan_id: string;
  billing_period: string;
  amount_minor: number;
  currency: string;
  status: string;
  receipt: string | null;
  provider_payment_id: string | null;
  paid_at: string | null;
  created_at: string;
}

const SUBSCRIPTION_COLS =
  'id, workspace_id, plan_id, lifecycle_status, provider, provider_subscription_id, billing_period, amount_minor, currency, current_period_start, current_period_end, trial_ends_at, last_provider_event_at';
const ORDER_COLS =
  'id, workspace_id, provider, provider_order_id, plan_id, billing_period, amount_minor, currency, status, receipt, provider_payment_id, paid_at, created_at';

function mapSubscription(r: SubscriptionDbRow): WorkspaceSubscriptionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    planId: r.plan_id,
    status: r.lifecycle_status as WorkspaceSubscriptionRow['status'],
    provider: (r.provider as ProviderId | null) ?? null,
    providerSubscriptionId: r.provider_subscription_id,
    billingPeriod: (r.billing_period as BillingPeriod | null) ?? null,
    amountMinor: Number(r.amount_minor ?? 0),
    currency: (r.currency === 'USD' ? 'USD' : 'INR') as CurrencyCode,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    trialEndsAt: r.trial_ends_at,
    lastProviderEventAt: r.last_provider_event_at,
  };
}

function mapOrder(r: BillingOrderDbRow): BillingOrderRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    provider: r.provider as ProviderId,
    providerOrderId: r.provider_order_id,
    planId: r.plan_id,
    billingPeriod: r.billing_period as BillingPeriod,
    amountMinor: Number(r.amount_minor ?? 0),
    currency: (r.currency === 'USD' ? 'USD' : 'INR') as CurrencyCode,
    status: r.status as BillingOrderRow['status'],
    receipt: r.receipt,
    providerPaymentId: r.provider_payment_id,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

export class BillingPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingPersistenceError';
  }
}

// ── Subscriptions ───────────────────────────────────────────────────────

export async function getWorkspaceSubscription(
  db: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceSubscriptionRow | null> {
  const { data, error } = await db
    .from('subscriptions')
    .select(SUBSCRIPTION_COLS)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new BillingPersistenceError(`Failed to read subscription: ${error.message}`);
  return data ? mapSubscription(data as SubscriptionDbRow) : null;
}

export interface SubscriptionUpsert {
  planId?: string;
  status?: SubscriptionStatus | 'free';
  provider?: ProviderId | null;
  providerSubscriptionId?: string | null;
  billingPeriod?: BillingPeriod | null;
  amountMinor?: number;
  currency?: CurrencyCode;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  trialEndsAt?: string | null;
  lastProviderEventAt?: string | null;
}

function toDbPatch(fields: SubscriptionUpsert): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (fields.planId !== undefined) patch.plan_id = fields.planId;
  if (fields.status !== undefined) patch.lifecycle_status = fields.status;
  if (fields.provider !== undefined) patch.provider = fields.provider;
  if (fields.providerSubscriptionId !== undefined) patch.provider_subscription_id = fields.providerSubscriptionId;
  if (fields.billingPeriod !== undefined) patch.billing_period = fields.billingPeriod;
  if (fields.amountMinor !== undefined) patch.amount_minor = fields.amountMinor;
  if (fields.currency !== undefined) patch.currency = fields.currency;
  if (fields.currentPeriodStart !== undefined) patch.current_period_start = fields.currentPeriodStart;
  if (fields.currentPeriodEnd !== undefined) patch.current_period_end = fields.currentPeriodEnd;
  if (fields.trialEndsAt !== undefined) patch.trial_ends_at = fields.trialEndsAt;
  if (fields.lastProviderEventAt !== undefined) patch.last_provider_event_at = fields.lastProviderEventAt;
  return patch;
}

/**
 * Insert-or-update the workspace's ONE subscription row. Only the
 * provided fields are written. Note the database trigger makes
 * `currency` immutable once a row exists — callers (checkout / trial)
 * check for a currency conflict BEFORE calling this and refuse with
 * CURRENCY_LOCKED; an update that still tried would raise here.
 */
export async function upsertWorkspaceSubscription(
  db: SupabaseClient,
  workspaceId: string,
  fields: SubscriptionUpsert,
): Promise<WorkspaceSubscriptionRow> {
  const existing = await getWorkspaceSubscription(db, workspaceId);
  const patch = toDbPatch(fields);
  if (existing) {
    const { error } = await db.from('subscriptions').update(patch).eq('id', existing.id);
    if (error) throw new BillingPersistenceError(`Failed to update subscription: ${error.message}`);
  } else {
    const { error } = await db.from('subscriptions').insert({
      id: randomUUID(),
      workspace_id: workspaceId,
      plan_id: fields.planId ?? 'free',
      lifecycle_status: fields.status ?? 'free',
      currency: fields.currency ?? 'INR',
      amount_minor: fields.amountMinor ?? 0,
      ...patch,
    });
    if (error) throw new BillingPersistenceError(`Failed to create subscription: ${error.message}`);
  }
  const row = await getWorkspaceSubscription(db, workspaceId);
  if (!row) throw new BillingPersistenceError('Subscription row vanished after upsert.');
  return row;
}

// ── Orders ──────────────────────────────────────────────────────────────

export interface CreateBillingOrderInput {
  workspaceId: string;
  provider: ProviderId;
  providerOrderId: string;
  planId: PlanId;
  billingPeriod: BillingPeriod;
  amountMinor: number;
  currency: CurrencyCode;
  receipt?: string | null;
}

/** Record a freshly created provider order against its workspace. */
export async function createBillingOrder(
  db: SupabaseClient,
  input: CreateBillingOrderInput,
): Promise<BillingOrderRow> {
  const id = randomUUID();
  const { error } = await db.from('billing_orders').insert({
    id,
    workspace_id: input.workspaceId,
    provider: input.provider,
    provider_order_id: input.providerOrderId,
    plan_id: input.planId,
    billing_period: input.billingPeriod,
    amount_minor: input.amountMinor,
    currency: input.currency,
    status: 'created',
    receipt: input.receipt ?? null,
  });
  if (error) throw new BillingPersistenceError(`Failed to record billing order: ${error.message}`);
  const row = await getBillingOrderByProviderOrderId(db, input.provider, input.providerOrderId);
  if (!row) throw new BillingPersistenceError('Billing order vanished after insert.');
  return row;
}

export async function getBillingOrderByProviderOrderId(
  db: SupabaseClient,
  provider: ProviderId,
  providerOrderId: string,
): Promise<BillingOrderRow | null> {
  const { data, error } = await db
    .from('billing_orders')
    .select(ORDER_COLS)
    .eq('provider', provider)
    .eq('provider_order_id', providerOrderId)
    .maybeSingle();
  if (error) throw new BillingPersistenceError(`Failed to read billing order: ${error.message}`);
  return data ? mapOrder(data as BillingOrderDbRow) : null;
}

export async function listBillingOrders(
  db: SupabaseClient,
  workspaceId: string,
  limit = 5,
): Promise<BillingOrderRow[]> {
  const { data, error } = await db
    .from('billing_orders')
    .select(ORDER_COLS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new BillingPersistenceError(`Failed to list billing orders: ${error.message}`);
  return ((data ?? []) as BillingOrderDbRow[]).map(mapOrder);
}

async function updateBillingOrder(
  db: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('billing_orders').update(patch).eq('id', id);
  if (error) throw new BillingPersistenceError(`Failed to update billing order: ${error.message}`);
}

// ── Webhook unit of work ────────────────────────────────────────────────

/** Server-side truth for one order, resolved from billing_orders. */
export interface WebhookOrderContext {
  workspaceId: string;
  planId: PlanId;
  period: BillingPeriod;
  amountMinor: number;
  currency: CurrencyCode;
}

export function orderContextOf(order: BillingOrderRow): WebhookOrderContext {
  return {
    workspaceId: order.workspaceId,
    planId: order.planId as PlanId,
    period: order.billingPeriod,
    amountMinor: order.amountMinor,
    currency: order.currency,
  };
}

/** The subscriptions table's 'free' default is not a lifecycle state; the core sees it as 'incomplete'. */
function toLifecycleStatus(status: SubscriptionStatus | 'free'): SubscriptionStatus {
  return status === 'free' ? 'incomplete' : status;
}

/**
 * A BillingEventStore backed by an InMemoryBillingEventStore seeded
 * from the database: the workspace's current subscription record plus
 * the already-recorded provider event ids. Only the incoming event's
 * id is pre-checked (the core asks hasEvent for nothing else).
 */
class SeededBillingEventStore implements BillingEventStore {
  private readonly seen: Set<string>;
  constructor(
    private readonly inner: InMemoryBillingEventStore,
    seenEventIds: Iterable<string>,
  ) {
    this.seen = new Set(seenEventIds);
  }
  hasEvent(providerEventId: string): boolean {
    return this.seen.has(providerEventId) || this.inner.hasEvent(providerEventId);
  }
  recordEvent(e: NormalizedPaymentEvent, outcome: string): void {
    this.seen.add(e.providerEventId);
    this.inner.recordEvent(e, outcome);
  }
  getSubscription(id: string) { return this.inner.getSubscription(id); }
  ensureSubscription(r: SubscriptionRecord) { return this.inner.ensureSubscription(r); }
  applyTransition(id: string, to: SubscriptionStatus, occurredAt: number) {
    return this.inner.applyTransition(id, to, occurredAt);
  }
  logs() { return this.inner.logs(); }
}

export interface LoadedWebhookStore {
  store: BillingEventStore;
  /** The workspace's subscription record as seeded (status mapped to lifecycle), or null on first sight. */
  seededRecord: SubscriptionRecord | null;
}

export async function loadWebhookStore(
  db: SupabaseClient,
  provider: ProviderId,
  providerOrderId: string,
  incomingEventId: string,
  orderCtx: WebhookOrderContext,
): Promise<LoadedWebhookStore> {
  const inner = new InMemoryBillingEventStore();
  let seededRecord: SubscriptionRecord | null = null;

  const sub = await getWorkspaceSubscription(db, orderCtx.workspaceId);
  if (sub) {
    seededRecord = inner.ensureSubscription({
      providerSubscriptionId: providerOrderId,
      provider,
      workspaceId: orderCtx.workspaceId,
      status: toLifecycleStatus(sub.status),
      currency: sub.currency,
      lastEventAt: sub.lastProviderEventAt ? Date.parse(sub.lastProviderEventAt) || 0 : 0,
      version: 0,
    });
  }

  const seen: string[] = [];
  const { data, error } = await db
    .from('billing_events')
    .select('id')
    .eq('provider', provider)
    .eq('provider_event_id', incomingEventId)
    .maybeSingle();
  if (error) throw new BillingPersistenceError(`Failed to check billing event: ${error.message}`);
  if (data) seen.push(incomingEventId);

  return { store: new SeededBillingEventStore(inner, seen), seededRecord };
}

/** End of the current paid period for a payment confirmed at `start`. */
export function periodEnd(start: Date, period: BillingPeriod): Date {
  const d = new Date(start.getTime());
  if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

export interface PersistWebhookOutcomeInput {
  provider: ProviderId;
  order: BillingOrderRow;
  orderCtx: WebhookOrderContext;
  event: NormalizedPaymentEvent;
  outcome: string;
  /** The store's final subscription record for this order (post-transition), if any. */
  finalRecord: SubscriptionRecord | null;
}

/**
 * Write back one processed webhook: the sanitized billing_events row
 * (UNIQUE-guarded — a racing duplicate insert is swallowed), the
 * subscription row, and the order's status. Plan/period/dates are set
 * from the order record ONLY when the final status grants entitlement
 * ('active'); a non-active outcome never rewrites the workspace's
 * plan — it only refreshes the provider binding + last-event marker on
 * an existing row. trial_ends_at is deliberately never cleared here:
 * it is the workspace's trial-used marker as well as its trial clock.
 */
export async function persistWebhookOutcome(
  db: SupabaseClient,
  input: PersistWebhookOutcomeInput,
): Promise<void> {
  const { provider, order, orderCtx, event, outcome, finalRecord } = input;
  const occurredIso = new Date(event.occurredAt).toISOString();

  const { error: eventError } = await db.from('billing_events').insert({
    id: randomUUID(),
    provider,
    provider_event_id: event.providerEventId,
    provider_subscription_id: event.providerSubscriptionId,
    workspace_id: orderCtx.workspaceId,
    event_type: event.type,
    claimed_status: event.claimedStatus,
    server_status: finalRecord?.status ?? null,
    outcome,
    occurred_at: occurredIso,
  });
  if (eventError && eventError.code !== '23505') {
    throw new BillingPersistenceError(`Failed to record billing event: ${eventError.message}`);
  }

  if (finalRecord?.status === 'active') {
    const start = new Date(event.occurredAt);
    await upsertWorkspaceSubscription(db, orderCtx.workspaceId, {
      planId: orderCtx.planId,
      status: 'active',
      provider,
      providerSubscriptionId: event.providerSubscriptionId,
      billingPeriod: orderCtx.period,
      amountMinor: orderCtx.amountMinor,
      currency: orderCtx.currency,
      currentPeriodStart: start.toISOString(),
      currentPeriodEnd: periodEnd(start, orderCtx.period).toISOString(),
      lastProviderEventAt: occurredIso,
    });
    const paymentId = event.providerEventId.split(':')[1];
    await updateBillingOrder(db, order.id, {
      status: 'paid',
      provider_payment_id: paymentId && paymentId.startsWith('pay_') ? paymentId : order.providerPaymentId,
      paid_at: occurredIso,
    });
    return;
  }

  // Non-active outcome: refresh binding/marker on an existing row only,
  // and only when the core actually applied (or idempotently confirmed)
  // the state — a stale or illegal event must not move the marker or
  // rebind the row to an unrelated order.
  if (outcome === 'applied' || outcome === 'noop') {
    const existing = await getWorkspaceSubscription(db, orderCtx.workspaceId);
    if (existing) {
      await upsertWorkspaceSubscription(db, orderCtx.workspaceId, {
        provider,
        providerSubscriptionId: event.providerSubscriptionId,
        lastProviderEventAt: occurredIso,
      });
    }
  }
  if (event.type === 'payment_failed' && order.status === 'created') {
    await updateBillingOrder(db, order.id, { status: 'failed' });
  }
}
