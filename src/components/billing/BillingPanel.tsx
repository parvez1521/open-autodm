"use client";

/**
 * Billing panel — the customer-facing subscription UI (2026-11-08).
 *
 * Rendered by src/app/(saas)/billing/page.tsx when BILLING_ENABLED is
 * on (the page keeps its inert state while the flag is off). All state
 * comes from GET /api/billing/status (the billing read model); actions
 * go to POST /api/billing/trial (15-day no-card trial) and
 * POST /api/billing/checkout (provider order → provider checkout).
 *
 * Provider (owner decision 2026-11-08 ~20:34 IST): Cashfree is the
 * primary gateway, Razorpay the fallback — the status payload names
 * the active one (`paymentProvider`) and the checkout response names
 * the one it used; this panel branches on that, never on its own
 * guess. Cashfree checkout runs on the payment_session_id via the
 * Cashfree JS SDK. Cashfree also REQUIRES a customer phone:
 * profiles/sessions carry no phone, so when Cashfree is active the
 * panel collects a 10-digit mobile number inline before checkout
 * (and the checkout route refuses without one).
 *
 * Activation is NEVER claimed client-side: after the provider
 * checkout completes, this panel only says the payment was submitted
 * and polls the status endpoint — the plan changes when the signed
 * webhook has confirmed the payment server-side, and the panel shows
 * exactly what the server then reports.
 *
 * Workspace selection: the status route resolves the caller's single
 * workspace server-side; only when the server asks for an explicit
 * selection (400 workspace-context-required) does this panel list the
 * caller's workspaces (GET /api/workspaces) and let them pick — the
 * chosen id is sent as the x-workspace-id SELECTOR and re-validated
 * by the server on every request.
 *
 * Display rules (owner instruction, 2026-11-08 ~19:38 IST): prices
 * render MONTHLY only — the monthly/annual toggle is gone — in the
 * visitor's ONE geo currency (lib/billing/geo: India → INR, else
 * USD), which is also the currency checkout is opened in. Free
 * shows Creator Studio (limited); paid plans show it in full.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { staggerChild, staggerParent } from "@/lib/motion/presets";
import {
  PLANS,
  TRIAL_DAYS,
  isSelfServePaidPlan,
  type Plan,
} from "@/lib/billing/catalogue";
import { formatPriceMinor } from "@/lib/billing/geo";
import { useDisplayCurrency } from "@/lib/billing/useDisplayCurrency";

const CONTACT_HREF = "mailto:work.techhacksai@gmail.com";
const RAZORPAY_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";
const CASHFREE_SCRIPT = "https://sdk.cashfree.com/js/v3/cashfree.js";

interface StatusPayload {
  ok: boolean;
  workspaceId: string;
  role: string;
  canManageBilling: boolean;
  billingEnabled: boolean;
  paymentsLiveMode: boolean;
  /** Active gateway for checkout: 'cashfree' (primary) | 'razorpay' | null. */
  paymentProvider?: string | null;
  entitlementsEnforced: boolean;
  subscription: {
    planId: string;
    status: string;
    billingPeriod: string | null;
    currency: string;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
  } | null;
  trial: { active: boolean; lapsed: boolean; endsAt: string | null; daysRemaining: number };
  entitlement: {
    planId: string;
    planName: string;
    resolution: string;
    limits: { instagramAccounts: number; activeAutomations: number; dmsPerMonth: number | null; teamSeats: number };
  };
  recentOrders: { id: string; planId: string; status: string; amountMinor: number; currency: string; createdAt: string }[];
}

interface WorkspaceOption {
  id: string;
  name: string | null;
  role: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, cb: (resp: { error?: { description?: string } }) => void) => void;
}

interface CashfreeInstance {
  checkout: (options: {
    paymentSessionId: string;
    redirectTarget: string;
  }) => Promise<{ error?: { message?: string }; paymentDetails?: unknown } | undefined>;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
    Cashfree?: (options: { mode: string }) => CashfreeInstance;
  }
}

let razorpayScriptPromise: Promise<boolean> | null = null;
function loadRazorpay(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = RAZORPAY_SCRIPT;
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }
  return razorpayScriptPromise;
}

