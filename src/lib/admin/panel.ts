/**
 * Owner admin panel (/admin) — gate + data (2026-11-09).
 *
 * This module backs the ONE real admin surface: the owner's
 * subscriber list at /admin. It replaces nothing in the Phase 14
 * prototype (src/lib/admin/service.ts et al. stay synthetic and
 * stub-gated); it reads the REAL billing tables.
 *
 * ── Gate ─────────────────────────────────────────────────────────
 * The allowlist is the ADMIN_EMAILS env var: comma-separated email
 * addresses, compared case-insensitively after trimming. Semantics
 * are fail-closed in every direction:
 *   - ADMIN_EMAILS unset / empty / whitespace-only → NOBODY is an
 *     admin (the panel 404s for everyone, including the owner,
 *     until the owner configures it).
 *   - A null/empty session email is never an admin.
 *   - No email is hardcoded here or anywhere in the panel — the
 *     env var is the only source (pinned by tests/admin-panel).
 * The check itself is only half the gate: the /admin page resolves
 * the session SERVER-SIDE (verified getUser, never client state)
 * and calls notFound() for anyone who fails, so the panel's
 * existence is not revealed. This module is server-only code: it
 * must never be imported from a client component, and the env list
 * must never be serialized to the browser.
 *
 * ── Data ─────────────────────────────────────────────────────────
 * Reads run on the service-role client the PAGE constructs after
 * the gate passes (this module never builds a client itself). The
 * reads are platform-level by design — every workspace's billing
 * state — which is exactly why they sit behind the gate above.
 * Sources: subscriptions (…000027, one row per workspace),
 * billing_orders (…000035), workspaces + workspace_memberships
 * (…000024 — owner membership, falling back to the workspace's
 * created_by), and the Auth user list the page resolves (emails
 * live in auth.users, not in any public table).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PLANS, type CurrencyCode } from '../billing/catalogue';

// ── Gate ────────────────────────────────────────────────────────────

/** Parse ADMIN_EMAILS into a normalized (trimmed, lowercased) set. */
export function parseAdminEmails(
  env: Record<string, string | undefined>,
): ReadonlySet<string> {
  const out = new Set<string>();
  const raw = env.ADMIN_EMAILS;
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const value = part.trim().toLowerCase();
    if (value) out.add(value);
  }
  return out;
}

/**
 * True only when `email` is a non-empty address listed in
 * ADMIN_EMAILS. Deny-by-default: an unset/empty allowlist admits
 * nobody, and a missing session email is never an admin.
 */
export function isAdminEmail(
  email: string | null | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (!email) return false;
  const allow = parseAdminEmails(env);
  if (allow.size === 0) return false;
  return allow.has(email.trim().toLowerCase());
}

// ── Row shapes ──────────────────────────────────────────────────────

/** The slice of an auth.users record the panel needs. */
export interface AdminAuthUser {
  id: string;
  email: string | null;
  createdAt: string | null;
}

export interface AdminSubscriber {
  workspaceId: string;
  workspaceName: string;
  ownerEmail: string | null;
  planId: string;
  planName: string;
  /** Lifecycle status from the subscription row, or 'no-subscription' when the workspace qualified via a paid order alone. */
  status: string;
  billingPeriod: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  provider: string | null;
  currentPeriodEnd: string | null;
  workspaceCreatedAt: string | null;
}

export type AdminOrderStatus = 'paid' | 'pending' | 'failed' | 'expired';

export interface AdminOrder {
  id: string;
  createdAt: string;
  workspaceName: string;
  ownerEmail: string | null;
  planId: string;
  planName: string;
  amountMinor: number;
  currency: CurrencyCode;
  status: AdminOrderStatus;
  provider: string;
}

export interface AdminOverviewSummary {
  /** Workspaces with a subscription or a paid order. */
  totalCustomers: number;
  /** Subscriptions whose lifecycle status is 'active'. */
  activeSubscriptions: number;
  /** Orders with status 'paid' (within the scan bound below). */
  paidOrders: number;
  /**
   * Sum of ACTIVE subscriptions' plan prices as a monthly figure,
   * per currency (annual plans contribute floor(amount / 12)) —
   * mirrors the per-currency discipline of lib/admin/reports.ts:
   * currencies are NEVER summed together. This is plan value, not
   * collected revenue: failed/renewal payments do not change it.
   */
  monthlyPlanValueByCurrency: Partial<Record<CurrencyCode, number>>;
}

