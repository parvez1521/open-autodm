/**
 * Razorpay LIVE integration — SaaS billing scaffolding (2026-11-08).
 *
 * STATUS: ready-to-enable, deliberately INERT. This module only does
 * something when the owner has (a) created a Razorpay merchant account,
 * (b) put real keys in the environment, and (c) the billing flags are
 * deliberately turned on (see ./flags.ts — BILLING_ENABLED and
 * PAYMENTS_LIVE_MODE both default OFF). Prices come from ./catalogue.ts,
 * owner-approved on 2026-11-08; the flags and keys above are still
 * required before any charge may be taken.
 *
 * What lives here:
 *  - readRazorpayConfig: env-only configuration. Importing this module
 *    NEVER throws and NEVER reads real env implicitly in tests — callers
 *    pass an env record (routes pass process.env).
 *  - createRazorpayOrder: one POST to Razorpay's Orders API
 *    (https://razorpay.com/docs/api/orders) with HTTP Basic auth
 *    (KEY_ID:KEY_SECRET). Order creation alone charges nobody; money
 *    moves only after the customer completes Razorpay Checkout and the
 *    payment is confirmed server-side (webhook + signature check).
 *  - verifyRazorpayWebhookSignature: pure HMAC-SHA-256 verification of
 *    the x-razorpay-signature header against the EXACT raw body, using
 *    the webhook secret. Same scheme as the mock adapter in
 *    ./providers/razorpay.ts, exposed standalone for the real webhook
 *    route to use.
 *
 * Secrets rule: key secret / webhook secret values are NEVER logged,
 * NEVER returned to clients, and NEVER read from anywhere but env.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CurrencyCode } from './catalogue';

export const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

export interface RazorpayConfig {
  keyId: string | null;
  keySecret: string | null;
  webhookSecret: string | null;
  /** True only when BOTH API keys are present and non-empty. */
  configured: boolean;
}

/**
 * Read Razorpay configuration from an env-like record. Missing or blank
 * values are reported as "not configured" — this never throws, so
 * routes can fail closed with a clear state instead of crashing.
 */
export function readRazorpayConfig(
  env: Record<string, string | undefined> = {},
): RazorpayConfig {
  const clean = (v: string | undefined): string | null => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  const keyId = clean(env.RAZORPAY_KEY_ID);
  const keySecret = clean(env.RAZORPAY_KEY_SECRET);
  const webhookSecret = clean(env.RAZORPAY_WEBHOOK_SECRET);
  return {
    keyId,
    keySecret,
    webhookSecret,
    configured: keyId !== null && keySecret !== null,
  };
}

export function isRazorpayConfigured(
  env: Record<string, string | undefined> = {},
): boolean {
  return readRazorpayConfig(env).configured;
}

/**
 * Verify a Razorpay webhook signature. Pure function: HMAC-SHA-256 hex
 * of the exact raw request body keyed with the webhook secret, compared
 * in constant time. Returns false (never throws) for missing secret,
 * missing/blank signature, or any mismatch — callers must fail closed.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string,
  webhookSecret: string,
): boolean {
  if (!webhookSecret || !signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RazorpayApiError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  constructor(status: number, providerCode: string | null, description: string) {
    super(`Razorpay API error (HTTP ${status})${providerCode ? ` [${providerCode}]` : ''}: ${description}`);
    this.name = 'RazorpayApiError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

export interface CreateOrderInput {
  /** Integer amount in the currency's minor unit (paise / cents). */
  amountMinor: number;
  currency: CurrencyCode;
  /** Merchant-side reference, ≤ 40 chars per Razorpay's API. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  currency: string;
  receipt: string | null;
  status: string;
  attempts: number;
  createdAt: number;
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Create a Razorpay order via the official REST API. The caller is
 * responsible for the configured-check (config.configured) — this
 * function throws if the config is incomplete, the amount is not a
 * positive integer, or Razorpay returns a non-2xx response.
 */
export async function createRazorpayOrder(
  config: RazorpayConfig,
  input: CreateOrderInput,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<RazorpayOrder> {
  if (!config.configured || !config.keyId || !config.keySecret) {
    throw new Error('Razorpay is not configured: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing.');
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error('Order amount must be a positive integer in minor units.');
  }
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
  const res = await fetchImpl(RAZORPAY_ORDERS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes ?? {},
    }),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = (data?.error ?? {}) as { code?: string; description?: string };
    throw new RazorpayApiError(
      res.status,
      typeof err.code === 'string' ? err.code : null,
      typeof err.description === 'string' ? err.description : 'order creation failed',
    );
  }
  const o = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    entity: String(o.entity ?? 'order'),
    amount: Number(o.amount ?? input.amountMinor),
    amountPaid: Number(o.amount_paid ?? 0),
    amountDue: Number(o.amount_due ?? input.amountMinor),
    currency: String(o.currency ?? input.currency),
    receipt: typeof o.receipt === 'string' ? o.receipt : null,
    status: String(o.status ?? 'created'),
    attempts: Number(o.attempts ?? 0),
    createdAt: Number(o.created_at ?? 0),
  };
}
