'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';

/**
 * Programme 27: the automation builder's account picker reads through
 * this hook, and GET /instagram/accounts is a workspace-aware route —
 * in workspace mode it requires the `x-workspace-id` selector. The
 * scope mirrors the automations hooks' discipline (see
 * lib/tenancy/clientRequest.ts): flag OFF ⇒ the exact legacy call;
 * flag ON + selection ⇒ selector attached and the cache key names the
 * workspace; flag ON + no selection ⇒ fail closed before any request.
 *
 * Programme 28 (closing P27 finding B-7): the account-admin mutations
 * below (refresh / resubscribe / subscription-status) are now wired
 * through the request scope with the same discipline as the read —
 * they call workspace-aware routes from the settings surface, so they
 * need the selector in workspace mode too. Flag OFF ⇒ byte-identical
 * legacy call shapes (refresh/resubscribe pass `{ method: 'POST' }`;
 * subscription-status passes no options); flag ON + selection ⇒
 * selector attached; flag ON + no selection ⇒ typed fail-closed
 * before any request.
 */
function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

export type TokenStatus = 'ok' | 'expiring' | 'expired';

export interface InstagramAccount {
  id: string;
  instagram_user_id: string;
  username: string;
  name: string | null;
  profile_picture_url: string | null;
  is_active: boolean;
  token_expires_at: string | null;
  token_status: TokenStatus;
  token_days_remaining: number | null;
  is_paused: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  created_at: string;
}

export function useInstagramAccounts() {
  const requestScope = useWorkspaceRequestScope();
  return useQuery({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['instagram-accounts', requestScope.workspaceId]
        : ['instagram-accounts'],
    queryFn: () => sendWorkspaceRequest<{ accounts: InstagramAccount[] }>(requestScope, '/instagram/accounts').then((r) => r.accounts),
    // Flakiness fix (2026-11-08, investigation fix-plan item 3):
    // same scope gate as useAutomations — never fire (and burn the
    // retry) before the WorkspaceProvider scope resolves.
    enabled: requestScope.kind !== 'unavailable',
    staleTime: 60 * 1000, // 1 minute - refetch frequently to catch revoked access
    refetchOnWindowFocus: true,
  });
}

export function useRefreshInstagramToken() {
  const queryClient = useQueryClient();
  const requestScope = useWorkspaceRequestScope();
  return useMutation({
    mutationFn: (accountId: string) =>
      sendWorkspaceRequest<{ success: boolean; token_expires_at: string; token_days_remaining: number }>(
        requestScope,
        `/instagram/refresh/${accountId}`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['instagram-accounts'] });
    },
  });
}

export function useResubscribeWebhook() {
  const requestScope = useWorkspaceRequestScope();
  return useMutation({
    mutationFn: (accountId: string) =>
      sendWorkspaceRequest<{ success: boolean; subscribedFields: string; meta: string }>(
        requestScope,
        `/instagram/resubscribe/${accountId}`,
        { method: 'POST' },
      ),
  });
}

export function useCheckSubscription() {
  const requestScope = useWorkspaceRequestScope();
  return useMutation({
    mutationFn: (accountId: string) =>
      sendWorkspaceRequest<{ subscribedFields: string[]; hasComments: boolean; hasMessages: boolean; raw: string }>(
        requestScope,
        `/instagram/subscription-status/${accountId}`,
      ),
  });
}
