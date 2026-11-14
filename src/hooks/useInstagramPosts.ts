'use client';

import { useState } from 'react';
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
  // Refresh nonce: bumping it starts a fresh query whose fetches carry
  // `refresh=1`, so the server skips its 5-minute in-memory cache read
  // and goes back to Meta (live: the picker showed the same 2 posts
  // even after a hard refresh, because the server cache outlived it).
  // The nonce sits in the query key so a refresh restarts pagination
  // from page 1 with fresh data; the picker's local filter/search
  // state is untouched, so they re-apply to the fresh pages.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const query = useInfiniteQuery<PostsPage, Error>({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['instagram-posts', accountId, requestScope.workspaceId, refreshNonce]
        : ['instagram-posts', accountId, refreshNonce],
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as string | undefined;
      const url = `/instagram/posts/${accountId}?limit=${PAGE_LIMIT}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}${refreshNonce > 0 ? '&refresh=1' : ''}`;
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
  return {
    ...query,
    refresh: () => setRefreshNonce((n) => n + 1),
  };
}

/**
 * Resolve one post from a pasted Instagram link
 * (POST /instagram/posts/:accountId/resolve). Same workspace-scope
 * discipline as useInstagramPosts: the scope is snapshotted from the
 * provider state of a single render and carried through the call.
 *
 * Why (2026-11-15): `/{ig-user-id}/media` only ever returns posts
 * where the connected account is the collaboration OWNER, so a collab
 * reel owned by the other account never appears in the picker grid —
 * pasting its link is the only way to select it.
 */
export function useResolveInstagramPost() {
  const requestScope = useWorkspaceRequestScope();
  return async (accountId: string, url: string): Promise<InstagramPost> => {
    const result = await sendWorkspaceRequest<{ post: InstagramPost }>(
      requestScope,
      `/instagram/posts/${accountId}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      },
    );
    return result.post;
  };
}