export interface AdminOverview {
  subscribers: AdminSubscriber[];
  recentOrders: AdminOrder[];
  summary: AdminOverviewSummary;
}

interface SubscriptionDbRow {
  workspace_id: string;
  plan_id: string;
  lifecycle_status: string;
  provider: string | null;
  billing_period: string | null;
  amount_minor: number;
  currency: string;
  current_period_end: string | null;
}

interface OrderDbRow {
  id: string;
  workspace_id: string;
  provider: string;
  plan_id: string;
  billing_period: string;
  amount_minor: number;
  currency: string;
  status: string;
  created_at: string;
}

interface WorkspaceDbRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

interface MembershipDbRow {
  workspace_id: string;
  user_id: string;
  role: string;
}

const SUBSCRIPTION_COLS =
  'workspace_id, plan_id, lifecycle_status, provider, billing_period, amount_minor, currency, current_period_end';
const ORDER_COLS =
  'id, workspace_id, provider, plan_id, billing_period, amount_minor, currency, status, created_at';

/** How many of the most recent orders the panel scans (table shows the first RECENT_ORDERS_LIMIT of them). */
export const ORDERS_SCAN_LIMIT = 500;
export const RECENT_ORDERS_LIMIT = 50;

function planName(planId: string): string {
  return PLANS.find((p) => p.id === planId)?.name ?? planId;
}

function normCurrency(value: string | null | undefined): CurrencyCode {
  return value === 'USD' ? 'USD' : 'INR';
}

function mapOrderStatus(status: string): AdminOrderStatus {
  if (status === 'paid') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'expired') return 'expired';
  return 'pending'; // 'created' — an order the provider has not settled yet
}

// ── Loader ──────────────────────────────────────────────────────────

/**
 * Assemble the panel's data. A workspace is listed when it HAS a
 * subscription (a subscriptions row that is not the plain free
 * default) OR a paid order. Plan/amount shown come from the
 * subscription row when it is a real (non-free) one; an order-only
 * workspace shows its latest paid order's plan/amount instead —
 * every figure rendered is a real row value, never derived copy.
 */
