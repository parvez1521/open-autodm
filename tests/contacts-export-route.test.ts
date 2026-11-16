/**
 * GET /api/contacts/export — CSV download (owner decision,
 * 2026-11-17). Pins: same auth + tenancy discipline as the list
 * route (own accounts only, workspace-scoped, fail closed without
 * a workspace context), the exact CSV shape, and — the point of
 * the endpoint — NO silent truncation: the page loop returns
 * every row even past the list route's 500-row cap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET as exportGET } from '@/app/api/contacts/export/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'acct-a';
const ACCT_B = 'acct-b';

const OWNER_A = { id: 'user-owner-a', email: 'oa@example.com' };
const MEMBER_A = { id: 'user-member-a', email: 'ma@example.com' };
const OUTSIDER = { id: 'user-outsider', email: 'out@example.com' };

const HEADER =
  'username,audience_ig_user_id,follows_business,first_interaction_at,last_interaction_at,last_trigger_type,total_triggers';

function seedAll(): void {
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS_A, user_id: OWNER_A.id, role: 'owner' },
    { workspace_id: WS_A, user_id: MEMBER_A.id, role: 'member' },
  ]);
  fake.replaceRows('instagram_accounts', [
    { id: ACCT_A, user_id: OWNER_A.id, workspace_id: WS_A, username: 'acct-a', name: 'A', is_active: true },
    { id: ACCT_B, user_id: 'user-owner-b', workspace_id: WS_B, username: 'acct-b', name: 'B', is_active: true },
  ]);
  fake.replaceRows('contacts', [
    {
      id: 'contact-a1', workspace_id: WS_A, instagram_account_id: ACCT_A,
      username: 'a-friend', audience_ig_user_id: '1001', follows_business: true,
      first_interaction_at: '2026-11-05T09:00:00Z', last_interaction_at: '2026-11-05T10:00:00Z',
      last_trigger_type: 'comment', total_triggers: 3,
    },
    {
      id: 'contact-a2', workspace_id: WS_A, instagram_account_id: ACCT_A,
      username: 'weird, "name"', audience_ig_user_id: '1002', follows_business: false,
      first_interaction_at: '2026-11-05T09:30:00Z', last_interaction_at: '2026-11-06T10:00:00Z',
      last_trigger_type: 'dm', total_triggers: 1,
    },
    {
      id: 'contact-b1', workspace_id: WS_B, instagram_account_id: ACCT_B,
      username: 'b-friend', audience_ig_user_id: '2001', follows_business: true,
      first_interaction_at: '2026-11-05T09:00:00Z', last_interaction_at: '2026-11-05T11:00:00Z',
      last_trigger_type: 'comment', total_triggers: 2,
    },
  ]);
}

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  fake.calls.length = 0;
  seedAll();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedFlag;
});

async function csvBody(res: Response): Promise<string> {
  return res.text();
}

describe('contacts export (workspace mode)', () => {
  beforeEach(() => {
    process.env['WORKSPACE_RUNTIME_ENABLED'] = 'true';
  });

  it("member downloads only the selected workspace's contacts as CSV", async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await exportGET(new Request(`https://app.opendm.in/api/contacts/export?workspace=${WS_A}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="contacts-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = await csvBody(res);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe(HEADER);
    // Last-interaction desc: the newer a2 row first, then a1.
    expect(lines[1]).toContain('1002');
    expect(lines[2]).toBe(
      'a-friend,1001,true,2026-11-05T09:00:00Z,2026-11-05T10:00:00Z,comment,3',
    );
    expect(text).not.toContain('b-friend');
    expect(text).not.toContain('2001');
  });

  it('escapes hostile usernames in the CSV', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await exportGET(new Request(`https://app.opendm.in/api/contacts/export?workspace=${WS_A}`));
    const text = await csvBody(res);
    expect(text).toContain('"weird, ""name""",1002,false,2026-11-05T09:30:00Z,2026-11-06T10:00:00Z,dm,1');
  });

  it("A's account id addressed under B-scoped request ⇒ 404; non-member ⇒ 403", async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const foreign = await exportGET(
      new Request(`https://app.opendm.in/api/contacts/export?workspace=${WS_A}&accountId=${ACCT_B}`),
    );
    expect(foreign.status).toBe(404);

    mockAuth.mockResolvedValue(OUTSIDER);
    const denied = await exportGET(
      new Request(`https://app.opendm.in/api/contacts/export?workspace=${WS_A}`),
    );
    expect(denied.status).toBe(403);
  });

  it('missing workspace selector fails closed (no silent legacy fallback)', async () => {
    mockAuth.mockResolvedValue(MEMBER_A);
    const res = await exportGET(new Request('https://app.opendm.in/api/contacts/export'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('workspace-context-required');
  });

  it('unauthenticated ⇒ 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await exportGET(new Request(`https://app.opendm.in/api/contacts/export?workspace=${WS_A}`));
    expect(res.status).toBe(401);
  });
});

describe('contacts export (legacy mode)', () => {
  beforeEach(() => {
    delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  });

  it("owner downloads only their own accounts' contacts", async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await exportGET(new Request('https://app.opendm.in/api/contacts/export'));
    expect(res.status).toBe(200);
    const text = await csvBody(res);
    expect(text.split('\r\n')[0]).toBe(HEADER);
    expect(text).toContain('a-friend');
    expect(text).not.toContain('b-friend');
  });

  it('foreign accountId ⇒ 404', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    const res = await exportGET(
      new Request(`https://app.opendm.in/api/contacts/export?accountId=${ACCT_B}`),
    );
    expect(res.status).toBe(404);
  });

  it('unauthenticated ⇒ 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await exportGET(new Request('https://app.opendm.in/api/contacts/export'));
    expect(res.status).toBe(401);
  });

  it('exports every row past the list cap — no silent truncation', async () => {
    mockAuth.mockResolvedValue(OWNER_A);
    // 1,005 contacts: past both the list route's 500-row cap and
    // one 1,000-row export page, so a single-page export would
    // silently drop rows.
    const many = Array.from({ length: 1005 }, (_, i) => ({
      id: `contact-many-${i}`,
      workspace_id: WS_A,
      instagram_account_id: ACCT_A,
      username: `user-${i}`,
      audience_ig_user_id: `${3000 + i}`,
      follows_business: i % 2 === 0,
      first_interaction_at: '2026-11-05T09:00:00Z',
      last_interaction_at: `2026-11-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      last_trigger_type: 'comment',
      total_triggers: 1,
    }));
    fake.replaceRows('contacts', many);
    const res = await exportGET(new Request('https://app.opendm.in/api/contacts/export'));
    expect(res.status).toBe(200);
    const lines = (await csvBody(res)).split('\r\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines.length).toBe(1 + 1005);
    expect(lines.some((l) => l.startsWith('user-0,'))).toBe(true);
    expect(lines.some((l) => l.startsWith('user-1004,'))).toBe(true);
  });
});
