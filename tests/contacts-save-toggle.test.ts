/**
 * "Save contacts" toggle (owner request, 2026-11-27).
 *
 * The Contacts page has an ON/OFF switch for whether people who
 * trigger an automation are saved as contacts. The setting lives on
 * profiles.save_contacts (migration 20261127000001, DEFAULT true).
 *
 * Pins:
 *  - Gate (shouldSaveContacts): ON when the profile says true, OFF
 *    only when it explicitly says false; fail-open (true) on a
 *    missing profile row, a NULL value, a missing parent account /
 *    Page row, and on any DB error — only an explicit OFF stops
 *    capture.
 *  - End-to-end gate: with the toggle OFF, recordContactInteraction
 *    / recordFacebookContactInteraction never call their RPC; with
 *    it ON they do. The DM path is untouched by this change.
 *  - API (GET/PATCH /api/contacts/settings): 401 unauthenticated;
 *    GET returns the stored value (missing profile ⇒ true); PATCH
 *    validates the boolean (400 otherwise), persists it, and creates
 *    the profiles row when it does not exist yet.
 *  - Migration + UI source pins (suite runs node-only, no DOM): the
 *    migration adds save_contacts DEFAULT true; ContactsList renders
 *    a role="switch" labelled "Save contacts" with the "DMs still
 *    send" copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase } from './helpers/fakeSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

import {
  recordContactInteraction,
  recordFacebookContactInteraction,
  shouldSaveContacts,
} from '@/lib/automation/contacts';
import { GET, PATCH } from '@/app/api/contacts/settings/route';
import { getAuthenticatedUser } from '@/lib/auth';

const mockAuth = vi.mocked(getAuthenticatedUser);
const db = fake as unknown as SupabaseClient;

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const ACCT = 'acct-a';
const PAGE = 'page-a';

async function flush(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function seedParents(): void {
  fake.replaceRows('instagram_accounts', [
    { id: ACCT, user_id: OWNER.id, username: 'creator-a', is_active: true, workspace_id: null },
  ]);
  fake.replaceRows('facebook_pages', [
    { id: PAGE, user_id: OWNER.id, facebook_page_id: '123', name: 'Tech Hacks AI', workspace_id: null },
  ]);
}

describe('shouldSaveContacts gate', () => {
  beforeEach(() => {
    fake.replaceRows('instagram_accounts', []);
    fake.replaceRows('facebook_pages', []);
    fake.replaceRows('profiles', []);
    fake.clearRpcHandlers();
    seedParents();
  });

  it('IG: profile true ⇒ save', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: true }]);
    await expect(shouldSaveContacts(db, { instagramAccountId: ACCT })).resolves.toBe(true);
  });

  it('IG: profile false ⇒ do NOT save', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    await expect(shouldSaveContacts(db, { instagramAccountId: ACCT })).resolves.toBe(false);
  });

  it('FB: profile false ⇒ do NOT save', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    await expect(shouldSaveContacts(db, { facebookPageId: PAGE })).resolves.toBe(false);
  });

  it('FB: profile true ⇒ save', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: true }]);
    await expect(shouldSaveContacts(db, { facebookPageId: PAGE })).resolves.toBe(true);
  });

  it('missing profile row ⇒ save (fail-open)', async () => {
    await expect(shouldSaveContacts(db, { instagramAccountId: ACCT })).resolves.toBe(true);
  });

  it('NULL value ⇒ save (fail-open)', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: null }]);
    await expect(shouldSaveContacts(db, { instagramAccountId: ACCT })).resolves.toBe(true);
  });

  it('missing parent account ⇒ save (fail-open)', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    await expect(shouldSaveContacts(db, { instagramAccountId: 'acct-gone' })).resolves.toBe(true);
  });

  it('DB error reading the profile ⇒ save (fail-open)', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    fake.failNextQuery('profiles', { message: 'boom' });
    await expect(shouldSaveContacts(db, { instagramAccountId: ACCT })).resolves.toBe(true);
  });

  it('DB error reading the parent ⇒ save (fail-open)', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    fake.failNextQuery('instagram_accounts', { message: 'boom' });
    await expect(shouldSaveContacts(db, { instagramAccountId: ACCT })).resolves.toBe(true);
  });
});

describe('record functions honour the toggle', () => {
  beforeEach(() => {
    fake.replaceRows('instagram_accounts', []);
    fake.replaceRows('facebook_pages', []);
    fake.replaceRows('profiles', []);
    fake.replaceRows('contacts', []);
    fake.clearRpcHandlers();
    seedParents();
  });

  it('IG: OFF ⇒ record_contact_interaction RPC never fires', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    let rpcCalls = 0;
    fake.setRpcHandler('record_contact_interaction', () => {
      rpcCalls += 1;
      return { data: null, error: null };
    });
    recordContactInteraction({
      instagramAccountId: ACCT,
      audienceIgUserId: 'IG-FAN',
      triggerType: 'comment',
      automationId: 'auto-1',
    });
    await flush();
    expect(rpcCalls).toBe(0);
  });

  it('IG: ON ⇒ record_contact_interaction RPC fires', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: true }]);
    let rpcCalls = 0;
    fake.setRpcHandler('record_contact_interaction', () => {
      rpcCalls += 1;
      return { data: null, error: null };
    });
    recordContactInteraction({
      instagramAccountId: ACCT,
      audienceIgUserId: 'IG-FAN',
      triggerType: 'comment',
      automationId: 'auto-1',
    });
    await flush();
    expect(rpcCalls).toBe(1);
  });

  it('FB: OFF ⇒ record_fb_contact_interaction RPC never fires', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    let rpcCalls = 0;
    fake.setRpcHandler('record_fb_contact_interaction', () => {
      rpcCalls += 1;
      return { data: null, error: null };
    });
    recordFacebookContactInteraction({
      facebookPageId: PAGE,
      audienceIgUserId: 'FB-FAN',
      triggerType: 'comment',
      automationId: 'auto-1',
    });
    await flush();
    expect(rpcCalls).toBe(0);
  });

  it('FB: ON ⇒ record_fb_contact_interaction RPC fires', async () => {
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: true }]);
    let rpcCalls = 0;
    fake.setRpcHandler('record_fb_contact_interaction', () => {
      rpcCalls += 1;
      return { data: null, error: null };
    });
    recordFacebookContactInteraction({
      facebookPageId: PAGE,
      audienceIgUserId: 'FB-FAN',
      triggerType: 'comment',
      automationId: 'auto-1',
    });
    await flush();
    expect(rpcCalls).toBe(1);
  });
});

describe('GET / PATCH /api/contacts/settings', () => {
  beforeEach(() => {
    fake.replaceRows('profiles', []);
    fake.clearRpcHandlers();
    mockAuth.mockReset();
  });

  afterEach(() => {
    mockAuth.mockReset();
  });

  it('GET unauthenticated ⇒ 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/contacts/settings'));
    expect(res.status).toBe(401);
  });

  it('GET returns the stored value', async () => {
    mockAuth.mockResolvedValue(OWNER);
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: false }]);
    const res = await GET(new Request('http://localhost/api/contacts/settings'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ saveContacts: false });
  });

  it('GET missing profile ⇒ true (fail-open)', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const res = await GET(new Request('http://localhost/api/contacts/settings'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ saveContacts: true });
  });

  it('PATCH unauthenticated ⇒ 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(
      new Request('http://localhost/api/contacts/settings', {
        method: 'PATCH',
        body: JSON.stringify({ saveContacts: false }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('PATCH non-boolean ⇒ 400 and nothing saved', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const res = await PATCH(
      new Request('http://localhost/api/contacts/settings', {
        method: 'PATCH',
        body: JSON.stringify({ saveContacts: 'off' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(fake.rows('profiles')).toHaveLength(0);
  });

  it('PATCH persists the value and returns it', async () => {
    mockAuth.mockResolvedValue(OWNER);
    fake.replaceRows('profiles', [{ id: OWNER.id, save_contacts: true }]);
    const res = await PATCH(
      new Request('http://localhost/api/contacts/settings', {
        method: 'PATCH',
        body: JSON.stringify({ saveContacts: false }),
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ saveContacts: false });
    expect(fake.rows('profiles')[0]!['save_contacts']).toBe(false);
  });

  it('PATCH creates the profiles row when it does not exist', async () => {
    mockAuth.mockResolvedValue(OWNER);
    const res = await PATCH(
      new Request('http://localhost/api/contacts/settings', {
        method: 'PATCH',
        body: JSON.stringify({ saveContacts: false }),
      }),
    );
    expect(res.status).toBe(200);
    expect(fake.rows('profiles')).toHaveLength(1);
    expect(fake.rows('profiles')[0]!['save_contacts']).toBe(false);
  });
});

describe('migration + UI source pins', () => {
  it('migration adds save_contacts DEFAULT true on profiles', () => {
    const sql = readFileSync(
      path.join(
        __dirname,
        '..',
        'supabase',
        'migrations',
        '20261127000001_add_save_contacts_to_profiles.sql',
      ),
      'utf8',
    );
    expect(sql).toContain('save_contacts');
    expect(sql).toContain('DEFAULT true');
    expect(sql).toContain('public.profiles');
  });

  it('ContactsList renders a "Save contacts" switch', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'automations', 'ContactsList.tsx'),
      'utf8',
    );
    expect(src).toContain('Save contacts');
    expect(src).toContain('role="switch"');
    expect(src).toContain('DMs still send');
  });
});
