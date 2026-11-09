'use client';

import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
} from '@/lib/tenancy/clientRequest';

export interface AnalyticsTotals {
  triggers: number;
  comments: number;
  dmKeywords: number;
  storyReplies: number;
  delivered: number;
  failed: number;
  flowsStarted: number;
  flowsCompleted: number;
  askToFollowShown: number;
  followsGained: number;
  newContacts: number;
  newContactFollowers: number;
}

export interface AnalyticsDaily {
  date: string;
  comments: number;
  dms: number;
  stories: number;
  delivered: number;
  contacts: number;
}

export interface AnalyticsPerAutomation {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  triggers: number;
  delivered: number;
  failed: number;
  flowsCompleted: number;
  follows: number;
}

export interface AnalyticsPayload {
  range: { from: string; to: string };
  totals: AnalyticsTotals;
  daily: AnalyticsDaily[];
  perAutomation: AnalyticsPerAutomation[];
  automations: { id: string; name: string; type: string }[];
  truncated: boolean;
}

export function useAnalytics(params: { from: string; to: string; automationId: string; accountId?: string | null }) {
  // Workspace-scope fix (2026-11-09): GET /api/analytics is a
  // workspace-aware route — in workspace mode routeContext requires
  // the x-workspace-id selector and fails closed with
  // 'workspace-context-required' ("A workspace context is required:
  // no workspace was specified."). This hook was the last read still
  // issuing a plain unscoped apiClient call, so with a workspace
  // selected in the sidebar /analytics deterministically settled on
  // that error while every sibling read loaded. It now follows the
  // exact sibling discipline (useContacts / useBillingStatus):
  //
  //  - Transport: the read rides sendWorkspaceRequest — flag OFF
  //    reproduces the exact legacy unscoped call; flag ON +
  //    selection attaches the selector, and the cache key names the
  //    workspace so switching workspaces can never render the
  //    previous workspace's cached numbers.
  //  - Readiness gate: while the WorkspaceProvider scope is
  //    'unavailable' (selection still resolving, or no workspace at
  //    all) the query does not fire, so React Query's retry is not
  //    burned on a scope that cannot succeed yet. The page renders
  //    the no-workspace state distinctly for the loaded-but-empty
  //    case; this gate is what keeps the two states apart.
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  const requestScope = workspaceRequestScopeFromSelection({
    workspaceRuntimeEnabled,
    selectedWorkspaceId,
  });
  const search = new URLSearchParams({
    from: params.from,
    to: params.to,
    automationId: params.automationId,
  });
  if (params.accountId) search.set('accountId', params.accountId);
  return useQuery({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['analytics', params.from, params.to, params.automationId, params.accountId ?? 'all', requestScope.workspaceId]
        : ['analytics', params.from, params.to, params.automationId, params.accountId ?? 'all'],
    queryFn: () => sendWorkspaceRequest<AnalyticsPayload>(requestScope, `/analytics?${search.toString()}`),
    enabled: requestScope.kind !== 'unavailable',
    staleTime: 60 * 1000,
  });
}
