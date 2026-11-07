/**
 * Area 6 — Debug log tenant isolation (src/app/api/debug/events/route.ts).
 * Auth + service client are mocked against the fake; the assertions check
 * both the returned data AND the exact user_id filter the route queries
 * carry (the route is the enforcement layer - the table is service-role
 * only with no user RLS policies).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

import { GET, DELETE } from '@/app/api/debug/events/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);

const USER_A = { id: 'user-a', email: 'a@example.com' };
const USER_B = { id: 'user-b', email: 'b@example.com' };

function seedEvents(): void {
  fake.replaceRows('debug_events', [
    { id: 'e1', user_id: 'user-a', event_type: 'dm_sent', created_at: '2026-11-05T10:00:00Z' },
    { id: 'e2', user_id: 'user-a', event_type: 'comment_match', created_at: '2026-11-05T09:00:00Z' },
    { id: 'e3', user_id: 'user-b', event_type: 'dm_sent', created_at: '2026-11-05T11:00:00Z' },
    { id: 'e4', user_id: null, event_type: 'webhook_received', created_at: '2026-11-05T12:00:00Z' },
  ]);
}

beforeEach(() => {
  fake.calls.length = 0;
  seedEvents();
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
});

describe('GET /api/debug/events', () => {
  it("returns ONLY the caller's events (other tenants' and ownerless rows hidden)", async () => {
    mockAuth.mockResolvedValue(USER_A);
    const res = await GET(new Request('https://app.opendm.in/api/debug/events'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ id: string }> };
    expect(body.events.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('scopes the query with .eq(user_id, caller id)', async () => {
    mockAuth.mockResolvedValue(USER_B);
    await GET(new Request('https://app.opendm.in/api/debug/events'));
    const select = fake.callsFor('debug_events', 'select')[0]!;
    expect(select.filters).toContainEqual({ column: 'user_id', op: 'eq', value: 'user-b' });
  });

  it('rejects unauthenticated callers with 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(new Request('https://app.opendm.in/api/debug/events'));
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/debug/events', () => {
  it("deletes only the caller's rows; other tenants' and ownerless rows survive", async () => {
    mockAuth.mockResolvedValue(USER_A);
    const res = await DELETE(new Request('https://app.opendm.in/api/debug/events'));
    expect(res.status).toBe(200);
    expect(fake.rows('debug_events').map((r) => r['id']).sort()).toEqual(['e3', 'e4']);
    const del = fake.callsFor('debug_events', 'delete')[0]!;
    expect(del.filters).toContainEqual({ column: 'user_id', op: 'eq', value: 'user-a' });
  });
});
