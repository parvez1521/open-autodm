'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';

/**
 * Fresh profile pictures at render time (UI polish, 2026-11-25).
 *
 * The stored `profile_picture_url` snapshots on instagram_accounts
 * and facebook_pages expire within days (Meta CDN signatures), so
 * the account switcher showed a real photo for the most recently
 * connected account and bare letter tiles for the older ones. This
 * hook resolves fresh URLs per account through the pictures batch
 * endpoints and falls back to the stored URL (which may still work),
 * then to the glyph tile — fail-open by design.
 *
 * React Query caches the result for 10 minutes, so opening the
 * switcher, the settings page and the sidebar trigger do not re-hit
 * Meta for the same accounts.
 */

export interface ProfilePictureRequestItem {
  channel: 'instagram' | 'facebook';
  accountId: string;
}

function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

export function useProfilePictures(items: ProfilePictureRequestItem[]) {
  const requestScope = useWorkspaceRequestScope();
  // String signature keeps the query key stable even though `items`
  // is usually a fresh array each render.
  const signature = useMemo(
    () =>
      items
        .map((i) => `${i.channel}:${i.accountId}`)
        .sort()
        .join('|'),
    [items],
  );
  const enabled = items.length > 0 && requestScope.kind !== 'unavailable';

  const query = useQuery<Record<string, string | null>, Error>({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['profile-pictures', requestScope.workspaceId, signature]
        : ['profile-pictures', signature],
    queryFn: async () => {
      const merged: Record<string, string | null> = {};
      const igIds = items.filter((i) => i.channel === 'instagram').map((i) => i.accountId);
      const fbIds = items.filter((i) => i.channel === 'facebook').map((i) => i.accountId);
      await Promise.all([
        igIds.length > 0
          ? sendWorkspaceRequest<{ pictures: Record<string, string | null> }>(
              requestScope,
              `/instagram/accounts/pictures?ids=${encodeURIComponent(igIds.join(','))}`,
            ).then((res) => Object.assign(merged, res.pictures ?? {}))
          : Promise.resolve(),
        fbIds.length > 0
          ? sendWorkspaceRequest<{ pictures: Record<string, string | null> }>(
              requestScope,
              `/facebook/pages/pictures?ids=${encodeURIComponent(fbIds.join(','))}`,
            ).then((res) => Object.assign(merged, res.pictures ?? {}))
          : Promise.resolve(),
      ]);
      return merged;
    },
    enabled,
    staleTime: 10 * 60 * 1000,
  });

  return { pictures: query.data ?? {}, isLoading: query.isLoading };
}
