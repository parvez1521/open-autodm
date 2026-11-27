/**
 * GET / PATCH /api/contacts/settings - the "Save contacts" toggle.
 *
 * Owner request (2026-11-27): the Contacts page has an ON/OFF switch
 * for whether people who trigger an automation are saved as contacts.
 * The setting lives on profiles.save_contacts (migration
 * 20261127000001, DEFAULT true) — one row per user, so the toggle
 * covers every connected account and Page at once. The engine reads
 * it in src/lib/automation/contacts.ts (shouldSaveContacts) and skips
 * the contact RPC when OFF; DMs still send normally.
 *
 * GET returns { saveContacts: boolean } (missing profile ⇒ true).
 * PATCH accepts { saveContacts: boolean } and returns the saved value.
 * PATCH uses upsert (onConflict id) so a user whose profiles row
 * somehow does not exist yet still gets the setting saved.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:contacts:settings');

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const db = createServiceClient();
  const { data, error } = await db
    .from('profiles')
    .select('save_contacts')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to read save-contacts setting');
    return Response.json({ error: 'Failed to read setting' }, { status: 500 });
  }
  const value = (data as { save_contacts?: boolean | null } | null)?.save_contacts;
  // Missing profile row / NULL ⇒ ON (fail-open; column is NOT NULL).
  return Response.json({ saveContacts: value !== false });
}

export async function PATCH(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const saveContacts = (body as { saveContacts?: unknown } | null)?.saveContacts;
  if (typeof saveContacts !== 'boolean') {
    return Response.json({ error: 'saveContacts must be a boolean' }, { status: 400 });
  }
  const db = createServiceClient();
  const { error } = await db
    .from('profiles')
    .upsert({ id: user.id, save_contacts: saveContacts }, { onConflict: 'id' });
  if (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to save save-contacts setting');
    return Response.json({ error: 'Failed to save setting' }, { status: 500 });
  }
  logger.debug({ userId: user.id, saveContacts }, 'Saved save-contacts setting');
  return Response.json({ saveContacts });
}
