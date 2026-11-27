/**
 * Contacts - the automation-captured audience list.
 *
 * A contact is every unique audience member who triggered an automation
 * (comment / DM keyword / story reply / button tap). Written fire-and-forget
 * from the engine so contact bookkeeping can never slow down or break a send.
 *
 * WORKSPACE (Phase H / Programme 18): the record_contact_interaction RPC
 * (migration …000001) predates tenancy and creates the contacts row
 * without workspace_id. After the RPC succeeds, the row is stamped with
 * the workspace derived SERVER-SIDE from the parent account's binding
 * (instagram_accounts.workspace_id, …000026) — never from a caller claim.
 * The stamp is a plain idempotent UPDATE of the same derived value, so
 * repeat interactions are harmless. Unbound accounts: no stamp is issued
 * and the row keeps its legacy NULL workspace (explicit legacy path).
 * Stamping the row INSIDE the RPC would require replacing the SECURITY
 * DEFINER function — recorded as a remaining migration candidate in
 * PHASE_18_NEW_WRITE_OWNERSHIP_MATRIX.md.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { resolveWorkspaceForAccount } from '@/lib/tenancy/context';
import type { SupabaseClient } from '@supabase/supabase-js';

const logger = createLogger('contacts');

export type ContactTriggerType = 'comment' | 'dm' | 'story_reply' | 'story_mention' | 'button';

/* ─── "Save contacts" toggle (owner request, 2026-11-27) ───────────────
 * The Contacts page has an ON/OFF switch for whether people who
 * trigger an automation are saved as contacts. The setting lives on
 * profiles.save_contacts (migration …20261127000001, DEFAULT true).
 * The gate lives HERE, inside the two record functions — the single
 * choke point for all capture call sites (6 IG sites in
 * processWebhook.ts, 2 FB sites in processFacebookJob.ts) — so no
 * call site can forget it. The DM itself is unaffected: the gate
 * only skips the contact RPC. Fail-open by design: any read failure,
 * missing parent row, missing profile, or NULL value means ON
 * (save contacts), so a settings/read blip can never silently stop
 * capture — only an explicit OFF does. */

export async function shouldSaveContacts(
  db: SupabaseClient,
  parent: { instagramAccountId: string } | { facebookPageId: string },
): Promise<boolean> {
  try {
    const isIg = 'instagramAccountId' in parent;
    const parentTable = isIg ? 'instagram_accounts' : 'facebook_pages';
    const parentId = isIg ? parent.instagramAccountId : parent.facebookPageId;
    const { data: account, error: accountError } = await db
      .from(parentTable)
      .select('user_id')
      .eq('id', parentId)
      .maybeSingle();
    if (accountError || !account) return true;
    const userId = (account as { user_id?: string | null }).user_id;
    if (!userId) return true;
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('save_contacts')
      .eq('id', userId)
      .maybeSingle();
    if (profileError || !profile) return true;
    const value = (profile as { save_contacts?: boolean | null }).save_contacts;
    return value !== false; // NULL ⇒ ON (column is NOT NULL, but be safe)
  } catch {
    return true;
  }
}

/** Records (or increments) a contact interaction. Fire-and-forget. */
export function recordContactInteraction(params: {
  instagramAccountId: string;
  audienceIgUserId: string;
  username?: string | null;
  triggerType: ContactTriggerType;
  automationId?: string | null;
}): void {
  void (async (): Promise<void> => {
    try {
      const db = createServiceClient();
      // "Save contacts" toggle OFF ⇒ skip capture entirely (DM unaffected).
      if (!(await shouldSaveContacts(db as unknown as SupabaseClient, { instagramAccountId: params.instagramAccountId }))) return;
      const { error } = await db.rpc('record_contact_interaction', {
        p_account_id: params.instagramAccountId,
        p_audience_id: params.audienceIgUserId,
        p_username: params.username ?? null,
        p_trigger_type: params.triggerType,
        p_automation_id: params.automationId ?? null,
      });
      if (error) {
        logger.warn({ err: error }, 'record_contact_interaction failed');
        return;
      }
      await stampContactWorkspace(db as unknown as SupabaseClient, params.instagramAccountId, params.audienceIgUserId);
    } catch (err) {
      logger.warn({ err }, 'record_contact_interaction threw');
    }
  })();
}

/** Best-effort workspace stamp for the contact row of (account, audience). */
async function stampContactWorkspace(
  db: SupabaseClient,
  instagramAccountId: string,
  audienceIgUserId: string
): Promise<void> {
  try {
    const workspaceId = await resolveWorkspaceForAccount(db, instagramAccountId);
    if (!workspaceId) return; // unbound parent — legacy NULL, by design
    const { error } = await db
      .from('contacts')
      .update({ workspace_id: workspaceId })
      .eq('instagram_account_id', instagramAccountId)
      .eq('audience_ig_user_id', audienceIgUserId);
    if (error) logger.warn({ err: error }, 'contact workspace stamp failed');
  } catch (err) {
    logger.warn({ err }, 'contact workspace stamp threw');
  }
}

/** Enriches a contact's username / follow status. Fire-and-forget. */
export function updateContactProfile(params: {
  instagramAccountId: string;
  audienceIgUserId: string;
  username?: string | null;
  followsBusiness?: boolean | null;
}): void {
  void (async (): Promise<void> => {
    try {
      const db = createServiceClient();
      const { error } = await db.rpc('update_contact_profile', {
        p_account_id: params.instagramAccountId,
        p_audience_id: params.audienceIgUserId,
        p_username: params.username ?? null,
        p_follows: params.followsBusiness ?? null,
      });
      if (error) logger.warn({ err: error }, 'update_contact_profile failed');
    } catch (err) {
      logger.warn({ err }, 'update_contact_profile threw');
    }
  })();
}

