/**
 * Analytics channel scoping (2026-11-22).
 *
 * Instagram and Facebook rows live in the same tables but under
 * different account columns — Instagram rows key on
 * instagram_account_id, Facebook rows on facebook_page_id (with
 * instagram_account_id NULL on the FB side). The `channel` query
 * param scopes every analytics source to one channel's rows; `all`
 * merges both. Automations carry the same discriminator in their
 * `channel` column ('instagram' | 'facebook', defaulting to
 * 'instagram' for rows written before the column existed).
 */

import type { AnalyticsAutomationMeta } from './aggregate';

/** Channel selector for /api/analytics. 'all' merges both channels. */
export type AnalyticsChannel = 'instagram' | 'facebook' | 'all';

/** Parses the `channel` query param; null ⇒ invalid (caller gets a 400). */
export function parseAnalyticsChannel(value: string | null): AnalyticsChannel | null {
  if (value === null || value === 'all') return 'all';
  if (value === 'instagram' || value === 'facebook') return value;
  return null;
}

export function channelOfAutomation(a: { channel?: string | null }): 'instagram' | 'facebook' {
  return a.channel === 'facebook' ? 'facebook' : 'instagram';
}

export function filterMetaByChannel(
  meta: AnalyticsAutomationMeta[],
  channel: AnalyticsChannel,
): AnalyticsAutomationMeta[] {
  if (channel === 'all') return meta;
  return meta.filter((a) => channelOfAutomation(a) === channel);
}
