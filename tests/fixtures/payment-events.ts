/**
 * Phase 12 — synthetic payment-event fixtures (Razorpay-shaped +
 * Cashfree-shaped). TEST secrets only — never real credentials.
 */
import { signRazorpayPayload } from '@/lib/billing/providers/razorpay';
import { signCashfreePayload } from '@/lib/billing/providers/cashfree';

export const TEST_RAZORPAY_SECRET = 'test_rzp_whsec_fixture_only';
export const TEST_CASHFREE_SECRET = 'test_cf_whsec_fixture_only';
export const TEST_CF_TIMESTAMP = '1730000000000';

export interface SignedFixture { rawBody: string; signature: string; payload: Record<string, unknown>; }

export function razorpayEvent(opts: {
  eventId: string; event: string; subscriptionId: string; status: string; createdAtSec: number;
  secret?: string;
}): SignedFixture {
  const payload = {
    id: opts.eventId, event: opts.event, created_at: opts.createdAtSec,
    payload: { subscription: { entity: { id: opts.subscriptionId, status: opts.status } } },
  };
  const rawBody = JSON.stringify(payload);
  return { rawBody, signature: signRazorpayPayload(rawBody, opts.secret ?? TEST_RAZORPAY_SECRET), payload };
}
export function cashfreeEvent(opts: {
  eventId: string; type: string; subscriptionId: string; status: string; eventTimeIso: string;
  secret?: string; timestamp?: string;
}): SignedFixture & { timestamp: string } {
  const payload = {
    event_id: opts.eventId, type: opts.type, event_time: opts.eventTimeIso,
    data: { subscription_id: opts.subscriptionId, subscription_status: opts.status },
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = opts.timestamp ?? TEST_CF_TIMESTAMP;
  return { rawBody, signature: signCashfreePayload(rawBody, opts.secret ?? TEST_CASHFREE_SECRET, timestamp), payload, timestamp };
}
