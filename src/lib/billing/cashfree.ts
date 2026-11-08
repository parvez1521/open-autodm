/**
 * Cashfree LIVE integration — SaaS billing (owner decision 2026-11-08
 * ~20:34 IST: Cashfree is the PRIMARY payment gateway; Razorpay stays
 * in the tree as a fallback — see ./razorpay.ts).
 *
 * STATUS: ready-to-enable, deliberately INERT. This module only does
 * something when the owner has (a) created a Cashfree merchant
 * account, (b) put the credentials in the environment, and (c) the
 * billing flags are deliberately turned on (see ./flags.ts —
 * BILLING_ENABLED and PAYMENTS_LIVE_MODE both default OFF). Prices
 * come from ./catalogue.ts, owner-approved on 2026-11-08.
 *
 * What lives here:
 *  - readCashfreeConfig: env-only configuration. Importing this module
 *    NEVER throws and NEVER reads real env implicitly in tests —
 *    callers pass an env record (routes pass process.env).
 *  - createCashfreeOrder: one POST to Cashfree's Create Order API
 *    (https://www.cashfree.com/docs/api-reference/payments/orders) with
 *    x-client-id / x-client-secret / x-api-version headers. Order
 *    creation alone charges nobody; money moves only after the
 *    customer completes the Cashfree checkout and the payment is
 *    confirmed server-side (webhook + signature check + server
 *    re-read — see ./cashfreeLiveProvider.ts).
 *  - fetchCashfreeOrder: the server-side truth read used by the
 *    webhook core ("the server snapshot wins over webhook claims").
 *  - verifyCashfreeWebhookSignature: pure verification of the
 *    x-webhook-signature header — base64 HMAC-SHA-256 of
 *    `${x-webhook-timestamp}${rawBody}` (PLAIN concatenation, per
 *    Cashfree's PG docs: "Concatenate the timestamp and raw request
 *    body: timestamp + rawBody") keyed with the CLIENT SECRET,
 *    computed over the EXACT raw body.
 *
 *    ⚠ SCHEME NOTE: the Phase 12 SUBSCRIPTION mock
 *    (./providers/cashfree.ts) signs `${timestamp}.${rawBody}` WITH a
 *    literal dot — that is the PHP concatenation operator from
 *    Cashfree's PHP example transcribed as data. The Payment Gateway
 *    scheme implemented here (and used by Cashfree's Node SDK,
 *    PGVerifyWebhookSignature) is plain concatenation with NO
 *    separator. The two are deliberately NOT unified: the mock is a
 *    pinned Phase 12 fixture, this module is the live PG contract.
 *
 * Amounts: Cashfree's order API takes MAJOR units (₹299.00) while the
 * catalogue is integer MINOR units (29900 paise). The conversion
 * happens exactly once, at this API boundary (minorToMajor /
 * majorToMinor), and billing_orders keeps recording minor units.
 *
 * Secrets rule: the client secret is NEVER logged, NEVER returned to
 * clients, and NEVER read from anywhere but env. Cashfree checkout
 * needs only the payment_session_id server-side + the SDK mode
 * client-side, so no credential of any kind reaches the browser.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CurrencyCode } from './catalogue';

/** PG API version pinned for every request (order + webhook shapes). */
export const CASHFREE_API_VERSION = '2023-08-01';

export const CASHFREE_BASE_URLS = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
} as const;

export type CashfreeEnvironment = 'sandbox' | 'production';

export interface CashfreeConfig {
  clientId: string | null;
  clientSecret: string | null;
  /** Sandbox unless CASHFREE_ENV is exactly 'production'. */
  environment: CashfreeEnvironment;
  /** Base URL for the configured environment. */
  baseUrl: string;
  /** True only when BOTH credentials are present and non-empty. */
  configured: boolean;
}

/**
 * Read Cashfree configuration from an env-like record. Missing or
 * blank values are reported as "not configured" — this never throws,
 * so routes can fail closed with a clear state instead of crashing.
 */
export function readCashfreeConfig(
  env: Record<string, string | undefined> = {},
): CashfreeConfig {
  const clean = (v: string | undefined): string | null => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  const clientId = clean(env.CASHFREE_CLIENT_ID);
  const clientSecret = clean(env.CASHFREE_CLIENT_SECRET);
  const environment: CashfreeEnvironment =
    clean(env.CASHFREE_ENV) === 'production' ? 'production' : 'sandbox';
  return {
    clientId,
    clientSecret,
    environment,
    baseUrl: CASHFREE_BASE_URLS[environment],
    configured: clientId !== null && clientSecret !== null,
  };
}

export function isCashfreeConfigured(
  env: Record<string, string | undefined> = {},
): boolean {
  return readCashfreeConfig(env).configured;
}

/**
 * Verify a Cashfree PG webhook signature. Pure function: base64
 * HMAC-SHA-256 of `${timestamp}${rawBody}` (plain concatenation)
 * keyed with the client secret, compared in constant time. Returns
 * false (never throws) for a missing secret, signature or timestamp,
 * or any mismatch — callers must fail closed.
 */
