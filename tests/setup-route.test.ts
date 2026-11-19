/**
 * Area 5 — Setup endpoint authorization (src/app/api/setup/route.ts) +
 * instance-owner resolution (src/lib/owner.ts). Auth, settings and the
 * service client are mocked; the owner guard under test is the REAL code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';
import { isInstanceOwner, isOwnerConfigured } from '@/lib/owner';

const fake = new FakeSupabase();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn(), saveMetaSettings: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getAppUrl: () => 'https://app.opendm.in',
  getEnv: () => ({}),
}));

import { GET, POST } from '@/app/api/setup/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { getMetaSettings, saveMetaSettings } from '@/lib/settings';
import { createServiceClient } from '@/lib/supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockGetSettings = vi.mocked(getMetaSettings);
const mockSaveSettings = vi.mocked(saveMetaSettings);

const OWNER = { id: 'owner-user-id', email: 'owner@example.com' };
const OTHER = { id: 'other-user-id', email: 'other@example.com' };

const VALID_BODY = { metaAppId: '123456789012', metaAppSecret: 'a'.repeat(32) };

function postBody(body: Record<string, unknown>): Request {
  return new Request('https://app.opendm.in/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRequest(): Request {
  return postBody(VALID_BODY);
}

function seedSettings(setupCompleted: boolean, encryptedSecret?: string): void {
  fake.replaceRows('app_settings', [
    {
      id: 1,
      meta_app_id: '123456789012',
      ...(encryptedSecret ? { meta_app_secret_encrypted: encryptedSecret } : {}),
      webhook_verify_token: 'live-verify-token',
      setup_completed: setupCompleted,
    },
  ]);
}

const ENV_KEYS = ['OWNER_USER_ID', 'OWNER_EMAIL'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  fake.calls.length = 0;
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
  mockSaveSettings.mockClear();
  mockSaveSettings.mockResolvedValue(undefined);
  mockGetSettings.mockReset();
  mockGetSettings.mockResolvedValue({
    metaAppId: '123456789012',
    metaAppSecret: 'secret',
    metaFbAppSecret: null,
    webhookVerifyToken: 'live-verify-token',
    setupCompleted: true,
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('isInstanceOwner (lib/owner.ts)', () => {
  it('matches by OWNER_USER_ID when set', () => {
    process.env['OWNER_USER_ID'] = OWNER.id;
    expect(isInstanceOwner(OWNER)).toBe(true);
    expect(isInstanceOwner(OTHER)).toBe(false);
  });

  it('OWNER_USER_ID takes priority: an email match does NOT grant ownership when an ID is set', () => {
    process.env['OWNER_USER_ID'] = OWNER.id;
    process.env['OWNER_EMAIL'] = OTHER.email;
    expect(isInstanceOwner(OTHER)).toBe(false);
  });

  it('falls back to OWNER_EMAIL, matched case-insensitively', () => {
    process.env['OWNER_EMAIL'] = 'Owner@Example.com';
    expect(isInstanceOwner(OWNER)).toBe(true);
    expect(isInstanceOwner(OTHER)).toBe(false);
  });

  it('fails closed when no owner is configured: nobody is the owner', () => {
    expect(isOwnerConfigured()).toBe(false);
    expect(isInstanceOwner(OWNER)).toBe(false);
    expect(isInstanceOwner(OTHER)).toBe(false);
  });
});

describe('POST /api/setup', () => {
  it('rejects a non-owner with 403 once setup is complete (and writes nothing)', async () => {
    seedSettings(true);
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockAuth.mockResolvedValue(OTHER);
    const res = await POST(postRequest());
    expect(res.status).toBe(403);
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });

  it('allows the configured owner to rotate credentials after completion', async () => {
    seedSettings(true);
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockAuth.mockResolvedValue(OWNER);
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    // The existing webhook verify token is preserved across the save.
    expect(mockSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ webhookVerifyToken: 'live-verify-token' })
    );
  });

  it('fails closed with 403 for EVERYONE when setup is complete but no owner env is configured', async () => {
    seedSettings(true);
    mockAuth.mockResolvedValue(OWNER);
    const res = await POST(postRequest());
    expect(res.status).toBe(403);
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });

  it('allows any authenticated user during first run (setup not yet complete)', async () => {
    seedSettings(false);
    mockAuth.mockResolvedValue(OTHER);
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it('omitting metaAppSecret preserves the existing encrypted secret and sets metaFbAppSecret', async () => {
    // The live case (2026-11-19): the stored IG secret verifies webhook
    // signatures and must survive a save that only sets the FB secret.
    seedSettings(true, 'existing-encrypted-ig-secret');
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockAuth.mockResolvedValue(OWNER);
    const res = await POST(
      postBody({ metaAppId: '1586956306036999', metaFbAppSecret: 'b'.repeat(32) })
    );
    expect(res.status).toBe(200);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(mockSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        metaAppId: '1586956306036999',
        metaAppSecretEncrypted: 'existing-encrypted-ig-secret',
        metaFbAppSecret: 'b'.repeat(32),
      })
    );
    // No plaintext IG secret is passed through on the preserve path.
    expect(mockSaveSettings.mock.calls[0]?.[0]?.metaAppSecret).toBeUndefined();
  });

  it('an empty-string metaAppSecret (what the wizard sends when blank) also preserves', async () => {
    seedSettings(true, 'existing-encrypted-ig-secret');
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockAuth.mockResolvedValue(OWNER);
    const res = await POST(postBody({ metaAppId: '1586956306036999', metaAppSecret: '' }));
    expect(res.status).toBe(200);
    expect(mockSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ metaAppSecretEncrypted: 'existing-encrypted-ig-secret' })
    );
  });

  it('omitting metaAppSecret with no existing secret returns 400 (first setup still requires it)', async () => {
    seedSettings(false);
    mockAuth.mockResolvedValue(OTHER);
    const res = await POST(postBody({ metaAppId: '123456789012' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Meta App Secret is required for first-time setup/);
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });

  it('providing metaAppSecret overwrites as before (no preserve passthrough)', async () => {
    seedSettings(true, 'existing-encrypted-ig-secret');
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockAuth.mockResolvedValue(OWNER);
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mockSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ metaAppSecret: 'a'.repeat(32) })
    );
    expect(mockSaveSettings.mock.calls[0]?.[0]?.metaAppSecretEncrypted).toBeUndefined();
  });

  it('rejects unauthenticated callers with 401', async () => {
    seedSettings(false);
    mockAuth.mockResolvedValue(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
  });
});

describe('GET /api/setup', () => {
  it('redacts webhookVerifyToken for a non-owner once setup is complete', async () => {
    seedSettings(true);
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockAuth.mockResolvedValue(OTHER);
    const res = await GET(new Request('https://app.opendm.in/api/setup'));
    const body = (await res.json()) as { webhookVerifyToken: string | null; metaAppId: string | null };
    expect(body.webhookVerifyToken).toBeNull();
    // Phase B (2026-11-10): metaAppId is owner-only too — redacted for
    // non-owner authenticated callers (was visible to any signed-in user).
    expect(body.metaAppId).toBeNull();
  });

  it('returns the token to the owner once setup is complete', async () => {
    seedSettings(true);
    process.env['OWNER_USER_ID'] = OWNER.id;
    mockAuth.mockResolvedValue(OWNER);
    const res = await GET(new Request('https://app.opendm.in/api/setup'));
    const body = (await res.json()) as { webhookVerifyToken: string | null; metaAppId: string | null };
    expect(body.webhookVerifyToken).toBe('live-verify-token');
    // Owner response unchanged by Phase B: the app ID stays visible.
    expect(body.metaAppId).toBe('123456789012');
  });

  it('returns the token during first run (wizard needs it before completion)', async () => {
    seedSettings(false);
    mockAuth.mockResolvedValue(OTHER);
    const res = await GET(new Request('https://app.opendm.in/api/setup'));
    const body = (await res.json()) as { webhookVerifyToken: string | null };
    expect(body.webhookVerifyToken).toBe('live-verify-token');
  });

  it('returns facebookOAuthRedirectUri alongside the Instagram one', async () => {
    seedSettings(true);
    mockAuth.mockResolvedValue(OTHER);
    const res = await GET(new Request('https://app.opendm.in/api/setup'));
    const body = (await res.json()) as {
      oauthRedirectUri: string;
      facebookOAuthRedirectUri: string;
    };
    expect(body.oauthRedirectUri).toBe('https://app.opendm.in/api/instagram/callback');
    expect(body.facebookOAuthRedirectUri).toBe('https://app.opendm.in/api/facebook/callback');
  });
});
