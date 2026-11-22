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
 * Fresh post thumbnails at render time (2026-11-22).
 *
 * The stored `post_thumbnail_url` snapshot expires within days
 * (Instagram/Facebook CDN signatures), so the list and the editor
 * resolve a fresh URL per post through the thumbnails endpoints and
 * fall back to the stored snapshot, then to a clean placeholder.
 * Fail-open by design: if the refresh fails, the caller still shows
 * the stored URL (which may still work) and PostThumb's onError
 * fallback covers a dead one.
 *
 * React Query caches the result for 10 minutes, so opening the list
 * and then an editor does not re-hit Meta for the same posts.
 */

import {
  groupThumbnailRequests,
  type ThumbnailRequestItem,
  type ThumbnailRequestGroup,
} from '@/lib/automation/thumbnailRequests';

export type { ThumbnailRequestItem, ThumbnailRequestGroup };
export { groupThumbnailRequests };

function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

export function usePostThumbnails(items: ThumbnailRequestItem[]) {
  const requestScope = useWorkspaceRequestScope();
  const groups = useMemo(() => groupThumbnailRequests(items), [items]);
  // String signature keeps the query key stable even though `items`
  // is usually a fresh array each render.
  const signature = groups
    .map((g) => `${g.channel}:${g.accountId}:${g.postIds.join(',')}`)
    .join('|');

  const query = useQuery<Record<string, string | null>, Error>({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['post-thumbnails', requestScope.workspaceId, signature]
        : ['post-thumbnails', signature],
    queryFn: async () => {
      const merged: Record<string, string | null> = {};
      await Promise.all(
        groups.map(async (group) => {
          const ids = encodeURIComponent(group.postIds.join(','));
          const path =
            group.channel === 'facebook'
              ? `/facebook/posts/${group.accountId}/thumbnails?ids=${ids}`
              : `/instagram/posts/${group.accountId}/thumbnails?ids=${ids}`;
          const res = await sendWorkspaceRequest<{ thumbnails: Record<string, string | null> }>(
            requestScope,
            path,
          );
          Object.assign(merged, res.thumbnails ?? {});
        }),
      );
      return merged;
    },
    enabled: groups.length > 0 && requestScope.kind !== 'unavailable',
    staleTime: 10 * 60 * 1000,
  });

  return { thumbnails: query.data ?? {}, isLoading: query.isLoading };
}
