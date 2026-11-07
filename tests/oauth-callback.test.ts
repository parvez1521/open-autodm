/**
 * Area 4 — OAuth account ownership (src/app/api/instagram/callback/route.ts).
 * The REAL route handler is invoked with mocked dependencies: Meta settings,
 * the Instagram OAuth/API modules (no network), the debug logger, env, and
 * the service client (backed by the in-memory fake). Token encryption is the
 * REAL AES-256-GCM code with a test key.
 *
 * Regression target (Phase C Fix 1): a connect for an IG account already
 * owned by a DIFFERENT user must be rejected with zero writes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';
import { decrypt } from '@/lib/crypto';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32); // 64 hex chars = 32-byte test key
const CALLER_ID = 'caller-user-id';
const IG_ID = 'IG-100';

vi.mock('@/lib/settings', () => ({
  getMetaSettings: async () => ({
    metaAppId: '1586956306036999',
    metaAppSecret: 'app-secret',
    metaFbAppSecret: null,
    webhookVerifyToken: 'token',
    setupCompleted: true,
  }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/instagram/oauth', () => ({
  verifyOAuthState: vi.fn(),
  exchangeCodeForToken: async () => ({ access_token: 'short-lived-token' }),
  exchangeForLongLivedToken: async () => ({ access_token: 'long-lived-token', expires_in: 5184000 }),
  getInstagramProfile: async () => ({
    user_id: 'IG-100',
    username: 'creator',
    name: 'Creator',
    profile_picture_url: null,
  }),
}));
vi.mock('@/lib/instagram/api', () => ({ subscribeToWebhookFields: vi.fn(async () => {}) }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getAppUrl: () => 'https://app.opendm.in',
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
}));

import { GET } from '@/app/api/instagram/callback/route';
import { verifyOAuthState } from '@/lib/instagram/oauth';
import { subscribeToWebhookFields } from '@/lib/instagram/api';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockVerifyState = vi.mocked(verifyOAuthState);
const mockSubscribe = vi.mocked(subscribeToWebhookFields);

function callbackRequest(): Request {
  return new Request('https://app.opendm.in/api/instagram/callback?code=auth-code&state=state-jwt');
}

function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.replaceRows('instagram_accounts', []);
  fake.replaceRows('profiles', []);
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockVerifyState.mockReset();
  mockVerifyState.mockResolvedValue({ userId: CALLER_ID });
  mockSubscribe.mockClear();
});

describe('GET /api/instagram/callback ownership guard', () => {
  it('REJECTS a foreign-owned account: redirect error + zero writes of any kind', async () => {
    fake.seed('instagram_accounts', [
      { id: 'row-foreign', user_id: 'someone-else', instagram_user_id: IG_ID, username: 'creator' },
    ]);
    const res = await GET(callbackRequest());
    expect(res.status).toBe(302);
    expect(location(res)).toContain('instagram_error=account_already_connected');

    // No takeover: no insert, no update, not even the profiles backfill.
    expect(fake.callsFor('instagram_accounts', 'insert')).toHaveLength(0);
    expect(fake.callsFor('instagram_accounts', 'update')).toHaveLength(0);
    expect(fake.callsFor('profiles')).toHaveLength(0);
    expect(mockSubscribe).not.toHaveBeenCalled();

    // The original row is untouched and still belongs to its owner.
    const row = fake.rows('instagram_accounts')[0]!;
    expect(row['user_id']).toBe('someone-else');
  });

  it('same-owner reconnect: updates tokens in place, addressed by row id', async () => {
    fake.seed('instagram_accounts', [
      {
        id: 'row-own',
        user_id: CALLER_ID,
        instagram_user_id: IG_ID,
        username: 'old-name',
        access_token_encrypted: 'old-token-value',
      },
    ]);
    const res = await GET(callbackRequest());
    expect(location(res)).toContain('instagram_connected=true');

    expect(fake.callsFor('instagram_accounts', 'insert')).toHaveLength(0);
    const updates = fake.callsFor('instagram_accounts', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toContainEqual({ column: 'id', op: 'eq', value: 'row-own' });

    const row = fake.rows('instagram_accounts')[0]!;
    expect(row['user_id']).toBe(CALLER_ID);
    // The stored token is the NEW long-lived token, AES-256-GCM encrypted.
    expect(decrypt(row['access_token_encrypted'] as string, TOKEN_KEY)).toBe('long-lived-token');
    expect(mockSubscribe).toHaveBeenCalledWith(IG_ID, 'long-lived-token');
  });

  it('first-time connect: inserts a new row owned by the caller', async () => {
    const res = await GET(callbackRequest());
    expect(location(res)).toContain('instagram_connected=true');
    expect(fake.callsFor('instagram_accounts', 'insert')).toHaveLength(1);
    const row = fake.rows('instagram_accounts')[0]!;
    expect(row['user_id']).toBe(CALLER_ID);
    expect(row['instagram_user_id']).toBe(IG_ID);
    expect(decrypt(row['access_token_encrypted'] as string, TOKEN_KEY)).toBe('long-lived-token');
  });

  it('insert race lost to a FOREIGN winner (23505): rejected, winner untouched, no blind upsert', async () => {
    fake.failNextInsert(
      'instagram_accounts',
      { message: 'duplicate key value violates unique constraint', code: '23505' },
      { id: 'row-winner', user_id: 'someone-else', instagram_user_id: IG_ID, username: 'creator' }
    );
    const res = await GET(callbackRequest());
    expect(location(res)).toContain('instagram_error=account_already_connected');
    expect(fake.callsFor('instagram_accounts', 'update')).toHaveLength(0);
    expect(fake.rows('instagram_accounts')[0]!['user_id']).toBe('someone-else');
  });

  it('insert race lost to the SAME caller (23505): falls back to the id-addressed update', async () => {
    fake.failNextInsert(
      'instagram_accounts',
      { message: 'duplicate key value violates unique constraint', code: '23505' },
      { id: 'row-winner', user_id: CALLER_ID, instagram_user_id: IG_ID, username: 'creator' }
    );
    const res = await GET(callbackRequest());
    expect(location(res)).toContain('instagram_connected=true');
    const updates = fake.callsFor('instagram_accounts', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toContainEqual({ column: 'id', op: 'eq', value: 'row-winner' });
  });
});
