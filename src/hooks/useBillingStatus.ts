'use client';

/**
 * Billing status for the signed-in console — the SAME read model
 * /billing renders (GET /api/billing/status: subscription row +
 * trial/period lapse + entitlement resolution, server-side).
 *
 * Dashboard plan-card fix (2026-11-09): the dashboard used to show
 * plan state derived from everything EXCEPT this endpoint (or
 * nothing at all), so it could contradict /billing — Starter on
 * /billing, "Free" on the dashboard, and no card at all on a second
 * workspace. The dashboard now reads this hook for the ACTIVE
 * workspace (the WorkspaceProvider selection, sent as the
 * x-workspace-id selector through the shared workspace request
 * scope — the server re-validates membership on every call) and
 * always renders the card from whatever it resolves.
 */

import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';

export interface BillingStatusSummary {
  workspaceId: string;
  subscription: {
    planId: string;
    status: string;
    periodLapsed?: boolean;
    currentPeriodEnd: string | null;
  } | null;
  // `endsAt` added 2026-11-09 (persona-QA fix 7a): the status route
  // already returns the trial's end date; the dashboard plan card
  // needs it to show WHEN a trial ends, not just days remaining.
  trial: { active: boolean; lapsed: boolean; daysRemaining: number; endsAt: string | null };
  entitlement: { planId: string; planName: string };
}

function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

export function useBillingStatus() {
  const requestScope = useWorkspaceRequestScope();
  return useQuery({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['billing-status', requestScope.workspaceId]
        : ['billing-status'],
    queryFn: () => sendWorkspaceRequest<BillingStatusSummary>(requestScope, '/billing/status'),
    // Same scope gate as the other workspace reads: never fire
    // before the provider's selection resolves.
    enabled: requestScope.kind !== 'unavailable',
    staleTime: 60 * 1000,
  });
}
