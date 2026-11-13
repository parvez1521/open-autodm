/**
 * Pure helpers for the post picker (SelectPostStep).
 *
 * Kept in a plain .ts module (no JSX) so the node-environment
 * Vitest suite can import it — .tsx component files fail to parse
 * under this repo's test config.
 */

/**
 * Load-more visibility: show whenever Meta reports another page.
 * Pagination is server-side and the client-side filter/search
 * re-applies to whatever pages are loaded, so loading more under a
 * filter or a search only ever adds candidates. The old rule also
 * required `!searchQuery && filter === "all"`, which hid the button
 * the moment the user filtered to Reels/Photos or typed a search —
 * stranding them on a filtered short list with no way forward.
 */
export function shouldShowLoadMore(hasNextPage: boolean): boolean {
    return hasNextPage;
}