let cashfreeScriptPromise: Promise<boolean> | null = null;
function loadCashfree(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Cashfree) return Promise.resolve(true);
  if (!cashfreeScriptPromise) {
    cashfreeScriptPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = CASHFREE_SCRIPT;
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }
  return cashfreeScriptPromise;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function BillingPanel() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // Monthly only (owner instruction, 2026-11-08 ~19:38 IST): no
  // period state, no toggle — trials and checkout are monthly.
  const currency = useDisplayCurrency();
  // Cashfree requires a customer phone for checkout; profiles carry
  // none, so the panel collects it inline (validated 10-digit) when
  // Cashfree is the active provider — or if the checkout route asks.
  const [phone, setPhone] = useState("");
  const [needsPhone, setNeedsPhone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const fetchStatus = useCallback(async (wsId: string | null): Promise<StatusPayload | "needs-workspace" | null> => {
    try {
      const res = await fetch("/api/billing/status", {
        headers: wsId ? { "x-workspace-id": wsId } : {},
      });
      const data = (await res.json().catch(() => null)) as (StatusPayload & { code?: string }) | null;
      if (res.status === 400 && data?.code === "workspace-context-required") return "needs-workspace";
      if (!res.ok || !data?.ok) {
        setError(data && "message" in data ? String((data as { message?: string }).message ?? "Could not load billing.") : "Could not load billing.");
        return null;
      }
      return data;
    } catch {
      setError("Could not load billing. Check your connection and reload.");
      return null;
    }
  }, []);

  const load = useCallback(async (wsId: string | null) => {
    setLoading(true);
    const result = await fetchStatus(wsId);
    if (result === "needs-workspace") {
      try {
        const res = await fetch("/api/workspaces");
        const data = (await res.json().catch(() => null)) as { workspaces?: WorkspaceOption[] } | null;
        const list = data?.workspaces ?? [];
        setWorkspaces(list);
        if (list.length > 0) {
          setWorkspaceId(list[0]!.id);
          const withFirst = await fetchStatus(list[0]!.id);
          if (withFirst && withFirst !== "needs-workspace") setStatus(withFirst);
        } else {
          setError("No workspace was found for this account.");
        }
      } catch {
        setError("Could not list your workspaces.");
      }
    } else if (result) {
      setStatus(result);
      setWorkspaceId(result.workspaceId);
    }
    setLoading(false);
  }, [fetchStatus]);

  useEffect(() => {
    void load(null);
    const timers = pollTimers.current;
    return () => timers.forEach(clearTimeout);
  }, [load]);

  const pickWorkspace = (id: string) => {
    setWorkspaceId(id);
    setNotice(null);
    void load(id);
  };

  const pollStatusSoon = useCallback(() => {
    for (const delay of [2500, 6000, 11000]) {
      pollTimers.current.push(setTimeout(() => { void load(workspaceId); }, delay));
    }
  }, [load, workspaceId]);

  async function startTrial(plan: Plan) {
    if (!status?.canManageBilling) return;
    setBusyPlan(plan.id);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/billing/trial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, period: "monthly", workspaceId: workspaceId ?? undefined }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.message ?? "Could not start the trial.");
      } else {
        setNotice(`Your ${TRIAL_DAYS}-day free trial of ${plan.name} is running. No card was taken — if you do nothing, the workspace returns to Free when the trial ends.`);
        await load(workspaceId);
      }
    } catch {
      setError("Could not start the trial. Check your connection and try again.");
    }
    setBusyPlan(null);
  }

  async function subscribe(plan: Plan) {
    if (!status?.canManageBilling) return;
    const cashfreeFlow = status.paymentProvider === "cashfree" || needsPhone;
    const customerPhone = phone.replace(/[\s-]/g, "");
    if (cashfreeFlow && !/^\d{10}$/.test(customerPhone)) {
      setNeedsPhone(true);
      setError("Enter your 10-digit mobile number — the payment window needs it to open.");
      return;
    }
    setBusyPlan(plan.id);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          currency,
          period: "monthly",
          workspaceId: workspaceId ?? undefined,
          ...(cashfreeFlow ? { customerPhone } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean; code?: string; message?: string; keyId?: string;
        provider?: string; paymentSessionId?: string; mode?: string;
        order?: { id: string; amount: number; currency: string };
      } | null;
      if (!res.ok || !data?.ok || !data.order) {
        if (data?.code === "INVALID_CUSTOMER_PHONE") setNeedsPhone(true);
        setError(
          data?.code === "PAYMENTS_NOT_CONFIGURED" || data?.code === "BILLING_DISABLED"
            ? "Payments are being switched on for this deployment — nothing was charged. You can start the free trial meanwhile."
            : data?.message ?? "Checkout could not be started. Nothing was charged.",
        );
        setBusyPlan(null);
        return;
      }
      if (data.provider === "cashfree") {
        if (!data.paymentSessionId) {
          setError("The payment window could not be started. Nothing was charged; please try again.");
          setBusyPlan(null);
          return;
        }
        const loaded = await loadCashfree();
        if (!loaded || !window.Cashfree) {
          setError("The payment window could not be loaded. Nothing was charged; please try again.");
          setBusyPlan(null);
          return;
        }
        const cashfree = window.Cashfree({ mode: data.mode ?? "sandbox" });
        const result = await cashfree.checkout({
          paymentSessionId: data.paymentSessionId,
          redirectTarget: "_modal",
        });
        if (result?.error) {
          setError(result.error.message ?? "The payment did not go through. Nothing was charged.");
        } else {
          // The SDK returning without an error is NOT activation —
          // the signed webhook confirms server-side; poll for it.
          setNotice("Payment submitted. Your plan activates as soon as the payment is confirmed — usually a few seconds. This panel refreshes itself.");
          pollStatusSoon();
        }
        setBusyPlan(null);
        return;
      }
      if (!data.keyId) {
        setError("Checkout could not be started. Nothing was charged.");
        setBusyPlan(null);
        return;
      }
      const loaded = await loadRazorpay();
      if (!loaded || !window.Razorpay) {
        setError("The payment window could not be loaded. Nothing was charged; please try again.");
        setBusyPlan(null);
        return;
      }
      const checkout = new window.Razorpay({
        key: data.keyId,
        order_id: data.order.id,
        amount: data.order.amount,
        currency: data.order.currency,
        name: "Open AutoDM",
        description: `${plan.name} plan — monthly`,
        handler: () => {
          setNotice("Payment submitted. Your plan activates as soon as the payment is confirmed — usually a few seconds. This panel refreshes itself.");
          pollStatusSoon();
        },
      });
      checkout.on("payment.failed", (resp) => {
        setError(resp.error?.description ?? "The payment did not go through. Nothing was charged.");
      });
      checkout.open();
    } catch {
      setError("Checkout could not be started. Nothing was charged.");
    }
    setBusyPlan(null);
  }

  if (loading && !status) {
    return (
      <div className="border border-border p-6" data-testid="billing-loading">
        <p className="text-sm text-muted-foreground">Loading billing…</p>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="border border-border p-6" data-testid="billing-error">
        <h1 className="font-heading text-xl font-semibold">Billing</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error ?? "Billing could not be loaded."}</p>
      </div>
    );
  }

  const sub = status.subscription;
  const currentPlanId = status.entitlement.planId;
  const paidActive = sub?.status === "active";
  const trialing = status.trial.active;

  return (
    <div className="space-y-6" data-testid="billing-panel">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Plan, trial and payment for this workspace — changes apply to the whole workspace.
        </p>
      </div>

      {workspaces && workspaces.length > 1 && (
        <div className="flex items-center gap-3">
          <label htmlFor="billing-workspace" className="text-sm font-medium">Workspace</label>
          <select
            id="billing-workspace"
            value={workspaceId ?? ""}
            onChange={(e) => pickWorkspace(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name ?? w.id}</option>
            ))}
          </select>
        </div>
      )}

      <div className="border border-border p-6" data-testid="billing-current">
        <p className="micro-label">Current plan</p>
        <p className="mt-2 font-heading text-2xl font-semibold">{status.entitlement.planName}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {paidActive && `Active subscription${sub?.billingPeriod ? ` — ${sub.billingPeriod} billing` : ""}. Current period ends ${formatDate(sub?.currentPeriodEnd ?? null)}.`}
          {trialing && `Free trial — ${status.trial.daysRemaining} day(s) left, ends ${formatDate(status.trial.endsAt)}. No card on file; nothing will be charged when it ends.`}
          {!paidActive && !trialing && (status.trial.lapsed
            ? "Your free trial has ended, so the workspace is on Free limits. Subscribe below to restore the paid plan — nothing was charged."
            : "This workspace is on Free limits. Start a free trial or subscribe below — access upgrades itself as soon as a trial starts or a payment is confirmed.")}
        </p>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Included now: {status.entitlement.limits.instagramAccounts} Instagram account(s) ·{" "}
          {status.entitlement.limits.activeAutomations} active automations ·{" "}
          {status.entitlement.limits.dmsPerMonth === null ? "Unlimited" : status.entitlement.limits.dmsPerMonth.toLocaleString("en-IN")} DMs / month ·{" "}
          {status.entitlement.limits.teamSeats} team seat(s) ·{" "}
          {status.entitlement.planId === "free" ? "Creator Studio (limited)" : "Creator Studio included"}
        </p>
        {!status.entitlementsEnforced && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Entitlement limits are shown for transparency; enforcement is being rolled out.
          </p>
        )}
      </div>

      {!status.canManageBilling && (
        <p className="text-sm text-muted-foreground">
          You are a {status.role} in this workspace — only the workspace owner can start a trial or check out.
        </p>
      )}
      {notice && (
        <div className="border border-border p-4" role="status">
          <p className="text-sm">{notice}</p>
        </div>
      )}
      {error && (
        <div className="border border-border p-4" role="alert">
          <p className="text-sm">{error}</p>
        </div>
      )}

      {(status.paymentProvider === "cashfree" || needsPhone) && status.canManageBilling && (
        <div className="border border-border p-4" data-testid="billing-phone">
          <label htmlFor="billing-phone-input" className="text-sm font-medium">
            Mobile number for payment
          </label>
          <input
            id="billing-phone-input"
            data-testid="billing-phone-input"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="10-digit mobile number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-2 block h-9 w-full max-w-xs rounded-lg border border-border bg-background px-3 text-sm"
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            The payment window needs a mobile number to open. It is sent only with your checkout — it is not saved to your profile.
          </p>
        </div>
      )}

      <motion.div className="space-y-5" variants={staggerParent} initial="hidden" animate="show">
        {PLANS.map((plan) => {
          const figure = plan.prices[currency].monthlyMinor;
          const isCurrent = plan.id === currentPlanId && (paidActive || trialing || plan.id === "free");
          return (
            <motion.div layout variants={staggerChild} key={plan.id} className="border border-border p-6" data-testid={`billing-plan-${plan.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-heading text-base font-semibold">{plan.name}</h2>
                  <p className="mt-2 font-heading text-2xl font-semibold">
                    {plan.customPricing ? "Custom pricing" : (
                      <>
                        {formatPriceMinor(figure, currency)}<span className="text-sm font-normal text-muted-foreground"> / mo</span>
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {plan.limits.instagramAccounts} Instagram account(s) ·{" "}
                    {plan.limits.dmsPerMonth === null ? "Unlimited" : plan.limits.dmsPerMonth.toLocaleString("en-IN")} auto DMs / month ·{" "}
                    {plan.id === "free" ? "Creator Studio (limited)" : "Creator Studio included"}
                    {isSelfServePaidPlan(plan) ? ` · ${TRIAL_DAYS}-day free trial, no card needed` : ""}
                  </p>
                </div>
                <div className="flex flex-col items-stretch gap-2">
                  {plan.customPricing ? (
                    <a href={CONTACT_HREF} className="inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background">
                      Contact us
                    </a>
                  ) : isCurrent ? (
                    <span className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm font-medium text-muted-foreground">
                      Current plan
                    </span>
                  ) : plan.id === "free" ? (
                    <span className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm font-medium text-muted-foreground">
                      Free — no checkout
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={!status.canManageBilling || busyPlan !== null}
                        onClick={() => void subscribe(plan)}
                        className="inline-flex h-9 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-semibold text-background disabled:opacity-50"
                      >
                        {busyPlan === plan.id ? "Working…" : paidActive || trialing ? `Switch to ${plan.name}` : `Subscribe — ${formatPriceMinor(plan.prices[currency].monthlyMinor, currency)} / mo`}
                      </button>
                      {!paidActive && (
                        <button
                          type="button"
                          disabled={!status.canManageBilling || busyPlan !== null}
                          onClick={() => void startTrial(plan)}
                          className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-foreground disabled:opacity-50"
                        >
                          Start {TRIAL_DAYS}-day free trial
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </motion.div>

      {status.recentOrders.length > 0 && (
        <div>
          <p className="micro-label">Recent orders</p>
          <ul className="mt-2 space-y-1 text-[13px] text-muted-foreground">
            {status.recentOrders.map((o) => (
              <li key={o.id}>
                {formatDate(o.createdAt)} — {PLANS.find((p) => p.id === o.planId)?.name ?? o.planId} —{" "}
                {formatPriceMinor(o.amountMinor, o.currency === "USD" ? "USD" : "INR")} — {o.status}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
