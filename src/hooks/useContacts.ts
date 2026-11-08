'use client';

import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
} from '@/lib/tenancy/clientRequest';

export interface ContactFromDB {
  id: string;
  instagram_account_id: string;
  audience_ig_user_id: string;
  username: string | null;
  follows_business: boolean | null;
  first_interaction_at: string;
  last_interaction_at: string;
  last_trigger_type: 'comment' | 'dm' | 'story_reply' | 'button' | null;
  total_triggers: number;
  automations: { id: string; name: string } | null;
}

export function useContacts(accountId?: string | null) {
  // The request scope does double duty here, with the same
  // discipline as the sibling list hooks (useAutomations,
  // useInstagramAccounts):
  //
  //  - Transport: GET /api/contacts is a workspace-aware route (in
  //    workspace mode routeContext requires the selector and fails
  //    closed with 'workspace-context-required'), so the read rides
  //    sendWorkspaceRequest — flag OFF reproduces the exact legacy
  //    unscoped call; flag ON + selection attaches the selector and
  //    the cache key names the workspace, so switching workspaces
  //    can never render the previous workspace's cached list.
  //  - Readiness gate (flakiness fix, 2026-11-08, investigation
  //    fix-plan item 3): while the WorkspaceProvider scope is
  //    'unavailable' the query does not fire, so React Query's one
  //    retry is not burned on a scope that is still resolving.
  //
  // Both call sites (dashboard, ContactsList) already render inside
  // WorkspaceProvider.
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  const requestScope = workspaceRequestScopeFromSelection({
    workspaceRuntimeEnabled,
    selectedWorkspaceId,
  });
  return useQuery({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['contacts', accountId ?? 'all', requestScope.workspaceId]
        : ['contacts', accountId ?? 'all'],
    queryFn: () =>
      sendWorkspaceRequest<{ contacts: ContactFromDB[] }>(
        requestScope,
        `/contacts${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`
      ).then((r) => r.contacts),
    enabled: requestScope.kind !== 'unavailable',
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // contacts grow as automations fire - keep fresh
  });
}
