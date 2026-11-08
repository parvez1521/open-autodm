'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import {
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';

/**
 * Programme 27: the builder's post picker (SelectPostStep) reads
 * through this hook, and GET /instagram/posts/[accountId] is a
 * workspace-aware route — in workspace mode it requires the
 * `x-workspace-id` selector. Same scope discipline as the automations
 * hooks (lib/tenancy/clientRequest.ts): flag OFF ⇒ the exact legacy
 * call and cache key; flag ON + selection ⇒ selector attached and the
 * cache key names the workspace; flag ON + no selection ⇒ fail closed
 * before any request.
 */
function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

export interface InstagramPost {
  id: string;
  type: 'reel' | 'image' | 'carousel';
  thumbnail_url: string | null;
  media_url: string | null;
  permalink: string;
  timestamp: string;
  caption: string;
  like_count: number;
  comments_count: number;
}

interface PostsPage {
  posts: InstagramPost[];
  nextCursor: string | null;
  cached: boolean;
}

const PAGE_LIMIT = 20;

export function useInstagramPosts(accountId: string | null | undefined) {
  const requestScope = useWorkspaceRequestScope();
  return useInfiniteQuery<PostsPage, Error>({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['instagram-posts', accountId, requestScope.workspaceId]
        : ['instagram-posts', accountId],
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as string | undefined;
      const url = `/instagram/posts/${accountId}?limit=${PAGE_LIMIT}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      return sendWorkspaceRequest<PostsPage>(requestScope, url);
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Flakiness fix (2026-11-08): the pre-existing account gate,
    // plus the same scope gate as the other workspace-scoped reads —
    // no firing before the WorkspaceProvider scope resolves.
    enabled: !!accountId && requestScope.kind !== 'unavailable',
    staleTime: 5 * 60 * 1000,
  });
}
