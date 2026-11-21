/**
 * Link click tracking (2026-11-17) — zero-cost, no analytics service.
 *
 * Every link an automation sends (opening-DM link button, response link
 * buttons, card buttons) is rewritten to a short redirect URL
 * ({appUrl}/r/{code}) at send time. The redirect route records the click
 * and sends the person to the real destination. Per-automation totals are
 * shown on the Automations list.
 *
 * Fail-open by design: a tracking failure (DB error, missing app URL)
 * returns the ORIGINAL destination URL, so a click-tracking problem can
 * never block or break a DM.
 *
 * Only http(s) destinations are tracked — anything else passes through
 * untouched. Codes are random base62 (7 chars, ~3.5e12 space); a unique
 * collision retries with a fresh code.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';
import type { DMResponse } from '@/lib/types';

const logger = createLogger('link-tracking');

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 7;

export function generateShortCode(): string {
  // crypto.randomUUID is available in Node 19+ and Edge; derive the code
  // from its hex so no extra dependency is needed.
  const hex = crypto.randomUUID().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    out += CODE_ALPHABET[parseInt(pair, 16) % CODE_ALPHABET.length]!;
  }
  return out;
}

export function isTrackableUrl(raw: string | undefined | null): raw is string {
  if (!raw) return false;
  const url = raw.trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Short URL for one destination, creating the tracked_links row on first use. */
export async function trackLink(
  db: SupabaseClient,
  params: {
    automationId: string;
    instagramAccountId: string;
    /** Facebook jobs: the facebook_pages row id. When set, the tracked
     *  link is stamped with facebook_page_id and instagram_account_id
     *  stays NULL (migration 20261119000001 made it nullable). */
    facebookPageId?: string | null;
    destinationUrl: string;
    appUrl: string;
  },
): Promise<string> {
  const destination = params.destinationUrl.trim();
  if (!isTrackableUrl(destination)) return params.destinationUrl;
  const base = params.appUrl.replace(/\/$/, '');
  // Already one of our own short links (e.g. re-saved after a send) —
  // never nest a tracked link inside another tracked link.
  if (destination.startsWith(`${base}/r/`)) return destination;
  try {
    const { data: existing } = await db
      .from('tracked_links')
      .select('code')
      .eq('automation_id', params.automationId)
      .eq('destination_url', destination)
      .maybeSingle();
    if (existing?.code) return `${base}/r/${existing.code as string}`;

    // Race-safe: two concurrent first-sends for the same link can both
    // miss the lookup; the (automation_id, destination_url) unique index
    // rejects the loser, and we re-read the winner's code.
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateShortCode();
      const { error } = await db.from('tracked_links').insert({
        code,
        automation_id: params.automationId,
        instagram_account_id: params.facebookPageId ? null : params.instagramAccountId,
        ...(params.facebookPageId ? { facebook_page_id: params.facebookPageId } : {}),
        destination_url: destination,
        click_count: 0,
      });
      if (!error) return `${base}/r/${code}`;
      if (error.code === '23505') {
        const { data: winner } = await db
          .from('tracked_links')
          .select('code')
          .eq('automation_id', params.automationId)
          .eq('destination_url', destination)
          .maybeSingle();
        if (winner?.code) return `${base}/r/${winner.code as string}`;
      }
    }
    logger.warn({ automationId: params.automationId }, 'trackLink: could not create tracked link after retries');
  } catch (err) {
    logger.warn({ err }, 'trackLink failed - returning original URL');
  }
  return params.destinationUrl;
}