// ── Facebook Page twins (2026-11-19) ────────────────────────────────────────
// Same contract as the Instagram helpers above, keyed on facebook_pages.
// follows_business has no Facebook equivalent (the Messenger profile API
// returns no "follows the Page" signal), so updateFacebookContactProfile
// only ever enriches the username.

/** Records (or increments) a Facebook contact interaction. Fire-and-forget. */
export function recordFacebookContactInteraction(params: {
  facebookPageId: string;
  audienceIgUserId: string;
  username?: string | null;
  triggerType: ContactTriggerType;
  automationId?: string | null;
}): void {
  void (async (): Promise<void> => {
    try {
      const db = createServiceClient();
      // "Save contacts" toggle OFF ⇒ skip capture entirely (DM unaffected).
      if (!(await shouldSaveContacts(db as unknown as SupabaseClient, { facebookPageId: params.facebookPageId }))) return;
      const { error } = await db.rpc('record_fb_contact_interaction', {
        p_page_id: params.facebookPageId,
        p_audience_id: params.audienceIgUserId,
        p_username: params.username ?? null,
        p_trigger_type: params.triggerType,
        p_automation_id: params.automationId ?? null,
      });
      if (error) {
        logger.warn({ err: error }, 'record_fb_contact_interaction failed');
        return;
      }
      await stampFacebookContactWorkspace(
        db as unknown as SupabaseClient,
        params.facebookPageId,
        params.audienceIgUserId
      );
    } catch (err) {
      logger.warn({ err }, 'record_fb_contact_interaction threw');
    }
  })();
}

/** Best-effort workspace stamp for the contact row of (Page, audience). */
async function stampFacebookContactWorkspace(
  db: SupabaseClient,
  facebookPageId: string,
  audienceIgUserId: string
): Promise<void> {
  try {
    const { data: page } = await db
      .from('facebook_pages')
      .select('workspace_id')
      .eq('id', facebookPageId)
      .maybeSingle();
    const workspaceId = (page as { workspace_id?: string | null } | null)?.workspace_id;
    if (!workspaceId) return; // unbound parent — legacy NULL, by design
    const { error } = await db
      .from('contacts')
      .update({ workspace_id: workspaceId })
      .eq('facebook_page_id', facebookPageId)
      .eq('audience_ig_user_id', audienceIgUserId);
    if (error) logger.warn({ err: error }, 'facebook contact workspace stamp failed');
  } catch (err) {
    logger.warn({ err }, 'facebook contact workspace stamp threw');
  }
}

/** Enriches a Facebook contact's username. Fire-and-forget. */
export function updateFacebookContactProfile(params: {
  facebookPageId: string;
  audienceIgUserId: string;
  username?: string | null;
}): void {
  void (async (): Promise<void> => {
    try {
      const db = createServiceClient();
      const { error } = await db.rpc('update_fb_contact_profile', {
        p_page_id: params.facebookPageId,
        p_audience_id: params.audienceIgUserId,
        p_username: params.username ?? null,
      });
      if (error) {
        logger.warn({ err: error }, 'update_fb_contact_profile failed');
        return;
      }
    } catch (err) {
      logger.warn({ err }, 'update_fb_contact_profile threw');
    }
  })();
}

/* ─── "DM sent" time for the Contacts list (owner request, 2026-11-27) ───
 * The contacts table has no "last DM sent" column, and none is added:
 * dm_jobs.sent_at is the moment a DM actually went out, keyed by the
 * same (instagram_account_id, trigger_user_id) pair as a contact's
 * (instagram_account_id, audience_ig_user_id). The list route runs one
 * extra bounded query over dm_jobs and attaches the latest sent_at per
 * contact as last_dm_sent_at (null when no DM was ever sent). The
 * engine is untouched. */

export interface DmSentRow {
  instagram_account_id: string;
  trigger_user_id: string;
  sent_at: string | null;
}

/** Latest sent_at per (account, audience) — order-independent, nulls skipped. */
export function buildLastDmSentAtMap(rows: DmSentRow[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (!row.sent_at) continue;
    const key = `${row.instagram_account_id}\n${row.trigger_user_id}`;
    const prev = latest.get(key);
    if (!prev || row.sent_at > prev) latest.set(key, row.sent_at);
  }
  return latest;
}

export type ContactWithDmSent<T extends { instagram_account_id: string; audience_ig_user_id: string }> =
  T & { last_dm_sent_at: string | null };

/** Attaches last_dm_sent_at (null when the contact never got a DM). */
export function attachLastDmSentAt<T extends { instagram_account_id: string; audience_ig_user_id: string }>(
  contacts: T[],
  latestByKey: Map<string, string>,
): ContactWithDmSent<T>[] {
  return contacts.map((c) => ({
    ...c,
    last_dm_sent_at: latestByKey.get(`${c.instagram_account_id}\n${c.audience_ig_user_id}`) ?? null,
  }));
}

/**
 * One bounded query for the latest sent DM per contact in the list.
 * Scoped to exactly the accounts + audience IDs on the page (never a
 * full-table scan), only rows whose DM actually sent (status 'sent'),
 * newest first. Callers treat a throw as enrichment-unavailable and
 * return the contacts with nulls — the list must never fail because
 * this leg did.
 */
export async function fetchLatestDmSentAt(
  db: SupabaseClient,
  accountIds: string[],
  audienceIds: string[],
): Promise<Map<string, string>> {
  const { data, error } = await db
    .from('dm_jobs')
    .select('instagram_account_id, trigger_user_id, sent_at')
    .in('instagram_account_id', accountIds)
    .in('trigger_user_id', audienceIds)
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  return buildLastDmSentAtMap((data ?? []) as DmSentRow[]);
}
