'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';

function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

export interface FacebookPage {
  id: string;
  facebook_page_id: string;
  name: string;
  username: string | null;
  profile_picture_url: string | null;
  is_active: boolean;
  token_expires_at: string | null;
  token_status: 'valid';
  token_days_remaining: number | null;
  is_paused: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  created_at: string;
  user_id?: string;
  connected_by_user_id?: string | null;
  workspace_id?: string | null;
}

export function useFacebookPages() {
  const requestScope = useWorkspaceRequestScope();
  return useQuery({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['facebook-pages', requestScope.workspaceId]
        : ['facebook-pages'],
    queryFn: () => sendWorkspaceRequest<{ pages: FacebookPage[] }>(requestScope, '/facebook/accounts').then((r) => r.pages),
    enabled: requestScope.kind !== 'unavailable',
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useResubscribeFacebookPage() {
  const requestScope = useWorkspaceRequestScope();
  return useMutation({
    mutationFn: (pageId: string) =>
      sendWorkspaceRequest<{ success: boolean; subscribedFields: string; meta: string }>(
        requestScope,
        `/facebook/resubscribe/${pageId}`,
        { method: 'POST' },
      ),
  });
}

export function useDisconnectFacebookPage() {
  const queryClient = useQueryClient();
  const requestScope = useWorkspaceRequestScope();
  return useMutation({
    mutationFn: (pageId: string) =>
      sendWorkspaceRequest<{ success: boolean; pausedAutomations: number }>(
        requestScope,
        `/facebook/disconnect/${pageId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['facebook-pages'] });
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}