/** Rewrite every link inside a response list to its tracked short URL. */
export async function rewriteResponseLinks(
  db: SupabaseClient,
  params: {
    automationId: string;
    instagramAccountId: string;
    /** Facebook jobs: the facebook_pages row id (passed through to trackLink). */
    facebookPageId?: string | null;
    responses: DMResponse[];
    appUrl: string;
  },
): Promise<DMResponse[]> {
  const out: DMResponse[] = [];
  for (const response of params.responses) {
    let next: DMResponse = response;
    if (response.buttonLink?.trim()) {
      const tracked = await trackLink(db, {
        automationId: params.automationId,
        instagramAccountId: params.instagramAccountId,
        facebookPageId: params.facebookPageId ?? null,
        destinationUrl: response.buttonLink,
        appUrl: params.appUrl,
      });
      if (tracked !== response.buttonLink) next = { ...next, buttonLink: tracked };
    }
    // Second link button (2026-11-22): rewrite every `buttons` link the
    // same way, so both buttons get their own tracked short URL.
    if (response.buttons?.length) {
      const trackedButtons = [];
      let changed = false;
      for (const btn of response.buttons) {
        if (!btn.link?.trim()) {
          trackedButtons.push(btn);
          continue;
        }
        const tracked = await trackLink(db, {
          automationId: params.automationId,
          instagramAccountId: params.instagramAccountId,
          facebookPageId: params.facebookPageId ?? null,
          destinationUrl: btn.link,
          appUrl: params.appUrl,
        });
        if (tracked !== btn.link) changed = true;
        trackedButtons.push({ ...btn, link: tracked });
      }
      if (changed) next = { ...next, buttons: trackedButtons };
    }
    if (response.cardButtons?.length) {
      const trackedButtons = [];
      let changed = false;
      for (const btn of response.cardButtons) {
        const tracked = await trackLink(db, {
          automationId: params.automationId,
          instagramAccountId: params.instagramAccountId,
          facebookPageId: params.facebookPageId ?? null,
          destinationUrl: btn.link,
          appUrl: params.appUrl,
        });
        if (tracked !== btn.link) changed = true;
        trackedButtons.push({ ...btn, link: tracked });
      }
      if (changed) next = { ...next, cardButtons: trackedButtons };
    }
    out.push(next);
  }
  return out;
}

/** Record one click and return the destination URL, or null for an unknown code. */
export async function recordLinkClick(
  db: SupabaseClient,
  code: string,
  userAgent: string | null,
): Promise<string | null> {
  const { data: link, error } = await db
    .from('tracked_links')
    .select('id, destination_url')
    .eq('code', code)
    .maybeSingle();
  if (error || !link) return null;
  const destination = link.destination_url as string;
  // Best-effort logging: a failed click insert must never break the redirect.
  try {
    await db.from('link_clicks').insert({
      tracked_link_id: link.id as string,
      user_agent: userAgent,
    });
  } catch (err) {
    logger.warn({ err }, 'link click log insert failed');
  }
  try {
    const { error: countError } = await db.rpc('increment_tracked_link_clicks', {
      p_tracked_link_id: link.id as string,
    });
    if (countError) throw countError;
  } catch {
    // Fallback when the RPC does not exist yet (migration not applied):
    // a plain read-modify-write keeps counting, best-effort.
    try {
      const { data: current } = await db
        .from('tracked_links')
        .select('click_count')
        .eq('id', link.id as string)
        .maybeSingle();
      await db
        .from('tracked_links')
        .update({ click_count: ((current?.click_count as number) ?? 0) + 1 })
        .eq('id', link.id as string);
    } catch (err) {
      logger.warn({ err }, 'link click count increment failed');
    }
  }
  return destination;
}

/** Total clicks per automation id (sum of click_count over its links). */
export async function getLinkClickCounts(
  db: SupabaseClient,
  automationIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (automationIds.length === 0) return counts;
  try {
    const { data, error } = await db
      .from('tracked_links')
      .select('automation_id, click_count')
      .in('automation_id', automationIds);
    if (error) throw error;
    for (const row of data ?? []) {
      const id = row.automation_id as string;
      counts.set(id, (counts.get(id) ?? 0) + ((row.click_count as number) ?? 0));
    }
  } catch (err) {
    // Fail-open: a missing table (migration not applied yet) must never
    // break the automations list — every automation just reports 0.
    logger.warn({ err }, 'getLinkClickCounts failed - returning empty counts');
  }
  return counts;
}
