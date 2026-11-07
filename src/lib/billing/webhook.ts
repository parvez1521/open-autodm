/**
 * Phase 12 — webhook processing module.
 * Order of operations (security-critical):
 *  1. Resolve secret via SecretsProvider — missing secret = fail closed.
 *  2. Verify signature against the EXACT raw body BEFORE parsing trust.
 *  3. Parse + normalize. Redirect/return URLs are never payment proof —
 *     this module is the only entitlement path, and it requires step 4.
 *  4. Verify status server-side via adapter.fetchSubscription — the
 *     server snapshot WINS over webhook claims.
 *  5. Idempotency / replay / out-of-order checks via the event store.
 *  6. Atomic transition via the lifecycle table. Logs are sanitized
 *     metadata only.
 */
import type { BillingProvider, SecretsProvider } from './provider';
import type { BillingEventStore, NormalizedPaymentEvent } from './events';
import { RazorpayMockProvider } from './providers/razorpay';
import { CashfreeMockProvider } from './providers/cashfree';
import { grantsEntitlement } from './lifecycle';

export type WebhookOutcome =
  | 'applied' | 'noop' | 'duplicate' | 'stale' | 'illegal-transition'
  | 'invalid-signature' | 'missing-secret' | 'verification-unavailable'
  | 'unknown-subscription' | 'unparseable';
export interface WebhookResult { outcome: WebhookOutcome; entitlementGranted: boolean; subscriptionStatus: string | null; }

export interface WebhookProcessorDeps {
  provider: BillingProvider; store: BillingEventStore; secrets: SecretsProvider;
  normalize: (payload: Record<string, unknown>) => NormalizedPaymentEvent | null;
  /** Cashfree current scheme needs the timestamp header for verification. */
  signatureTimestamp?: string;
}
export function normalizeForProvider(providerId: string, payload: Record<string, unknown>): NormalizedPaymentEvent | null {
  if (providerId === 'razorpay') return RazorpayMockProvider.normalizeEvent(payload);
  if (providerId === 'cashfree') return CashfreeMockProvider.normalizeEvent(payload);
  return null;
}

export async function processBillingWebhook(
  deps: WebhookProcessorDeps,
  input: { rawBody: string; signature: string; workspaceId?: string },
): Promise<WebhookResult> {
  const { provider, store, secrets } = deps;
  const secret = secrets.getWebhookSecret(provider.id);
  if (!secret) return { outcome: 'missing-secret', entitlementGranted: false, subscriptionStatus: null };
  // Cashfree adapter accepts an optional timestamp arg.
  const verified = provider.id === 'cashfree'
    ? (provider as CashfreeMockProvider).verifyWebhookSignature(input.rawBody, input.signature, secret, deps.signatureTimestamp)
    : provider.verifyWebhookSignature(input.rawBody, input.signature, secret);
  if (!verified) return { outcome: 'invalid-signature', entitlementGranted: false, subscriptionStatus: store.getSubscription(extractSubIdSafe(input.rawBody))?.status ?? null };
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(input.rawBody) as Record<string, unknown>; } catch { return { outcome: 'unparseable', entitlementGranted: false, subscriptionStatus: null }; }
  const event = deps.normalize(payload);
  if (!event) return { outcome: 'unparseable', entitlementGranted: false, subscriptionStatus: null };
  if (store.hasEvent(event.providerEventId)) {
    const rec = store.getSubscription(event.providerSubscriptionId);
    return { outcome: 'duplicate', entitlementGranted: rec ? grantsEntitlement(rec.status) : false, subscriptionStatus: rec?.status ?? null };
  }
  // Server-side verification — provider outage/timeout grants NOTHING.
  let snapshot;
  try { snapshot = await provider.fetchSubscription(event.providerSubscriptionId); }
  catch { return { outcome: 'verification-unavailable', entitlementGranted: false, subscriptionStatus: store.getSubscription(event.providerSubscriptionId)?.status ?? null }; }
  // Ensure a local record exists (starts incomplete unless server says otherwise on first sight is handled by transition rules: seed with server status's legal predecessor is complex — seed as incomplete, then transition; if server status == incomplete, noop).
  let rec = store.getSubscription(event.providerSubscriptionId);
  if (!rec) {
    rec = store.ensureSubscription({ providerSubscriptionId: event.providerSubscriptionId, provider: provider.id, workspaceId: input.workspaceId ?? null, status: 'incomplete', currency: snapshot.currency, lastEventAt: 0, version: 0 });
    // First-sight bootstrap: if the server-verified status cannot be reached from incomplete (e.g. paused), seed directly from server truth — this is initial sync, not a webhook-claimed transition.
    if (snapshot.status !== 'incomplete' && snapshot.status !== 'trialing' && snapshot.status !== 'active' && snapshot.status !== 'cancelled' && snapshot.status !== 'expired') {
      rec.status = snapshot.status;
    }
  }
  const serverStatus = snapshot.status; // server wins over event.claimedStatus
  const result = store.applyTransition(event.providerSubscriptionId, serverStatus, event.occurredAt);
  const outcome: WebhookOutcome = result.reason === 'applied' ? 'applied' : result.reason === 'noop' ? 'noop' : result.reason === 'stale-event' ? 'stale' : 'illegal-transition';
  store.recordEvent(event, outcome);
  const finalRec = store.getSubscription(event.providerSubscriptionId)!;
  return { outcome, entitlementGranted: grantsEntitlement(finalRec.status), subscriptionStatus: finalRec.status };
}
function extractSubIdSafe(rawBody: string): string { try { const p = JSON.parse(rawBody) as Record<string, unknown>; const e = RazorpayMockProvider.normalizeEvent(p) ?? CashfreeMockProvider.normalizeEvent(p); return e?.providerSubscriptionId ?? ''; } catch { return ''; } }
