/**
 * "DM sent" column for the Contacts list (owner request, 2026-11-27).
 *
 * The contacts table has no "last DM sent" column and none is added:
 * GET /api/contacts runs one extra bounded query over dm_jobs and
 * attaches the latest sent_at per contact as last_dm_sent_at (null
 * when no DM was ever sent). ContactsList renders it as date + time.
 *
 * Pins:
 *  - API merge: contact with several sent DMs shows the latest
 *    sent_at; failed/queued jobs (sent_at null) are ignored; a
 *    contact with no DM shows null; dm_jobs rows from another
 *    account (same audience ID) never leak across accounts.
 *  - Pure merge helpers: latest wins regardless of row order, null
 *    sent_at rows are skipped, unknown keys are ignored.
 *  - UI (source pins — the suite runs node-only with no DOM):
 *    the table has a "DM sent" column after "Last Active" that
 *    renders date + time and a muted dash when never sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET } from '@/app/api/contacts/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import {
  attachLastDmSentAt,
  buildLastDmSentAtMap,
} from '@/lib/automation/contacts';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const ACCT_A = 'acct-a';
const ACCT_B = 'acct-b';

function seedAll(): void {
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER.id, username: 'acct-a', is_active: true },
    { id: ACCT_B, user_id: 'user-other', username: 'acct-b', is_active: true },
  ]);
  fake.replaceRows('contacts', [
    {
      id: 'contact-1', instagram_account_id: ACCT_A,
      username: 'friend-one', audience_ig_user_id: '1001', follows_business: true,
      first_interaction_at: '2026-11-20T09:00:00Z', last_interaction_at: '2026-11-27T19:30:00Z',
      last_trigger_type: 'comment', total_triggers: 4,
    },
    {
      id: 'contact-2', instagram_account_id: ACCT_A,
      username: 'friend-two', audience_ig_user_id: '1002', follows_business: false,
      first_interaction_at: '2026-11-25T09:00:00Z', last_interaction_at: '2026-11-26T10:00:00Z',
      last_trigger_type: 'dm', total_triggers: 1,
    },
    {
      id: 'contact-3', instagram_account_id: ACCT_A,
      username: 'friend-three', audience_ig_user_id: '1003', follows_business: null,
      first_interaction_at: '2026-11-24T09:00:00Z', last_interaction_at: '2026-11-25T08:00:00Z',
      last_trigger_type: 'comment', total_triggers: 2,
    },
  ]);
  fake.replaceRows('dm_jobs', [
    // contact-1: two sent DMs — the latest must win.
    { id: 'job-1a', automation_id: 'auto-1', instagram_account_id: ACCT_A, trigger_user_id: '1001', trigger_type: 'comment', trigger_event_id: 'e1', trigger_timestamp: '2026-11-20T10:00:00Z', status: 'sent', sent_at: '2026-11-20T10:00:00Z' },
    { id: 'job-1b', automation_id: 'auto-1', instagram_account_id: ACCT_A, trigger_user_id: '1001', trigger_type: 'comment', trigger_event_id: 'e2', trigger_timestamp: '2026-11-27T19:30:00Z', status: 'sent', sent_at: '2026-11-27T19:30:00Z' },
    // contact-1: failed + queued jobs carry no sent_at — ignored.
    { id: 'job-1c', automation_id: 'auto-1', instagram_account_id: ACCT_A, trigger_user_id: '1001', trigger_type: 'comment', trigger_event_id: 'e3', trigger_timestamp: '2026-11-27T20:00:00Z', status: 'failed', sent_at: null, error_message: 'boom' },
    { id: 'job-1d', automation_id: 'auto-1', instagram_account_id: ACCT_A, trigger_user_id: '1001', trigger_type: 'comment', trigger_event_id: 'e4', trigger_timestamp: '2026-11-27T20:05:00Z', status: 'queued', sent_at: null },
    // contact-3: one sent DM.
    { id: 'job-3a', automation_id: 'auto-1', instagram_account_id: ACCT_A, trigger_user_id: '1003', trigger_type: 'comment', trigger_event_id: 'e5', trigger_timestamp: '2026-11-25T08:15:00Z', status: 'sent', sent_at: '2026-11-25T08:15:00Z' },
    // Same audience ID (1001) on ANOTHER account, sent later — must not leak into contact-1.
    { id: 'job-x', automation_id: 'auto-2', instagram_account_id: ACCT_B, trigger_user_id: '1001', trigger_type: 'comment', trigger_event_id: 'e6', trigger_timestamp: '2026-11-28T00:00:00Z', status: 'sent', sent_at: '2026-11-28T00:00:00Z' },
    // DM to someone who is not a contact — ignored by the merge.
    { id: 'job-y', automation_id: 'auto-1', instagram_account_id: ACCT_A, trigger_user_id: '9999', trigger_type: 'comment', trigger_event_id: 'e7', trigger_timestamp: '2026-11-27T12:00:00Z', status: 'sent', sent_at: '2026-11-27T12:00:00Z' },
  ]);
}

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  process.env['WORKSPACE_RUNTIME_ENABLED'] = '';
  fake.calls.length = 0;
  seedAll();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(OWNER as never);
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedFlag;
});

async function listContacts(): Promise<{ contacts: Record<string, unknown>[] }> {
  const res = await GET(new Request('http://localhost/api/contacts'));
  expect(res.status).toBe(200);
  return (await res.json()) as { contacts: Record<string, unknown>[] };
}

describe('GET /api/contacts attaches last_dm_sent_at', () => {
  it('contact with several sent DMs shows the latest sent_at', async () => {
    const { contacts } = await listContacts();
    const c1 = contacts.find((c) => c['id'] === 'contact-1');
    expect(c1?.['last_dm_sent_at']).toBe('2026-11-27T19:30:00Z');
  });

  it('contact with no DM shows null (failed/queued jobs do not count)', async () => {
    const { contacts } = await listContacts();
    const c2 = contacts.find((c) => c['id'] === 'contact-2');
    expect(c2?.['last_dm_sent_at']).toBeNull();
  });

  it('a single sent DM is attached, and another account never leaks in', async () => {
    const { contacts } = await listContacts();
    const c3 = contacts.find((c) => c['id'] === 'contact-3');
    expect(c3?.['last_dm_sent_at']).toBe('2026-11-25T08:15:00Z');
    // The ACCT_B row for the same audience (1001) is newer, but the
    // merge is keyed by (account, audience) — contact-1 keeps its own.
    const c1 = contacts.find((c) => c['id'] === 'contact-1');
    expect(c1?.['last_dm_sent_at']).toBe('2026-11-27T19:30:00Z');
  });

  it('existing contact fields are unchanged by the merge', async () => {
    const { contacts } = await listContacts();
    const c1 = contacts.find((c) => c['id'] === 'contact-1');
    expect(c1?.['username']).toBe('friend-one');
    expect(c1?.['total_triggers']).toBe(4);
    expect(c1?.['last_interaction_at']).toBe('2026-11-27T19:30:00Z');
  });

  it('a failing dm_jobs leg still returns the list, with nulls', async () => {
    fake.failNextQuery('dm_jobs', { message: 'boom', code: 'XX000' });
    const { contacts } = await listContacts();
    expect(contacts).toHaveLength(3);
    for (const c of contacts) expect(c['last_dm_sent_at']).toBeNull();
  });
});

describe('merge helpers (pure)', () => {
  it('buildLastDmSentAtMap picks the latest sent_at regardless of row order and skips nulls', () => {
    const map = buildLastDmSentAtMap([
      { instagram_account_id: 'a', trigger_user_id: 'u', sent_at: '2026-11-27T19:30:00Z' },
      { instagram_account_id: 'a', trigger_user_id: 'u', sent_at: null },
      { instagram_account_id: 'a', trigger_user_id: 'u', sent_at: '2026-11-20T10:00:00Z' },
      { instagram_account_id: 'a', trigger_user_id: 'v', sent_at: '2026-11-25T08:15:00Z' },
    ]);
    expect(map.get('a\nu')).toBe('2026-11-27T19:30:00Z');
    expect(map.get('a\nv')).toBe('2026-11-25T08:15:00Z');
    expect(map.size).toBe(2);
  });

  it('attachLastDmSentAt leaves unknown keys out and defaults the rest to null', () => {
    const out = attachLastDmSentAt(
      [
        { instagram_account_id: 'a', audience_ig_user_id: 'u', username: 'u1' },
        { instagram_account_id: 'a', audience_ig_user_id: 'w', username: 'w1' },
      ],
      new Map([['a\nu', '2026-11-27T19:30:00Z']]),
    );
    expect(out[0]?.last_dm_sent_at).toBe('2026-11-27T19:30:00Z');
    expect(out[1]?.last_dm_sent_at).toBeNull();
    expect(out[0]?.username).toBe('u1');
  });
});

describe('ContactsList renders the DM sent column', () => {
  const list = readFileSync(
    path.resolve(process.cwd(), 'src', 'components', 'automations', 'ContactsList.tsx'),
    'utf8',
  );

  it('has a "DM sent" column after "Last Active"', () => {
    expect(list).toContain('<th className="px-5 py-3">DM sent</th>');
    expect(list.indexOf('>Last Active</th>')).toBeLessThan(list.indexOf('>DM sent</th>'));
  });

  it('renders date + time via formatDateTime, and a muted dash when never sent', () => {
    expect(list).toContain('formatDateTime(contact.last_dm_sent_at)');
    expect(list).toContain('hour: "numeric", minute: "2-digit"');
    expect(list).toContain(': "—"');
  });
});
