/**
 * GET /api/billing/status — the billing read model for one workspace.
 *
 * Authenticated; the workspace is resolved through
 * src/lib/billing/access.ts (selector or single-membership default).
 * ANY member may read (plan state is workspace-visible); the response
 * carries `canManageBilling` so the UI can enable owner-only actions
 * for the owner and explain them to everyone else.
 *
 * The response joins three existing sources, changing none of them:
 *   - the subscriptions row (lib/billing/persistence.ts),
 *   - the catalogue, via the entitlement service — the resolved plan's
 *     LIMITS (Instagram accounts 1/3/5, automations, DMs, …) flow from
 *     catalogue.ts through resolveEntitlement, so a catalogue change
 *     is reflected here with no code change,
 *   - the billing flags, reported honestly (including
 *     ENTITLEMENTS_ENFORCED, which stays OFF by default: decisions are
 *     computed and displayed, not yet enforced).
 *
 * Trial lapse is applied here: a `trialing` row past its trial_ends_at
 * is lazily persisted as `expired` and reported as lapsed, resolving
 * to Free limitations — no cron needed for correctness of reads.
 *
 * Period lapse is applied here too (Bug 1 fix, 2026-11-09): an
 * `active` row past its current_period_end — possible since payments
 * are one-time orders with no autopay — is reported with the
 * EFFECTIVE status `expired` (payload field `periodLapsed`) and
 * resolves to Free. Unlike trial lapse it is deliberately NOT
 * persisted: the stored row remains the payment record exactly as
 * the webhook flow left it, and a renewal payment (which writes a
 * fresh period end through that same flow) makes the very same row
 * resolve as paid again with no reader-side repair.
 *
 * Deliberately NOT flag-503-gated: the billing page needs this read to
 * render its honest "not enabled yet" state for a signed-in user, so
 * the flags are data in the payload, not a gate. Mutations live in the
 * checkout/trial routes, which ARE flag-gated.
 */

import { createLogger } from "@/lib/logger";
import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { readBillingFlags, readSaasFlags } from "@/lib/billing/flags";
import { resolveActiveBillingProvider } from "@/lib/billing/activeProvider";
import { PLANS } from "@/lib/billing/catalogue";
import { resolveEntitlement } from "@/lib/entitlements/service";
import {
  billingWorkspaceSelector,
  resolveBillingWorkspace,
  workspaceFailureResponse,
} from "@/lib/billing/access";
import {
  getWorkspaceSubscription,
  listBillingOrders,
  upsertWorkspaceSubscription,
  type WorkspaceSubscriptionRow,
} from "@/lib/billing/persistence";
import { hasCapability } from "@/lib/tenancy/routeContext";
import { applyTrialLapse, isTrialLapsed, trialDaysRemaining } from "@/lib/billing/trial";
import { applyPeriodLapse, isPeriodLapsed } from "@/lib/billing/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:billing:status");

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const db = createServiceClient();
  const resolved = await resolveBillingWorkspace(
    db,
    user.id,
    billingWorkspaceSelector(request),
  );
  if (!resolved.ok) return workspaceFailureResponse(resolved);
  const ctx = resolved.ctx;

  try {
    const now = new Date();
    let row: WorkspaceSubscriptionRow | null = await getWorkspaceSubscription(db, ctx.workspaceId);

    // Lazy trial lapse: persist the expiry the moment a read observes
    // it, so the stored state and every later read agree.
    let lapsed = false;
    if (row && isTrialLapsed({ planId: row.planId, status: row.status, trialEndsAt: row.trialEndsAt }, now)) {
      row = await upsertWorkspaceSubscription(db, ctx.workspaceId, { status: "expired" });
      lapsed = true;
    }
    const viewOf = (r: WorkspaceSubscriptionRow) => ({
      planId: r.planId,
      status: r.status,
      trialEndsAt: r.trialEndsAt,
      currentPeriodEnd: r.currentPeriodEnd,
    });
    const trialEffective = applyTrialLapse(row ? viewOf(row) : null, now);
    // Period lapse (Bug 1): resolution-time only — the row is NOT
    // rewritten (see header). The composed view gives the REPORTED
    // status; resolveEntitlement receives the pre-period-lapse view
    // (with its period end) so the SERVICE applies the period check
    // and reports resolution 'free-default-period-ended' — one source
    // of lapse truth.
    const periodLapsed = isPeriodLapsed(trialEffective, now);
    const effective = applyPeriodLapse(trialEffective, now);

    const entitlement = resolveEntitlement(
      trialEffective
        ? {
            workspaceId: ctx.workspaceId,
            planId: trialEffective.planId,
            // The table's 'free' default is not a lifecycle state; the
            // entitlement service reads null as "no granting state".
            status: trialEffective.status === 'free' ? null : trialEffective.status,
            currentPeriodEnd: trialEffective.currentPeriodEnd,
          }
        : null,
      now,
    );
    const orders = await listBillingOrders(db, ctx.workspaceId, 5);
    const billing = readBillingFlags(process.env);
    const saas = readSaasFlags(process.env);
    const trialing = effective?.status === "trialing";

    return Response.json({
      ok: true,
      workspaceId: ctx.workspaceId,
      role: ctx.role,
      canManageBilling: hasCapability(ctx, "manageBilling"),
      billingEnabled: billing.billingEnabled,
      paymentsLiveMode: billing.paymentsLiveMode,
      // Which gateway checkout will use (owner decision 2026-11-08:
      // Cashfree when configured, else Razorpay, else null). The
      // BillingPanel needs this BEFORE checkout: Cashfree requires a
      // customer phone, so the panel collects it only on that flow.
      paymentProvider: resolveActiveBillingProvider(process.env)?.providerId ?? null,
      entitlementsEnforced: saas.entitlementsEnforced,
      subscription: row
        ? {
            planId: row.planId,
            status: effective?.status ?? row.status,
            // Bug 1 (2026-11-09): true when the stored row still says
            // active/trialing but its paid period has ended — the UI
            // shows the plan as lapsed (Free limits + renew CTA).
            periodLapsed,
            provider: row.provider,
            billingPeriod: row.billingPeriod,
            amountMinor: row.amountMinor,
            currency: row.currency,
            currentPeriodStart: row.currentPeriodStart,
            currentPeriodEnd: row.currentPeriodEnd,
            trialEndsAt: row.trialEndsAt,
          }
        : null,
      trial: {
        active: trialing,
        lapsed,
        endsAt: row?.trialEndsAt ?? null,
        daysRemaining: trialing ? trialDaysRemaining(row?.trialEndsAt ?? null, now) : 0,
      },
      entitlement: {
        planId: entitlement.plan.id,
        planName: entitlement.plan.name,
        resolution: entitlement.resolution,
        limits: entitlement.plan.limits,
        dataRetentionDays: entitlement.dataRetentionDays,
        supportLevel: entitlement.supportLevel,
      },
      plans: PLANS.map((p) => ({
        id: p.id,
        name: p.name,
        customPricing: p.customPricing ?? false,
        instagramAccounts: p.limits.instagramAccounts,
        prices: p.prices,
      })),
      recentOrders: orders.map((o) => ({
        id: o.id,
        providerOrderId: o.providerOrderId,
        planId: o.planId,
        billingPeriod: o.billingPeriod,
        amountMinor: o.amountMinor,
        currency: o.currency,
        status: o.status,
        createdAt: o.createdAt,
      })),
    });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "billing status failed",
    );
    return Response.json(
      { ok: false, code: "INTERNAL_ERROR", message: "Could not load billing status." },
      { status: 500 },
    );
  }
}
