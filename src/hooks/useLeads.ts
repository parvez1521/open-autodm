'use client';

import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
} from '@/lib/tenancy/clientRequest';

export interface LeadFromDB {
  id: string;
  automationId: string;
  automationName: string;
  instagramAccountId: string;
  audienceIgUserId: string;
  username: string | null;
  field: 'email' | 'phone';
  value: string;
  submittedAt: string;
}

export function useLeads(automationId?: string | null, enabled = true) {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  const requestScope = workspaceRequestScopeFromSelection({
    workspaceRuntimeEnabled,
    selectedWorkspaceId,
  });
  return useQuery({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['leads', automationId ?? 'all', requestScope.workspaceId]
        : ['leads', automationId ?? 'all'],
    queryFn: () =>
      sendWorkspaceRequest<{ leads: LeadFromDB[] }>(
        requestScope,
        `/leads${automationId ? `?automation_id=${encodeURIComponent(automationId)}` : ''}`,
      ).then((r) => r.leads),
    enabled: enabled && requestScope.kind !== 'unavailable',
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // leads arrive as automations fire - keep fresh
  });
}
