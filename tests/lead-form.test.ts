/**
 * Lead form capture (2026-11-17) — src/lib/automation/leadCapture.ts
 * with a FakeSupabase-backed service client.
 *
 * Covers:
 *  (a) validateLeadValue: email and phone validation, loose on purpose
 *      (spaces/dashes in phone numbers are accepted; strict validation
 *      would silently drop real answers);
 *  (b) recordLeadAsk stores a pending capture for the audience member;
 *  (c) captureLeadReply stores a matching reply in lead_submissions and
 *      clears the pending row — and only then;
 *  (d) a reply that does not match any requested field leaves the
 *      pending row alone (the person can answer later);
 *  (e) no pending ask → null (the message falls through to normal
 *      DM routing);
 *  (f) an expired pending ask is never matched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import {
  validateLeadValue,
  recordLeadAsk,
  captureLeadReply,
} from '@/lib/automation/leadCapture';

void (fake as unknown as SupabaseClient);

const DB = fake as unknown as SupabaseClient;

beforeEach(() => {
  fake.calls.length = 0;
  fake.replaceRows('pending_lead_captures', []);
  fake.replaceRows('lead_submissions', []);
});

async function ask(fields: ('email' | 'phone')[] = ['email']): Promise<void> {
  await recordLeadAsk(DB, {
    automationId: 'auto-1',
    instagramAccountId: 'acct-1',
    audienceIgUserId: 'IG-FAN',
    fields,
    responseId: 'resp-1',
  });
}

describe('validateLeadValue', () => {
  it('accepts a plain email', () => {
    expect(validateLeadValue('email', 'parvez@example.com')).toBe('parvez@example.com');
  });

  it('rejects text without @ and a domain', () => {
    expect(validateLeadValue('email', 'not an email')).toBeNull();
    expect(validateLeadValue('email', 'someone@nowhere')).toBeNull();
  });

  it('accepts a phone number with spaces, dashes and a leading +', () => {
    expect(validateLeadValue('phone', '+91 98765 43210')).toBe('+91 98765 43210');
    expect(validateLeadValue('phone', '987-654-3210')).toBe('987-654-3210');
  });

  it('rejects short strings and words as phone numbers', () => {
    expect(validateLeadValue('phone', '123')).toBeNull();
    expect(validateLeadValue('phone', 'call me')).toBeNull();
  });
});

describe('lead capture round-trip', () => {
  it('stores a matching email reply and clears the pending ask', async () => {
    await ask(['email']);
    const captured = await captureLeadReply(DB, {
      instagramAccountId: 'acct-1',
      audienceIgUserId: 'IG-FAN',
      text: 'parvez@example.com',
    });
    expect(captured).toEqual({ automationId: 'auto-1', field: 'email', value: 'parvez@example.com' });
    expect(fake.rows('lead_submissions')).toHaveLength(1);
    expect(fake.rows('lead_submissions')[0]!).toMatchObject({
      automation_id: 'auto-1',
      field: 'email',
      value: 'parvez@example.com',
    });
    expect(fake.rows('pending_lead_captures')).toHaveLength(0);
  });

  it('stores a matching phone reply when phone was asked', async () => {
    await ask(['phone']);
    const captured = await captureLeadReply(DB, {
      instagramAccountId: 'acct-1',
      audienceIgUserId: 'IG-FAN',
      text: '+91 98765 43210',
    });
    expect(captured?.field).toBe('phone');
    expect(fake.rows('lead_submissions')).toHaveLength(1);
  });

  it('a non-matching reply leaves the pending ask alone', async () => {
    await ask(['email']);
    const captured = await captureLeadReply(DB, {
      instagramAccountId: 'acct-1',
      audienceIgUserId: 'IG-FAN',
      text: 'just saying thanks!',
    });
    expect(captured).toBeNull();
    expect(fake.rows('lead_submissions')).toHaveLength(0);
    expect(fake.rows('pending_lead_captures')).toHaveLength(1);
  });

  it('a phone reply does not satisfy an email-only ask', async () => {
    await ask(['email']);
    const captured = await captureLeadReply(DB, {
      instagramAccountId: 'acct-1',
      audienceIgUserId: 'IG-FAN',
      text: '9876543210',
    });
    expect(captured).toBeNull();
    expect(fake.rows('pending_lead_captures')).toHaveLength(1);
  });

  it('no pending ask returns null', async () => {
    const captured = await captureLeadReply(DB, {
      instagramAccountId: 'acct-1',
      audienceIgUserId: 'IG-FAN',
      text: 'parvez@example.com',
    });
    expect(captured).toBeNull();
    expect(fake.rows('lead_submissions')).toHaveLength(0);
  });

  it('an expired pending ask is never matched', async () => {
    await ask(['email']);
    const row = fake.rows('pending_lead_captures')[0] as FakeRow;
    // Expire the ask in place (24h window passed).
    row['expires_at'] = new Date(Date.now() - 1000).toISOString();
    const captured = await captureLeadReply(DB, {
      instagramAccountId: 'acct-1',
      audienceIgUserId: 'IG-FAN',
      text: 'parvez@example.com',
    });
    expect(captured).toBeNull();
    expect(fake.rows('lead_submissions')).toHaveLength(0);
  });

  it('a second ask for the same person replaces the first (one pending row per user)', async () => {
    await ask(['email']);
    await ask(['phone']);
    expect(fake.rows('pending_lead_captures')).toHaveLength(1);
    expect(fake.rows('pending_lead_captures')[0]!['fields']).toEqual(['phone']);
  });
});
