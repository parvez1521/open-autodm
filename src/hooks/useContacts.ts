'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { workspaceRequestScopeFromSelection } from '@/lib/tenancy/clientRequest';

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
  // Flakiness fix (2026-11-08, investigation fix-plan item 3): the
  // scope is resolved here ONLY as a readiness gate — this hook's
  // transport (plain apiClient, no selector) is unchanged. While
  // the WorkspaceProvider scope is 'unavailable' the query does not
  // fire, so React Query's one retry is not burned on a scope that
  // is still resolving. Both call sites (dashboard, ContactsList)
  // already render inside WorkspaceProvider.
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  const requestScope = workspaceRequestScopeFromSelection({
    workspaceRuntimeEnabled,
    selectedWorkspaceId,
  });
  return useQuery({
    queryKey: ['contacts', accountId ?? 'all'],
    queryFn: () =>
      apiClient<{ contacts: ContactFromDB[] }>(
        `/contacts${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`
      ).then((r) => r.contacts),
    enabled: requestScope.kind !== 'unavailable',
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // contacts grow as automations fire - keep fresh
  });
}
