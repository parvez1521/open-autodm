/**
 * Separate Instagram app ID (2026-11-24).
 *
 * Regression target: the site stored ONE meta_app_id used by both OAuth
 * flows, but Instagram and Facebook need DIFFERENT IDs. Instagram
 * Business Login (instagram.com/oauth/authorize + the
 * api.instagram.com token exchange) requires the INSTAGRAM app ID
 * 1121249884134177 and rejects the Meta app ID 1586956306036999 with
 * "Invalid platform app". Facebook Login for Business needs the Meta
 * app ID. On 2026-11-19 the stored value was changed 1121→1586 to fix
 * the Facebook connect, which silently broke the Instagram connect.
 *
 * The fix: a separate meta_instagram_app_id (settings.instagramAppId)
 * used ONLY by the Instagram authorize URL and token exchange; the
 * Facebook flow keeps metaAppId untouched. Missing IG id fails closed.
 *
 * Real IDs are pinned here (they are public app identifiers, not
 * secrets). Mocked Supabase only (FakeSupabase harness); no .env file
 * is read: getEnv is mocked to a synthetic key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';

const TOKEN_KEY = 'ab'.repeat(32); // synthetic 64-hex test key
const IG_APP_ID = '1121249884134177';
const META_APP_ID = '1586956306036999';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  getAppUrl: () => 'https://app.opendm.in',
}));
vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

import { createServiceClient } from '@/lib/supabase/service';
import { getAuthenticatedUser } from '@/lib/auth';
import { getMetaSettings, saveMetaSettings, invalidateSettingsCache } from '@/lib/settings';
import { buildOAuthUrl, exchangeCodeForToken } from '@/lib/instagram/oauth';
import { buildFacebookOAuthUrl } from '@/lib/facebook/oauth';
import { GET as connectGET } from '@/app/api/instagram/connect/route';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockService = vi.mocked(createServiceClient);

function appRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 1,
    meta_app_id: META_APP_ID,
    meta_instagram_app_id: IG_APP_ID,
    meta_app_secret_encrypted: encrypt('ig-secret-xyz', TOKEN_KEY),
    meta_fb_app_secret_encrypted: null,
    webhook_verify_token: 'verify-token',
    setup_completed: true,
    ...overrides,
  };
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.replaceRows('app_settings', []);
  fake.replaceRows('platform_config', []);
  invalidateSettingsCache();
  mockService.mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ id: 'user-1', email: 'owner@example.com' } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Instagram authorize URL carries the Instagram app ID', () => {
  it('buildOAuthUrl with the Instagram app ID sends client_id=1121…', () => {
    const url = new URL(buildOAuthUrl(IG_APP_ID, 'https://app.opendm.in/api/instagram/callback', 'state'));
    expect(url.hostname).toBe('www.instagram.com');
    expect(url.searchParams.get('client_id')).toBe(IG_APP_ID);
  });

  it('the Meta app ID is NOT a valid Instagram client_id (the 2026-11-19 breakage)', () => {
    const url = new URL(buildOAuthUrl(META_APP_ID, 'https://app.opendm.in/api/instagram/callback', 'state'));
    // This is what Instagram rejects with "Invalid platform app" — the
    // URL builder itself takes any ID, so the guard lives in the connect
    // route (tested below), which must never pass the Meta app ID here.
    expect(url.searchParams.get('client_id')).toBe(META_APP_ID);
  });
});

describe('Instagram token exchange carries the Instagram app ID', () => {
  it('exchangeCodeForToken posts client_id=1121… (multipart form)', async () => {
    let capturedBody: unknown;
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: unknown }) => {
        capturedUrl = url;
        capturedBody = init.body;
        return { ok: true, json: async () => ({ access_token: 'short-token', user_id: '1' }) };
      })
    );
    const token = await exchangeCodeForToken('code', IG_APP_ID, 'secret', 'https://app.opendm.in/api/instagram/callback');
    expect(token.access_token).toBe('short-token');
    expect(capturedUrl).toBe('https://api.instagram.com/oauth/access_token');
    expect((capturedBody as FormData).get('client_id')).toBe(IG_APP_ID);
  });
});

describe('Facebook authorize URL still carries the Meta app ID', () => {
  it('buildFacebookOAuthUrl with the Meta app ID sends client_id=1586…', () => {
    const url = new URL(buildFacebookOAuthUrl(META_APP_ID, 'https://app.opendm.in/api/facebook/callback', 'state'));
    expect(url.hostname).toBe('www.facebook.com');
    expect(url.searchParams.get('client_id')).toBe(META_APP_ID);
  });
});

describe('getMetaSettings maps the separate Instagram app ID', () => {
  it('returns instagramAppId from the app_settings row (platform_config absent)', async () => {
    fake.seed('app_settings', [appRow()]);
    const settings = await getMetaSettings();
    expect(settings?.metaAppId).toBe(META_APP_ID);
    expect(settings?.instagramAppId).toBe(IG_APP_ID);
  });

  it('returns instagramAppId null for a pre-migration row without the column', async () => {
    const { meta_instagram_app_id: _dropped, ...row } = appRow();
    void _dropped;
    fake.seed('app_settings', [row]);
    const settings = await getMetaSettings();
    expect(settings?.metaAppId).toBe(META_APP_ID);
    expect(settings?.instagramAppId).toBeNull();
  });
});

describe('saveMetaSettings preserves the Instagram app ID when omitted', () => {
  it('a save without metaInstagramAppId leaves the stored value untouched', async () => {
    fake.seed('app_settings', [appRow()]);
    await saveMetaSettings({
      metaAppId: META_APP_ID,
      metaAppSecret: 'rotated-secret',
      webhookVerifyToken: 'verify-token',
    });
    const row = fake.rows('app_settings')[0]!;
    expect(row['meta_instagram_app_id']).toBe(IG_APP_ID);
  });

  it('a save WITH metaInstagramAppId stores the new value', async () => {
    fake.seed('app_settings', [appRow({ meta_instagram_app_id: null })]);
    await saveMetaSettings({
      metaAppId: META_APP_ID,
      metaInstagramAppId: IG_APP_ID,
      metaAppSecret: 'rotated-secret',
      webhookVerifyToken: 'verify-token',
    });
    const row = fake.rows('app_settings')[0]!;
    expect(row['meta_instagram_app_id']).toBe(IG_APP_ID);
  });
});

describe('GET /api/instagram/connect uses the Instagram app ID and fails closed', () => {
  it('issues an authorize URL with client_id=1121… (never the Meta app ID)', async () => {
    fake.seed('app_settings', [appRow()]);
    const res = await connectGET(new Request('https://app.opendm.in/api/instagram/connect'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    const url = new URL(body.url);
    expect(url.searchParams.get('client_id')).toBe(IG_APP_ID);
    expect(body.url).not.toContain(META_APP_ID);
  });

  it('missing Instagram app ID fails closed with setup_required (no URL issued)', async () => {
    const { meta_instagram_app_id: _dropped, ...row } = appRow();
    void _dropped;
    fake.seed('app_settings', [row]);
    const res = await connectGET(new Request('https://app.opendm.in/api/instagram/connect'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('setup_required');
  });
});
