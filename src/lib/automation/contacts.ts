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

export type ContactTriggerType = 'comment' | 'dm' | 'story_reply' | 'button';

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
