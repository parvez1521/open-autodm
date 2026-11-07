/**
 * Phase 5 parity — GET /api/activity owner scoping
 * (src/app/api/activity/route.ts), restored in Phase 5 (row 22).
 * Auth + service client are mocked against the fake, following the
 * debug-events-route.test.ts pattern: the route itself is the enforcement
 * layer, so assertions check both the HTTP result AND that another
 * tenant's rows never surface.
 *
 * Covers (k, second half): an accountId the caller does not own is
 * rejected (404), and unscoped reads only ever return the caller's own
 * accounts' activity.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET } from '@/app/api/activity/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const USER_A = { id: 'user-a', email: 'a@example.com' };

function seedActivity(): void {
  fake.replaceRows('instagram_accounts', [
    { id: 'acct-a', user_id: 'user-a', instagram_user_id: 'IG-A' },
    { id: 'acct-b', user_id: 'user-b', instagram_user_id: 'IG-B' },
  ]);
  fake.replaceRows('dm_jobs', [
    {
      id: 'job-a1',
      instagram_account_id: 'acct-a',
      trigger_type: 'comment',
      status: 'sent',
      error_message: null,
      sent_at: '2026-11-05T10:00:00Z',
      created_at: '2026-11-05T10:00:00Z',
      automation_id: 'auto-a',
      automations: { id: 'auto-a', name: 'A automation', type: 'comment_dm' },
    },
    {
      id: 'job-b1',
      instagram_account_id: 'acct-b',
      trigger_type: 'comment',
      status: 'sent',
      error_message: null,
      sent_at: '2026-11-05T11:00:00Z',
      created_at: '2026-11-05T11:00:00Z',
      automation_id: 'auto-b',
      automations: { id: 'auto-b', name: 'B automation', type: 'comment_dm' },
    },
  ]);
  fake.replaceRows('automation_follow_ups', []);
}

beforeEach(() => {
  fake.calls.length = 0;
  seedActivity();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(USER_A);
});

describe('GET /api/activity owner scoping', () => {
  it("rejects an accountId the caller does not own with 404", async () => {
    const res = await GET(new Request('https://app.opendm.in/api/activity?accountId=acct-b'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('not found');
  });

  it("returns activity for the caller's own accountId (200)", async () => {
    const res = await GET(new Request('https://app.opendm.in/api/activity?accountId=acct-a'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ id: string; automationId: string }> };
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]!.automationId).toBe('auto-a');
  });

  it("without an accountId, returns ONLY the caller's accounts' activity", async () => {
    const res = await GET(new Request('https://app.opendm.in/api/activity'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activities: Array<{ automationId: string }> };
    expect(body.activities.map((a) => a.automationId)).toEqual(['auto-a']);
    // The dm_jobs query was restricted to the owned account ids:
    const jobsQuery = fake.callsFor('dm_jobs', 'select')[0]!;
    expect(jobsQuery.filters).toContainEqual({ column: 'instagram_account_id', op: 'in', value: ['acct-a'] });
  });

  it('rejects unauthenticated callers with 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(new Request('https://app.opendm.in/api/activity'));
    expect(res.status).toBe(401);
  });
});