export function verifyCashfreeWebhookSignature(
  rawBody: string,
  signature: string,
  clientSecret: string,
  timestamp: string | undefined,
): boolean {
  if (!clientSecret || !signature || !timestamp) return false;
  const expected = createHmac('sha256', clientSecret)
    .update(`${timestamp}${rawBody}`)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class CashfreeApiError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  constructor(status: number, providerCode: string | null, description: string) {
    super(`Cashfree API error (HTTP ${status})${providerCode ? ` [${providerCode}]` : ''}: ${description}`);
    this.name = 'CashfreeApiError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

/** Catalogue minor units (paise/cents) → Cashfree major units (₹/$), exact 2dp. */
export function minorToMajor(amountMinor: number): number {
  return Number((amountMinor / 100).toFixed(2));
}

/** Cashfree major units → integer minor units (server amounts come back as decimals). */
export function majorToMinor(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function authHeaders(config: CashfreeConfig): Record<string, string> {
  if (!config.configured || !config.clientId || !config.clientSecret) {
    throw new Error('Cashfree is not configured: CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET are missing.');
  }
  return {
    'x-client-id': config.clientId,
    'x-client-secret': config.clientSecret,
    'x-api-version': CASHFREE_API_VERSION,
    'Content-Type': 'application/json',
  };
}

function providerError(data: Record<string, unknown> | null, fallback: string): { code: string | null; description: string } {
  return {
    code: typeof data?.code === 'string' ? data.code : null,
    description: typeof data?.message === 'string' ? data.message : fallback,
  };
}

export interface CreateCashfreeOrderInput {
  /** OUR order id (also sent as Cashfree's order_id): ≤ 50 chars, [A-Za-z0-9_-]. */
  orderId: string;
  /** Integer amount in the currency's minor unit (paise / cents). */
  amountMinor: number;
  currency: CurrencyCode;
  customer: {
    /** Stable per-workspace customer id (Cashfree requires one). */
    customerId: string;
    /** Cashfree REQUIRES a customer phone for checkout. */
    phone: string;
    email?: string;
    name?: string;
  };
  /** Where Cashfree sends the customer's browser after payment. */
  returnUrl?: string;
  /** Per-order webhook override; the dashboard webhook is the primary path. */
  notifyUrl?: string;
  note?: string;
}

export interface CashfreeOrder {
  /** The order id (ours — Cashfree echoes it back). */
  orderId: string;
  /** Cashfree's internal numeric order id. */
  cfOrderId: string | null;
  /** Hand to the Cashfree JS SDK to open checkout. Not a secret. */
  paymentSessionId: string;
  orderStatus: string;
  amountMinor: number;
  currency: string;
}

/**
 * Create a Cashfree order via the official REST API. The caller is
 * responsible for the configured-check (config.configured) — this
 * function throws if the config is incomplete, the amount is not a
 * positive integer, or Cashfree returns a non-2xx response.
 */
export async function createCashfreeOrder(
  config: CashfreeConfig,
  input: CreateCashfreeOrderInput,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<CashfreeOrder> {
  const headers = authHeaders(config);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error('Order amount must be a positive integer in minor units.');
  }
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(input.orderId)) {
    throw new Error('Cashfree order id must be 1-50 chars of [A-Za-z0-9_-].');
  }
  const res = await fetchImpl(`${config.baseUrl}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      order_id: input.orderId,
      order_amount: minorToMajor(input.amountMinor),
      order_currency: input.currency,
      customer_details: {
        customer_id: input.customer.customerId.slice(0, 50),
        customer_phone: input.customer.phone,
        ...(input.customer.email ? { customer_email: input.customer.email } : {}),
        ...(input.customer.name ? { customer_name: input.customer.name } : {}),
      },
      order_meta: {
        ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
        ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
      },
      ...(input.note ? { order_note: input.note.slice(0, 200) } : {}),
    }),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = providerError(data, 'order creation failed');
    throw new CashfreeApiError(res.status, err.code, err.description);
  }
  const o = (data ?? {}) as Record<string, unknown>;
  const sessionId = typeof o.payment_session_id === 'string' ? o.payment_session_id : '';
  if (!sessionId) {
    throw new CashfreeApiError(res.status, null, 'Cashfree order response carried no payment_session_id');
  }
  return {
    orderId: typeof o.order_id === 'string' ? o.order_id : input.orderId,
    cfOrderId: o.cf_order_id != null ? String(o.cf_order_id) : null,
    paymentSessionId: sessionId,
    orderStatus: String(o.order_status ?? 'ACTIVE'),
    amountMinor: typeof o.order_amount === 'number' ? majorToMinor(o.order_amount) : input.amountMinor,
    currency: String(o.order_currency ?? input.currency),
  };
}

export interface CashfreeOrderSnapshotRaw {
  orderId: string;
  cfOrderId: string | null;
  /** Cashfree order_status: 'PAID' | 'ACTIVE' | 'EXPIRED'. */
  status: string;
  amountMinor: number;
  currency: string;
}

/** Read one order from Cashfree (server-side truth for the webhook core). */
export async function fetchCashfreeOrder(
  config: CashfreeConfig,
  orderId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<CashfreeOrderSnapshotRaw> {
  const headers = authHeaders(config);
  const res = await fetchImpl(`${config.baseUrl}/orders/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers,
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = providerError(data, 'order fetch failed');
    throw new CashfreeApiError(res.status, err.code, err.description);
  }
  const o = (data ?? {}) as Record<string, unknown>;
  return {
    orderId: typeof o.order_id === 'string' ? o.order_id : orderId,
    cfOrderId: o.cf_order_id != null ? String(o.cf_order_id) : null,
    status: String(o.order_status ?? ''),
    amountMinor: typeof o.order_amount === 'number' ? majorToMinor(o.order_amount) : 0,
    currency: String(o.order_currency ?? 'INR'),
  };
}
