'use client';

import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
} from '@/lib/tenancy/clientRequest';
import type { ActivityItem } from '@/app/api/activity/route';

export type { ActivityItem };

export function useActivity(accountId?: string | null, limit = 20) {
  // Workspace-scope fix (2026-11-22, audit #12): GET /api/activity
  // is a workspace-aware route — in workspace mode routeContext
  // requires the x-workspace-id selector and fails closed with
  // 'workspace-context-required'. This hook was the last read still
  // issuing a plain unscoped apiClient call, so with a workspace
  // selected the dashboard's Recent Activity feed deterministically
  // 400d and fell through to the "No recent events" empty state
  // while the same page reported 99 DMs and 80 comments. It now
  // follows the exact sibling discipline (useContacts /
  // useAnalytics / useBillingStatus):
  //
  //  - Transport: the read rides sendWorkspaceRequest — flag OFF
  //    reproduces the exact legacy unscoped call; flag ON +
  //    selection attaches the selector, and the cache key names the
  //    workspace so switching workspaces can never render the
  //    previous workspace's cached feed.
  //  - Readiness gate: while the WorkspaceProvider scope is
  //    'unavailable' (selection still resolving) the query does not
  //    fire, so React Query's retry is not burned on a scope that
  //    cannot succeed yet. Callers key their loading branch off
  //    isPending, not isLoading, for the same reason.
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  const requestScope = workspaceRequestScopeFromSelection({
    workspaceRuntimeEnabled,
    selectedWorkspaceId,
  });
  return useQuery({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['activity', accountId ?? 'all', limit, requestScope.workspaceId]
        : ['activity', accountId ?? 'all', limit],
    queryFn: () =>
      sendWorkspaceRequest<{ activities: ActivityItem[] }>(
        requestScope,
        `/activity?limit=${limit}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`
      ).then((r) => r.activities),
    enabled: requestScope.kind !== 'unavailable',
    refetchInterval: 15_000,
  });
}
