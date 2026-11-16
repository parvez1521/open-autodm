/**
 * Lead form capture (2026-11-17).
 *
 * A lead_form response sends its ask text ("What's your email?") and
 * records a pending capture for that audience member. Their NEXT free-text
 * DM reply is checked against the requested field(s): a value that looks
 * like an email / phone number is stored in lead_submissions and the
 * pending row is deleted. A reply that does not match is left alone — the
 * pending row stays and the message falls through to normal DM routing,
 * so the person can answer later or type something else.
 *
 * Validation is deliberately loose (a phone number is digits with an
 * optional leading +, 7-15 digits; an email is anything with @ and a dot
 * after it) — strict validation would silently drop real answers typed
 * with spaces or dashes. Captured values are shown on the Leads tab of
 * the Contacts page; nothing is ever sent anywhere else.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lead-capture');

export type LeadField = 'email' | 'phone';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[\d\s().-]{7,20}$/;

/** True when the text looks like a value for the requested field. */
export function validateLeadValue(field: LeadField, rawText: string): string | null {
  const text = rawText.trim();
  if (!text) return null;
  if (field === 'email') {
    return EMAIL_PATTERN.test(text) ? text : null;
  }
  // Phone: strip spaces/dashes/parens, then require 7-15 digits with an optional leading +.
  const digits = text.replace(/[^\d+]/g, '');
  if (!PHONE_PATTERN.test(text)) return null;
  const digitCount = digits.replace(/\+/g, '').length;
  if (digitCount < 7 || digitCount > 15) return null;
  return text;
}

/** Record that a lead-form ask was sent; the next reply may answer it. */
export async function recordLeadAsk(
  db: SupabaseClient,
  params: {
    automationId: string;
    instagramAccountId: string;
    audienceIgUserId: string;
    fields: LeadField[];
    responseId?: string | null;
  },
): Promise<void> {
  try {
    const { error } = await db.from('pending_lead_captures').upsert(
      {
        automation_id: params.automationId,
        instagram_account_id: params.instagramAccountId,
        audience_ig_user_id: params.audienceIgUserId,
        fields: params.fields,
        response_id: params.responseId ?? null,
        asked_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: 'automation_id,audience_ig_user_id', ignoreDuplicates: false },
    );
    if (error) logger.warn({ err: error }, 'recordLeadAsk failed');
  } catch (err) {
    logger.warn({ err }, 'recordLeadAsk threw');
  }
}

export interface CapturedLead {
  automationId: string;
  field: LeadField;
  value: string;
}

/**
 * Check an inbound free-text DM against the sender's pending lead asks.
 * Returns the captured lead on a match (and stores + clears the pending
 * row); returns null when there is no pending ask or the text is not a
 * value for any requested field.
 */
export async function captureLeadReply(
  db: SupabaseClient,
  params: {
    instagramAccountId: string;
    audienceIgUserId: string;
    text: string;
    username?: string | null;
  },
): Promise<CapturedLead | null> {
  type PendingLeadCapture = { id: string; automation_id: string; fields: string[]; expires_at: string };
  let pending: PendingLeadCapture | null = null;
  try {
    const { data, error } = await db
      .from('pending_lead_captures')
      .select('id, automation_id, fields, expires_at')
      .eq('instagram_account_id', params.instagramAccountId)
      .eq('audience_ig_user_id', params.audienceIgUserId)
      .order('asked_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const candidate = data as PendingLeadCapture | null;
    // Expiry is checked in code, not in the query: the 24h window is a
    // business rule, and a DB-side comparison would silently behave
    // differently across timestamp representations.
    pending = candidate && new Date(candidate.expires_at).getTime() > Date.now() ? candidate : null;
  } catch (err) {
    // Fail-open: a missing table (migration not applied yet) or a DB error
    // must never break DM routing — the message falls through.
    logger.warn({ err }, 'captureLeadReply lookup failed');
    return null;
  }
  if (!pending) return null;

  const fields = (pending.fields ?? ['email']) as LeadField[];
  for (const field of fields) {
    const value = validateLeadValue(field, params.text);
    if (value) {
      try {
        const { error: insertError } = await db.from('lead_submissions').insert({
          automation_id: pending.automation_id,
          instagram_account_id: params.instagramAccountId,
          audience_ig_user_id: params.audienceIgUserId,
          username: params.username ?? null,
          field,
          value,
        });
        if (insertError) {
          logger.warn({ err: insertError }, 'lead_submissions insert failed');
          return null;
        }
        await db.from('pending_lead_captures').delete().eq('id', pending.id);
      } catch (err) {
        logger.warn({ err }, 'captureLeadReply store failed');
        return null;
      }
      return { automationId: pending.automation_id as string, field, value };
    }
  }
  return null;
}
