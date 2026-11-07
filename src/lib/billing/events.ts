/**
 * Phase 12 — normalized payment-event model + event store interface.
 * Enforces: provider event IDs stored, idempotent processing, replay
 * prevention, out-of-order protection, atomic lifecycle transitions,
 * sanitized metadata-only logging (no card data / secrets / PII payloads).
 */
import { canTransition, type SubscriptionStatus } from './lifecycle';
import type { ProviderId } from './provider';
import type { CurrencyCode } from './catalogue';

export type NormalizedEventType = 'subscription_activated' | 'subscription_charged' | 'payment_failed' | 'subscription_paused' | 'subscription_resumed' | 'subscription_cancelled' | 'subscription_expired' | 'subscription_updated' | 'unknown';
export interface NormalizedPaymentEvent {
  provider: ProviderId;
  providerEventId: string;
  providerSubscriptionId: string;
  type: NormalizedEventType;
  /** Provider event time (ms epoch) — used for out-of-order protection. */
  occurredAt: number;
  claimedStatus: SubscriptionStatus | null;
  amountMinor: number | null;
  currency: CurrencyCode | null;
}
export interface SubscriptionRecord {
  providerSubscriptionId: string; provider: ProviderId; workspaceId: string | null;
  status: SubscriptionStatus; currency: CurrencyCode; lastEventAt: number; version: number;
}
export interface SanitizedLogEntry { provider: ProviderId; providerEventId: string; providerSubscriptionId: string; type: NormalizedEventType; outcome: string; at: number; }
export interface BillingEventStore {
  hasEvent(providerEventId: string): boolean;
  recordEvent(e: NormalizedPaymentEvent, outcome: string): void;
  getSubscription(providerSubscriptionId: string): SubscriptionRecord | null;
  ensureSubscription(r: SubscriptionRecord): SubscriptionRecord;
  /** Atomic: checks lifecycle table + ordering, applies or rejects. */
  applyTransition(providerSubscriptionId: string, to: SubscriptionStatus, occurredAt: number): { applied: boolean; reason: 'applied' | 'noop' | 'illegal-transition' | 'stale-event' | 'terminal'; record: SubscriptionRecord };
  logs(): readonly SanitizedLogEntry[];
}
export class InMemoryBillingEventStore implements BillingEventStore {
  private events = new Map<string, string>();
  private subs = new Map<string, SubscriptionRecord>();
  private logEntries: SanitizedLogEntry[] = [];
  hasEvent(id: string): boolean { return this.events.has(id); }
  recordEvent(e: NormalizedPaymentEvent, outcome: string): void {
    this.events.set(e.providerEventId, outcome);
    // Sanitized metadata only — never the raw payload.
    this.logEntries.push({ provider: e.provider, providerEventId: e.providerEventId, providerSubscriptionId: e.providerSubscriptionId, type: e.type, outcome, at: Date.now() });
  }
  getSubscription(id: string): SubscriptionRecord | null { return this.subs.get(id) ?? null; }
  ensureSubscription(r: SubscriptionRecord): SubscriptionRecord { const ex = this.subs.get(r.providerSubscriptionId); if (ex) return ex; this.subs.set(r.providerSubscriptionId, { ...r }); return this.subs.get(r.providerSubscriptionId)!; }
  applyTransition(providerSubscriptionId: string, to: SubscriptionStatus, occurredAt: number) {
    const rec = this.subs.get(providerSubscriptionId);
    if (!rec) throw new Error(`Unknown subscription ${providerSubscriptionId}`);
    if (occurredAt < rec.lastEventAt) return { applied: false, reason: 'stale-event' as const, record: rec };
    if (rec.status === to) { rec.lastEventAt = Math.max(rec.lastEventAt, occurredAt); return { applied: false, reason: 'noop' as const, record: rec }; }
    if (!canTransition(rec.status, to)) {
      const terminal = rec.status === 'cancelled' || rec.status === 'expired';
      return { applied: false, reason: terminal ? ('terminal' as const) : ('illegal-transition' as const), record: rec };
    }
    rec.status = to; rec.lastEventAt = occurredAt; rec.version += 1;
    return { applied: true, reason: 'applied' as const, record: rec };
  }
  logs(): readonly SanitizedLogEntry[] { return this.logEntries; }
}
