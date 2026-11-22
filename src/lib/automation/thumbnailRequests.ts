/**
 * Pure grouping for fresh-thumbnail requests (2026-11-22).
 *
 * Kept in a plain .ts module (no JSX, no React) so the
 * node-environment Vitest suite can import it — the hook itself
 * pulls in WorkspaceProvider (JSX), which the node test setup
 * cannot parse.
 */

export interface ThumbnailRequestItem {
  postId: string;
  channel: 'instagram' | 'facebook';
  /** instagram_accounts row id, or facebook_pages row id. */
  accountId: string | null;
}

export interface ThumbnailRequestGroup {
  channel: 'instagram' | 'facebook';
  accountId: string;
  postIds: string[];
}

/** Group items by (channel, account) and dedupe post IDs per group. */
export function groupThumbnailRequests(items: ThumbnailRequestItem[]): ThumbnailRequestGroup[] {
  const groups = new Map<
    string,
    { channel: 'instagram' | 'facebook'; accountId: string; postIds: string[]; seen: Set<string> }
  >();
  for (const item of items) {
    if (!item.postId || !item.accountId) continue;
    const key = `${item.channel}:${item.accountId}`;
    let group = groups.get(key);
    if (!group) {
      group = { channel: item.channel, accountId: item.accountId, postIds: [], seen: new Set<string>() };
      groups.set(key, group);
    }
    if (!group.seen.has(item.postId)) {
      group.seen.add(item.postId);
      group.postIds.push(item.postId);
    }
  }
  return [...groups.values()].map(({ channel, accountId, postIds }) => ({ channel, accountId, postIds }));
}
