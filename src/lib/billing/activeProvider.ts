/**
 * Active payment-provider selection (owner decision 2026-11-08
 * ~20:34 IST).
 *
 * Cashfree is the PRIMARY gateway: when CASHFREE_CLIENT_ID +
 * CASHFREE_CLIENT_SECRET are configured, checkout and the billing
 * panel use Cashfree. Razorpay remains fully wired as the FALLBACK —
 * it becomes active again only when Cashfree is not configured and
 * Razorpay keys are. Nothing here weakens the flag gates: the
 * checkout route still requires BILLING_ENABLED + PAYMENTS_LIVE_MODE
 * before any provider is consulted.
 */

import { readCashfreeConfig, type CashfreeConfig } from './cashfree';
import { readRazorpayConfig, type RazorpayConfig } from './razorpay';
import type { ProviderId } from './provider';

export interface ActiveBillingProvider {
  providerId: ProviderId;
  cashfree: CashfreeConfig;
  razorpay: RazorpayConfig;
}

/**
 * Resolve the active provider from env, or null when neither gateway
 * is configured (callers fail closed with PAYMENTS_NOT_CONFIGURED).
 * Cashfree wins whenever it is configured — that is the owner's
 * "Cashfree FINAL" decision, not an accident of ordering.
 */
export function resolveActiveBillingProvider(
  env: Record<string, string | undefined> = {},
): ActiveBillingProvider | null {
  const cashfree = readCashfreeConfig(env);
  const razorpay = readRazorpayConfig(env);
  if (cashfree.configured) return { providerId: 'cashfree', cashfree, razorpay };
  if (razorpay.configured) return { providerId: 'razorpay', cashfree, razorpay };
  return null;
}
