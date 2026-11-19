'use client';

/**
 * Resolves the UI's active Facebook Page.
 *
 * Falls back to the first connected Page when nothing is stored (or the
 * stored Page was disconnected). The resolved id is only ever one of the
 * user's own Pages, and the server independently re-verifies ownership of
 * any pageId it receives. Mirrors useActiveAccount (Instagram).
 */

import { useFacebookPages, type FacebookPage } from '@/hooks/useFacebookPages';
import { useAccountStore } from '@/lib/store';

export function useActiveFacebookPage(): {
  page: FacebookPage | null;
  pageId: string | null;
  pages: FacebookPage[];
  isLoading: boolean;
  setActiveFacebookPage: (id: string | null) => void;
} {
  const { data: pages, isLoading } = useFacebookPages();
  const { activeFacebookPageId, setActiveFacebookPage } = useAccountStore();

  const list = pages ?? [];
  const page = list.find((p) => p.id === activeFacebookPageId) ?? list[0] ?? null;

  return {
    page,
    pageId: page?.id ?? null,
    pages: list,
    isLoading,
    setActiveFacebookPage,
  };
}
