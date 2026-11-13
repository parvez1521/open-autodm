/**
 * Area — Post picker Load-more visibility (SelectPostStep, 2026-11-13).
 *
 * Regression: "Load more" was hidden whenever the user filtered to
 * Reels/Photos or typed a search (`hasNextPage && !searchQuery &&
 * filter === "all"`), stranding them on a filtered short list with
 * no way to load further pages. Pagination is server-side and the
 * client-side filter/search re-applies to loaded pages, so loading
 * more under a filter or search only ever adds candidates — the
 * button now shows whenever another page exists.
 *
 * Note: this repo's Vitest runs in a node environment with no DOM
 * and no React testing library, so the picker itself cannot be
 * render-tested here; the visibility rule is pinned through the
 * extracted pure helper, and the live browser check is the proof
 * for the rendered button (Load more under the Reels filter) and
 * for the editor's "Change post" button returning to step 1.
 */

import { describe, expect, it } from 'vitest';
import { shouldShowLoadMore } from '@/components/automations/new-flow/steps/postPickerUtils';

describe('shouldShowLoadMore', () => {
    it('shows Load more when another page exists, regardless of filter or search', () => {
        // Under the Reels filter with a next page: previously hidden.
        expect(shouldShowLoadMore(true)).toBe(true);
    });

    it('hides Load more only when there is no next page', () => {
        expect(shouldShowLoadMore(false)).toBe(false);
    });
});
