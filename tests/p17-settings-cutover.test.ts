/**
 * Programme 17 / Workstream D — Settings cutover review (Claim 8).
 *
 * Pins the CURRENT behaviour of src/lib/settings.ts exactly as found,
 * including behaviour this review flags as risky. Pinning a behaviour
 * is NOT endorsing it: the split-brain and total-fallback tests below
 * are the regression evidence for the owner decisions in
 * saas/phase17-work/D-settings.md. No write-path change is made here.
 *
 * Mocked Supabase only (FakeSupabase harness + one hand stub for a
 * throwing client). Synthetic keys/secrets only. No .env file is read:
 * getEnv is mocked to a repeated synthetic hex pair.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt, decrypt } from '@/lib/crypto';

const TOKEN_KEY = 'ab'.repeat(32); // synthetic 64-hex test key
const OTHER_KEY = 'cd'.repeat(32);

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  getAppUrl: () => 'https://app.opendm.in',
}));

import { createServiceClient } from '@/lib/supabase/service';
import { getMetaSettings, saveMetaSettings, invalidateSettingsCache } from '@/lib/settings';

const mockService = vi.mocked(createServiceClient);
const fake = new FakeSupabase();

function appRow(appId = 'app-123', secret = 'app-secret-xyz', overrides: FakeRow = {}): FakeRow {
  return {
    id: 1,
    meta_app_id: appId,
    meta_app_secret_encrypted: encrypt(secret, TOKEN_KEY),
    meta_fb_app_secret_encrypted: null,
    webhook_verify_token: 'verify-app',
    setup_completed: true,
    ...overrides,
  };
}
function platformRow(appId = 'platform-456', secret = 'platform-secret-xyz', overrides: FakeRow = {}): FakeRow {
  return { ...appRow(appId, secret), webhook_verify_token: 'verify-platform', secret_key_version: 1, ...overrides };
}
function seedApp(appId?: string, secret?: string, overrides: FakeRow = {}): void {
  fake.seed('app_settings', [appRow(appId, secret, overrides)]);
}
function seedPlatform(appId?: string, secret?: string, overrides: FakeRow = {}): void {
  fake.seed('platform_config', [platformRow(appId, secret, overrides)]);
}

beforeEach(() => {
  fake.calls.length = 0;
  for (const t of ['app_settings', 'platform_config', 'workspace_settings', 'workspace_memberships']) {
    fake.replaceRows(t, []);
  }
  mockService.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockService.mockImplementation(() => fake as any);
  invalidateSettingsCache();
});

// ── READ path: platform-first ───────────────────────────────────────────────
describe('P17 settings READ path — platform_config first', () => {
  it('platform-only settings: complete platform row, no app row → platform value, app never queried', async () => {
    seedPlatform();
    const s = await getMetaSettings();
    expect(s?.metaAppId).toBe('platform-456');
    expect(s?.metaAppSecret).toBe('platform-secret-xyz');
    expect(s?.webhookVerifyToken).toBe('verify-platform');
    expect(fake.calls[0]?.table).toBe('platform_config');
    expect(fake.callsFor('app_settings')).toHaveLength(0);
  });

  it('both complete → platform wins over app_settings', async () => {
    seedApp(); seedPlatform();
    const s = await getMetaSettings();
    expect(s?.metaAppId).toBe('platform-456');
  });

  it('(a) platform row absent → app_settings value', async () => {
    seedApp();
    expect((await getMetaSettings())?.metaAppId).toBe('app-123');
    expect(fake.calls.map((c) => c.table)).toEqual(['platform_config', 'app_settings']);
  });

  it('(a) platform seeded EMPTY row (…000025 INSERT id=1, all credential columns NULL) → app value', async () => {
    seedApp();
    fake.seed('platform_config', [{
      id: 1, meta_app_id: null, meta_app_secret_encrypted: null,
      meta_fb_app_secret_encrypted: null, webhook_verify_token: null,
      setup_completed: false, secret_key_version: 1,
    }]);
    expect((await getMetaSettings())?.metaAppId).toBe('app-123');
  });

  it.each([
    ['missing app secret', { meta_app_secret_encrypted: null }],
    ['missing verify token', { webhook_verify_token: null }],
    ['empty-string app id', { meta_app_id: '' }],
    ['missing app id', { meta_app_id: null }],
  ])('(d) platform row incomplete/malformed — %s → falls back to app_settings', async (_l, over) => {
    seedApp(); seedPlatform('platform-456', 'platform-secret-xyz', over as FakeRow);
    expect((await getMetaSettings())?.metaAppId).toBe('app-123');
  });

  it('(d) platform secret undecryptable (encrypted under a different key / malformed) → rowToSettings null → app fallback', async () => {
    seedApp();
    fake.seed('platform_config', [platformRow('platform-456', 'x', {
      meta_app_secret_encrypted: encrypt('platform-secret-xyz', OTHER_KEY),
    })]);
    const s = await getMetaSettings();
    expect(s?.metaAppId).toBe('app-123');
    expect(s?.metaAppSecret).toBe('app-secret-xyz');
  });

  it('no rows anywhere → null', async () => {
    await expect(getMetaSettings()).resolves.toBeNull();
  });
});

// ── READ fallback failure classes ───────────────────────────────────────────
describe('P17 settings READ fallback — failure classes pinned (Claim 8: ANY failure)', () => {
  it.each([
    ['(b) table missing — relation does not exist', { message: 'relation "platform_config" does not exist', code: '42P01' }],
    ['(c) permission / authorization denied', { message: 'permission denied for table platform_config', code: '42501' }],
    ['(c) PostgREST schema-cache miss', { message: 'Could not find the table in the schema cache', code: 'PGRST205' }],
    ['(c) statement timeout', { message: 'canceling statement due to statement timeout', code: '57014' }],
    ['(c) generic internal DB error', { message: 'boom', code: 'XX000' }],
  ])('%s → silently serves app_settings', async (_l, err) => {
    seedApp(); seedPlatform();
    fake.failNextQuery('platform_config', err as { message: string; code: string });
    const s = await getMetaSettings();
    // PINNED RISK: even an authorization error (42501) is indistinguishable
    // in this code path from a benign pre-migration absence.
    expect(s?.metaAppId).toBe('app-123');
    expect(s?.metaAppSecret).toBe('app-secret-xyz');
  });

  it('(c) platform client THROWS (exception, not PostgREST error object) → catch → app fallback', async () => {
    const app = appRow();
    const stub = {
      from(table: string) {
        const chain = {
          select: () => chain, eq: () => chain,
          maybeSingle: async () => {
            if (table === 'platform_config') throw new Error('SYNTHETIC platform timeout');
            return { data: app, error: null };
          },
        };
        return chain;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockService.mockImplementation(() => stub as any);
    expect((await getMetaSettings())?.metaAppId).toBe('app-123');
  });

  it('platform fails AND app_settings fails → null (no throw, no stale value)', async () => {
    seedApp();
    fake.failNextQuery('platform_config', { message: 'boom', code: 'XX000' });
    fake.failNextQuery('app_settings', { message: 'boom-app', code: 'XX000' });
    await expect(getMetaSettings()).resolves.toBeNull();
  });

  it('app_settings error alone (platform absent) → null', async () => {
    seedApp();
    fake.failNextQuery('app_settings', { message: 'boom', code: 'XX000' });
    await expect(getMetaSettings()).resolves.toBeNull();
  });

  it('CACHE staleness: a fallback result is cached 60s — platform repaired in the TTL window is NOT re-read', async () => {
    seedApp();
    fake.failNextQuery('platform_config', { message: 'boom', code: 'XX000' });
    expect((await getMetaSettings())?.metaAppId).toBe('app-123');
    seedPlatform(); // platform now healthy and complete
    // No invalidation: the cached fallback value is still served.
    expect((await getMetaSettings())?.metaAppId).toBe('app-123');
    invalidateSettingsCache();
    expect((await getMetaSettings())?.metaAppId).toBe('platform-456');
  });

  it('CACHE staleness: platform value cached, underlying rows change → cached value served until invalidation', async () => {
    seedPlatform();
    expect((await getMetaSettings())?.metaAppSecret).toBe('platform-secret-xyz');
    fake.replaceRows('platform_config', [platformRow('platform-999', 'rotated-secret')]);
    expect((await getMetaSettings())?.metaAppSecret).toBe('platform-secret-xyz');
    invalidateSettingsCache();
    expect((await getMetaSettings())?.metaAppSecret).toBe('rotated-secret');
  });
});

// ── workspace_settings: does anything read it? ──────────────────────────────
const SRC_ROOT = path.resolve(__dirname, '..', 'src');
function collectSrc(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) collectSrc(f, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(f);
  }
  return out;
}

describe('P17 workspace-owned settings — workspace_settings read path', () => {
  it('SOURCE: no file under src/ reads workspace_settings at all', () => {
    const offenders = collectSrc(SRC_ROOT).filter((f) =>
      fs.readFileSync(f, 'utf8').includes('workspace_settings'));
    expect(offenders).toEqual([]);
  });

  it('getMetaSettings takes NO workspace context (arity 0) and never queries workspace_settings', async () => {
    expect(getMetaSettings.length).toBe(0);
    seedApp();
    fake.seed('workspace_settings', [{
      workspace_id: 'ws-1', timezone: 'Asia/Kolkata', ai_drafting_enabled: false,
      script_writer_enabled: false, default_public_reply_enabled: true,
    }]);
    const s = await getMetaSettings();
    expect(s?.metaAppId).toBe('app-123'); // global Meta settings, unaffected by the workspace row
    expect(fake.callsFor('workspace_settings')).toHaveLength(0);
  });

  it('missing workspace context is a non-concept here: no context → same global result, not null/error', async () => {
    seedPlatform();
    await expect(getMetaSettings()).resolves.toMatchObject({ metaAppId: 'platform-456' });
  });

  it('multi-workspace user: memberships in 2 workspaces + per-workspace rows change nothing (singleton result)', async () => {
    seedApp(); seedPlatform();
    fake.seed('workspace_memberships', [
      { workspace_id: 'ws-1', user_id: 'user-1', role: 'owner' },
      { workspace_id: 'ws-2', user_id: 'user-1', role: 'owner' },
    ]);
    fake.seed('workspace_settings', [
      { workspace_id: 'ws-1', timezone: 'UTC' },
      { workspace_id: 'ws-2', timezone: 'Asia/Kolkata' },
    ]);
    const first = await getMetaSettings();
    invalidateSettingsCache();
    const second = await getMetaSettings();
    expect(first).toEqual(second);
    expect(first?.metaAppId).toBe('platform-456');
    expect(fake.callsFor('workspace_settings')).toHaveLength(0);
    expect(fake.callsFor('workspace_memberships')).toHaveLength(0);
  });
});

// ── WRITE path: characterize, do not change ─────────────────────────────────
describe('P17 settings WRITE path — current behaviour characterized', () => {
  it('saveMetaSettings writes ONLY app_settings (upsert id=1, encrypted, setup_completed=true); no platform/workspace write', async () => {
    await saveMetaSettings({
      metaAppId: '999888', metaAppSecret: 'new-secret-marker',
      metaFbAppSecret: 'fb-secret-marker', webhookVerifyToken: 'verify-new',
    });
    const writes = fake.calls.filter((c) => c.op !== 'select');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.table).toBe('app_settings');
    expect(writes[0]?.op).toBe('upsert');
    const row = fake.rows('app_settings')[0]!;
    expect(row['meta_app_id']).toBe('999888');
    expect(row['setup_completed']).toBe(true);
    expect(row['meta_app_secret_encrypted']).not.toContain('new-secret-marker');
    expect(decrypt(row['meta_app_secret_encrypted'] as string, TOKEN_KEY)).toBe('new-secret-marker');
    expect(decrypt(row['meta_fb_app_secret_encrypted'] as string, TOKEN_KEY)).toBe('fb-secret-marker');
    expect(fake.rows('platform_config')).toHaveLength(0);
    expect(fake.rows('workspace_settings')).toHaveLength(0);
  });

  it('SPLIT-BRAIN PIN: with a complete platform row present, a save is SHADOWED — read still returns the OLD platform value', async () => {
    seedApp('app-old', 'app-old-secret');
    seedPlatform('platform-old', 'platform-old-secret');
    await saveMetaSettings({
      metaAppId: 'brand-new', metaAppSecret: 'brand-new-secret', webhookVerifyToken: 'verify-new',
    });
    // The write landed in app_settings…
    expect(fake.rows('app_settings')[0]?.['meta_app_id']).toBe('brand-new');
    // …the platform row is untouched…
    expect(fake.rows('platform_config')[0]?.['meta_app_id']).toBe('platform-old');
    // …and the reader (which prefers platform, cache busted by save) returns the OLD platform value.
    // A credential rotation through the Setup Wizard would therefore appear to succeed while
    // webhook verification keeps using the pre-rotation platform credentials.
    const s = await getMetaSettings();
    expect(s?.metaAppId).toBe('platform-old');
    expect(s?.metaAppSecret).toBe('platform-old-secret');
  });

  it('app-only deployment: save DOES take effect on next read (cache busted by save)', async () => {
    seedApp('app-old', 'app-old-secret');
    expect((await getMetaSettings())?.metaAppId).toBe('app-old');
    await saveMetaSettings({
      metaAppId: 'app-new', metaAppSecret: 'app-new-secret', webhookVerifyToken: 'verify-app',
    });
    expect((await getMetaSettings())?.metaAppId).toBe('app-new');
  });

  it('save error propagates as "Failed to save settings: …" and the message carries no plaintext secret', async () => {
    fake.failNextQuery('app_settings', { message: 'SYNTHETIC db write boom', code: 'XX000' });
    let thrown: Error | null = null;
    try {
      await saveMetaSettings({
        metaAppId: '12345', metaAppSecret: 'do-not-leak-secret-marker', webhookVerifyToken: 'v',
      });
    } catch (e) { thrown = e as Error; }
    expect(thrown?.message).toContain('Failed to save settings:');
    expect(thrown?.message).not.toContain('do-not-leak-secret-marker');
  });

  it('UNAUTHORIZED-WRITE CHARACTERIZATION: settings.ts itself has NO auth/owner/workspace gate — direct call succeeds with no user at all', async () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib', 'settings.ts'), 'utf8');
    expect(src).not.toContain('getAuthenticatedUser');
    expect(src).not.toContain('isInstanceOwner');
    expect(src).not.toContain('workspace_settings');
    expect(src).not.toContain('workspaceId');
    expect(src).not.toContain('workspace_id');
    // No authenticated user exists in this test process, yet the library-level write succeeds.
    // Enforcement lives ONLY in the calling route (see next test) — any future caller that
    // forgets that gate inherits an ungated credential write.
    await expect(saveMetaSettings({
      metaAppId: '555', metaAppSecret: 'direct-write-secret', webhookVerifyToken: 'v',
    })).resolves.toBeUndefined();
    expect(fake.rows('app_settings')).toHaveLength(1);
  });

  it('the ONLY write gate is in src/app/api/setup/route.ts (auth + owner-after-completion, fail-closed)', () => {
    const route = fs.readFileSync(path.join(SRC_ROOT, 'app', 'api', 'setup', 'route.ts'), 'utf8');
    expect(route).toContain('getAuthenticatedUser');
    expect(route).toContain('isInstanceOwner(user)');
    expect(route).toContain('setup_completed');
    expect(route).toContain('status: 403');
    // And it is the sole saveMetaSettings caller in src/.
    const callers = collectSrc(SRC_ROOT).filter((f) =>
      fs.readFileSync(f, 'utf8').includes('saveMetaSettings('));
    expect(callers.map((f) => path.relative(SRC_ROOT, f)).sort())
      .toEqual(['app/api/setup/route.ts', 'lib/settings.ts']);
  });
});
