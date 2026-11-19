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
 * Facebook Page post picker (2026-11-19). Mirrors useInstagramPosts.
 *
 * The API returns the Facebook-native post shape; this hook maps it to
 * the picker shape SelectPostStep renders (thumbnail = full_picture,
 * caption = message ?? story ?? ''). Facebook's /posts edge exposes no
 * media type, so every post maps to type 'image' — the picker therefore
 * shows no Reels/Photos filter split for Facebook (the filter buttons
 * are hidden by the step when channel is facebook).
 */

function useWorkspaceRequestScope(): WorkspaceRequestScope {
  const { workspaceRuntimeEnabled, selectedWorkspaceId } = useWorkspace();
  return workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled, selectedWorkspaceId });
}

export interface FacebookPostItem {
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

interface FacebookPostRaw {
  id: string;
  message?: string;
  story?: string;
  created_time?: string;
  full_picture?: string;
  permalink_url?: string;
  like_count?: number;
  comment_count?: number;
}

interface PostsPage {
  posts: FacebookPostItem[];
  nextCursor: string | null;
  cached: boolean;
}

const PAGE_LIMIT = 20;

function mapFacebookPost(raw: FacebookPostRaw): FacebookPostItem {
  return {
    id: raw.id,
    type: 'image',
    thumbnail_url: raw.full_picture ?? null,
    media_url: raw.full_picture ?? null,
    permalink: raw.permalink_url ?? '',
    timestamp: raw.created_time ?? new Date().toISOString(),
    caption: raw.message ?? raw.story ?? '',
    like_count: raw.like_count ?? 0,
    comments_count: raw.comment_count ?? 0,
  };
}

export function useFacebookPosts(pageId: string | null | undefined) {
  const requestScope = useWorkspaceRequestScope();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const query = useInfiniteQuery<PostsPage, Error>({
    queryKey:
      requestScope.kind === 'workspace'
        ? ['facebook-posts', pageId, requestScope.workspaceId, refreshNonce]
        : ['facebook-posts', pageId, refreshNonce],
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam as string | undefined;
      const url = `/facebook/posts/${pageId}?limit=${PAGE_LIMIT}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}${refreshNonce > 0 ? '&refresh=1' : ''}`;
      const raw = await sendWorkspaceRequest<{ posts: FacebookPostRaw[]; nextCursor: string | null; cached: boolean }>(requestScope, url);
      return { posts: (raw.posts ?? []).map(mapFacebookPost), nextCursor: raw.nextCursor, cached: raw.cached };
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!pageId && requestScope.kind !== 'unavailable',
    staleTime: 5 * 60 * 1000,
  });
  return {
    ...query,
    refresh: () => setRefreshNonce((n) => n + 1),
  };
}

/**
 * Resolve one Page post from a pasted Facebook link or post ID
 * (POST /facebook/posts/:pageId/resolve).
 */
export function useResolveFacebookPost() {
  const requestScope = useWorkspaceRequestScope();
  return async (pageId: string, url: string): Promise<FacebookPostItem> => {
    const result = await sendWorkspaceRequest<{ post: FacebookPostRaw }>(
      requestScope,
      `/facebook/posts/${pageId}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      },
    );
    return mapFacebookPost(result.post);
  };
}