export async function loadAdminOverview(
  db: SupabaseClient,
  users: readonly AdminAuthUser[],
): Promise<AdminOverview> {
  const userById = new Map(users.map((u) => [u.id, u]));

  const { data: subData, error: subError } = await db
    .from('subscriptions')
    .select(SUBSCRIPTION_COLS);
  if (subError) throw new Error(`Admin panel: failed to read subscriptions: ${subError.message}`);
  const subs = (subData ?? []) as unknown as SubscriptionDbRow[];

  const { data: orderData, error: orderError } = await db
    .from('billing_orders')
    .select(ORDER_COLS)
    .order('created_at', { ascending: false })
    .limit(ORDERS_SCAN_LIMIT);
  if (orderError) throw new Error(`Admin panel: failed to read billing orders: ${orderError.message}`);
  const orders = (orderData ?? []) as unknown as OrderDbRow[];

  const subByWorkspace = new Map<string, SubscriptionDbRow>();
  for (const s of subs) subByWorkspace.set(s.workspace_id, s);

  const paidByWorkspace = new Map<string, OrderDbRow[]>();
  let paidOrders = 0;
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    paidOrders += 1;
    const list = paidByWorkspace.get(o.workspace_id) ?? [];
    list.push(o); // orders arrive newest-first, so [0] is the latest
    paidByWorkspace.set(o.workspace_id, list);
  }

  const isRealSubscription = (s: SubscriptionDbRow): boolean =>
    s.plan_id !== 'free' || s.lifecycle_status !== 'free';

  const qualifying = new Set<string>();
  for (const s of subs) if (isRealSubscription(s)) qualifying.add(s.workspace_id);
  for (const wsId of paidByWorkspace.keys()) qualifying.add(wsId);

  const neededIds = new Set<string>(qualifying);
  for (const o of orders.slice(0, RECENT_ORDERS_LIMIT)) neededIds.add(o.workspace_id);

  const workspaceById = new Map<string, WorkspaceDbRow>();
  const ownerIdByWorkspace = new Map<string, string>();
  if (neededIds.size > 0) {
    const ids = [...neededIds];
    const { data: wsData, error: wsError } = await db
      .from('workspaces')
      .select('id, name, created_by, created_at')
      .in('id', ids);
    if (wsError) throw new Error(`Admin panel: failed to read workspaces: ${wsError.message}`);
    for (const w of (wsData ?? []) as unknown as WorkspaceDbRow[]) workspaceById.set(w.id, w);

    const { data: memData, error: memError } = await db
      .from('workspace_memberships')
      .select('workspace_id, user_id, role')
      .in('workspace_id', ids)
      .eq('role', 'owner');
    if (memError) throw new Error(`Admin panel: failed to read memberships: ${memError.message}`);
    for (const m of (memData ?? []) as unknown as MembershipDbRow[]) {
      ownerIdByWorkspace.set(m.workspace_id, m.user_id);
    }
  }

  const ownerEmailOf = (workspaceId: string): string | null => {
    const ws = workspaceById.get(workspaceId);
    const ownerId = ownerIdByWorkspace.get(workspaceId) ?? ws?.created_by;
    if (!ownerId) return null;
    return userById.get(ownerId)?.email ?? null;
  };

  const subscribers: AdminSubscriber[] = [];
  for (const wsId of qualifying) {
    const ws = workspaceById.get(wsId);
    if (!ws) continue;
    const sub = subByWorkspace.get(wsId);
    const latestPaid = paidByWorkspace.get(wsId)?.[0];
    const fromSub = sub && isRealSubscription(sub) ? sub : null;
    subscribers.push({
      workspaceId: wsId,
      workspaceName: ws.name,
      ownerEmail: ownerEmailOf(wsId),
      planId: fromSub?.plan_id ?? latestPaid?.plan_id ?? sub?.plan_id ?? 'free',
      planName: planName(fromSub?.plan_id ?? latestPaid?.plan_id ?? sub?.plan_id ?? 'free'),
      status: sub ? sub.lifecycle_status : 'no-subscription',
      billingPeriod: fromSub?.billing_period ?? latestPaid?.billing_period ?? null,
      amountMinor: Number(fromSub?.amount_minor ?? latestPaid?.amount_minor ?? 0),
      currency: normCurrency(fromSub?.currency ?? latestPaid?.currency),
      provider: fromSub?.provider ?? latestPaid?.provider ?? null,
      currentPeriodEnd: fromSub?.current_period_end ?? null,
      workspaceCreatedAt: ws.created_at ?? null,
    });
  }
  subscribers.sort((a, b) =>
    String(b.workspaceCreatedAt ?? '').localeCompare(String(a.workspaceCreatedAt ?? '')),
  );

  const recentOrders: AdminOrder[] = orders.slice(0, RECENT_ORDERS_LIMIT).map((o) => ({
    id: o.id,
    createdAt: o.created_at,
    workspaceName: workspaceById.get(o.workspace_id)?.name ?? '—',
    ownerEmail: ownerEmailOf(o.workspace_id),
    planId: o.plan_id,
    planName: planName(o.plan_id),
    amountMinor: Number(o.amount_minor ?? 0),
    currency: normCurrency(o.currency),
    status: mapOrderStatus(o.status),
    provider: o.provider,
  }));

  let activeSubscriptions = 0;
  const monthlyPlanValueByCurrency: Partial<Record<CurrencyCode, number>> = {};
  for (const s of subscribers) {
    if (s.status !== 'active') continue;
    activeSubscriptions += 1;
    const monthly = s.billingPeriod === 'annual' ? Math.floor(s.amountMinor / 12) : s.amountMinor;
    monthlyPlanValueByCurrency[s.currency] =
      (monthlyPlanValueByCurrency[s.currency] ?? 0) + monthly;
  }

  return {
    subscribers,
    recentOrders,
    summary: {
      totalCustomers: subscribers.length,
      activeSubscriptions,
      paidOrders,
      monthlyPlanValueByCurrency,
    },
  };
}
