/**
 * App settings service - the self-hoster's Meta app credentials.
 *
 * Credentials are entered once through the Setup Wizard and stored in the
 * single-row app_settings table. The App Secret is AES-256-GCM encrypted with
 * TOKEN_ENCRYPTION_KEY before insert and decrypted only here, at read time.
 *
 * A short in-memory cache keeps webhook signature verification fast without
 * re-querying the DB on every event (serverless instances are reused).
 */

import { createServiceClient } from '@/lib/supabase/service';
import { decrypt, encrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';

export interface MetaSettings {
  metaAppId: string;
  metaAppSecret: string; // decrypted - never log
  /**
   * Optional Facebook App Secret. Meta signs webhooks with the Instagram app
   * secret for IG-Login apps but the Facebook app secret for FB-Login apps -
   * verification accepts a signature matching either.
   */
  metaFbAppSecret: string | null;
  webhookVerifyToken: string;
  setupCompleted: boolean;
}

interface SettingsRow {
  meta_app_id: string | null;
  meta_app_secret_encrypted: string | null;
  meta_fb_app_secret_encrypted: string | null;
  webhook_verify_token: string | null;
  setup_completed: boolean;
  /** platform_config only (…000025); app_settings has no such column. */
  secret_key_version?: number | null;
}

const SETTINGS_COLUMNS =
  'meta_app_id, meta_app_secret_encrypted, meta_fb_app_secret_encrypted, webhook_verify_token, setup_completed';
const PLATFORM_CONFIG_COLUMNS = `${SETTINGS_COLUMNS}, secret_key_version`;

const CACHE_TTL_MS = 60_000;
// Phase D1 / B1 note: this cache holds the SINGLE platform-level Meta
// configuration (one Meta app per deployment — platform data, never
// tenant data). Caching it is safe across workspaces: no per-workspace
// value ever enters this module's read path.
let cache: { value: MetaSettings | null; at: number } | null = null;

/** Decrypts a settings row into MetaSettings, or null when unusable. */
function rowToSettings(data: SettingsRow): MetaSettings | null {
  if (!data.meta_app_id || !data.meta_app_secret_encrypted || !data.webhook_verify_token) {
    return null;
  }
  const env = getEnv();
  let secret: string;
  let fbSecret: string | null = null;
  try {
    secret = decrypt(data.meta_app_secret_encrypted, env.TOKEN_ENCRYPTION_KEY);
    if (data.meta_fb_app_secret_encrypted) {
      fbSecret = decrypt(data.meta_fb_app_secret_encrypted, env.TOKEN_ENCRYPTION_KEY);
    }
  } catch {
    // TOKEN_ENCRYPTION_KEY changed after setup - treat as not configured
    return null;
  }
  return {
    metaAppId: data.meta_app_id,
    metaAppSecret: secret,
    metaFbAppSecret: fbSecret,
    webhookVerifyToken: data.webhook_verify_token,
    setupCompleted: data.setup_completed,
  };
}

/** Returns decrypted Meta settings, or null if setup has not been completed. */
export async function getMetaSettings(): Promise<MetaSettings | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const db = createServiceClient();

  // B1 runtime half (Phase D1): platform_config (…000025) is the successor
  // home of the platform-level Meta credentials, so it is read FIRST.
  // ANY failure or absence — table missing on pre-…000025 deployments,
  // PostgREST error, no row, incomplete row — falls back to app_settings,
  // which remains the live source on every current deployment (and in the
  // FakeSupabase test harness). The fallback is deliberately total: a
  // platform_config problem must never take webhook verification down.
  try {
    const { data, error } = await db
      .from('platform_config')
      .select(PLATFORM_CONFIG_COLUMNS)
      .eq('id', 1)
      .maybeSingle<SettingsRow>();
    if (!error && data) {
      const fromPlatform = rowToSettings(data);
      if (fromPlatform) {
        cache = { value: fromPlatform, at: Date.now() };
        return fromPlatform;
      }
      // A present-but-incomplete platform row is NOT authoritative yet
      // (…000025 seeds an empty id=1 row) — fall through to app_settings.
    }
  } catch {
    // Treat any platform_config read failure as "use app_settings".
  }

  const { data, error } = await db
    .from('app_settings')
    .select(SETTINGS_COLUMNS)
    .eq('id', 1)
    .maybeSingle<SettingsRow>();

  if (error || !data) {
    cache = { value: null, at: Date.now() };
    return null;
  }

  const value = rowToSettings(data);
  cache = { value, at: Date.now() };
  return value;
}

export async function saveMetaSettings(input: {
  metaAppId: string;
  metaAppSecret: string;
  metaFbAppSecret?: string | null;
  webhookVerifyToken: string;
}): Promise<void> {
  // WRITE PATH UNCHANGED (Phase D1): saves still go to app_settings.
  // getMetaSettings prefers platform_config when a complete row exists,
  // so moving the WRITE target is a separate, gated cutover (backfill +
  // verification) — deliberately NOT done here.
  const env = getEnv();
  const db = createServiceClient();
  const fbSecret = input.metaFbAppSecret?.trim();
  const { error } = await db
    .from('app_settings')
    .upsert(
      {
        id: 1,
        meta_app_id: input.metaAppId.trim(),
        meta_app_secret_encrypted: encrypt(input.metaAppSecret.trim(), env.TOKEN_ENCRYPTION_KEY),
        meta_fb_app_secret_encrypted: fbSecret ? encrypt(fbSecret, env.TOKEN_ENCRYPTION_KEY) : null,
        webhook_verify_token: input.webhookVerifyToken,
        setup_completed: true,
      },
      { onConflict: 'id' }
    );
  if (error) throw new Error(`Failed to save settings: ${error.message}`);
  cache = null; // bust the cache immediately
}

/** Test-only escape hatch: clears the settings cache. */
export function invalidateSettingsCache(): void {
  cache = null;
}
