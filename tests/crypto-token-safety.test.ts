/**
 * Phase 10.3 §4 — Encryption & token-safety (src/lib/crypto.ts `encrypt` /
 * `decrypt`, AES-256-GCM) plus the env gate (src/lib/env.ts `getEnv`) and
 * one decrypt-error consumer (src/lib/settings.ts `getMetaSettings`).
 *
 * SYNTHETIC MATERIAL ONLY: every key in this file is generated in-test with
 * `randomBytes(32)` (or built from a repeated synthetic hex pair); every
 * plaintext is a synthetic marker string. No production key, no production
 * ciphertext, and `.env.local` is never read — env tests set synthetic
 * values on `process.env` directly and restore them afterwards.
 *
 * Existing coverage this file EXTENDS (not duplicates):
 *  - tests/crypto-webhook.test.ts — hmacSha256Hex / safeCompare only;
 *    it never calls encrypt/decrypt.
 *  - tests/oauth-callback.test.ts — happy-path only: decrypts a token the
 *    route just encrypted with the same key ('ab'.repeat(32)).
 *  - tests/parity-*.test.ts — use encrypt() only to seed fixtures.
 * Until this file, nothing tested wrong-key, malformed ciphertext/key,
 * missing key, or failure-path non-destructiveness for encrypt/decrypt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encrypt, decrypt } from '@/lib/crypto';
import { FakeSupabase } from './helpers/fakeSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));

// ── Synthetic keys (fresh per run; never a real key) ────────────────────────
function syntheticKey(): string {
  return randomBytes(32).toString('hex'); // 64 hex chars = 32 bytes
}
const KEY_A = syntheticKey();
let KEY_B = syntheticKey();
while (KEY_B === KEY_A) KEY_B = syntheticKey();

const KEY_ERROR = 'Encryption key must be exactly 32 bytes (64 hex characters)';
const SECRET_PLAINTEXT = 'SYNTHETIC-SECRET-MARKER-do-not-leak-0123456789';

/** Capture a synchronous throw, asserting it is a standard Error instance. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('expected the function to throw, but it returned');
}

/** An error must never carry key material or plaintext. */
function expectCleanError(err: Error, ...forbidden: string[]): void {
  for (const marker of forbidden) {
    expect(err.message).not.toContain(marker);
  }
  expect(err.message).not.toContain(KEY_A);
  expect(err.message).not.toContain(KEY_B);
}

// ── 1. Round-trip ────────────────────────────────────────────────────────────
describe('encrypt → decrypt round-trip (synthetic key)', () => {
  const payloads: Array<[string, string]> = [
    ['short token', 'synthetic-token'],
    ['empty plaintext', ''],
    ['long plaintext (10k chars)', 'SyntheticLong-'.repeat(700)],
    ['unicode plaintext', '🔐 токен — テスト ✓ café'],
  ];

  it.each(payloads)('returns the original plaintext: %s', (_label, plaintext) => {
    expect(decrypt(encrypt(plaintext, KEY_A), KEY_A)).toBe(plaintext);
  });

  it('produces the documented iv_hex:ciphertext_hex:authtag_hex format (12-byte IV, 16-byte tag)', () => {
    const stored = encrypt('format-check', KEY_A);
    expect(stored).toMatch(/^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/);
  });

  it('uses a fresh IV per call: same plaintext encrypts differently and both copies decrypt', () => {
    const first = encrypt('same-plaintext', KEY_A);
    const second = encrypt('same-plaintext', KEY_A);
    expect(first).not.toBe(second);
    expect(decrypt(first, KEY_A)).toBe('same-plaintext');
    expect(decrypt(second, KEY_A)).toBe('same-plaintext');
  });
});

// ── 2. Wrong key ─────────────────────────────────────────────────────────────
describe('wrong key (GCM authentication failure)', () => {
  it('decrypt with a different synthetic key throws', () => {
    const stored = encrypt(SECRET_PLAINTEXT, KEY_A);
    const err = captureError(() => decrypt(stored, KEY_B));
    expect(err.message).toMatch(/authenticate|auth/i);
  });

  it('the wrong-key error contains no key, no plaintext and no token material', () => {
    const stored = encrypt(SECRET_PLAINTEXT, KEY_A);
    const err = captureError(() => decrypt(stored, KEY_B));
    expectCleanError(err, SECRET_PLAINTEXT, stored);
  });
});

// ── 3. Non-destructiveness ───────────────────────────────────────────────────
describe('non-destructiveness after a failed decrypt', () => {
  it('pure function level: the stored ciphertext is unchanged and still decrypts with the right key', () => {
    const stored = encrypt(SECRET_PLAINTEXT, KEY_A);
    const snapshot = stored.slice();

    captureError(() => decrypt(stored, KEY_B)); // wrong key
    const [iv, ct, tag] = stored.split(':') as [string, string, string];
    const tamperedTag = (tag.startsWith('0') ? '1' : '0') + tag.slice(1);
    captureError(() => decrypt(`${iv}:${ct}:${tamperedTag}`, KEY_A)); // tampered
    captureError(() => decrypt('garbage', KEY_A)); // malformed

    expect(stored).toBe(snapshot); // value untouched by every failure
    expect(decrypt(stored, KEY_A)).toBe(SECRET_PLAINTEXT); // and still usable
  });
});

// Consumer level: getMetaSettings() catches decrypt errors (settings.ts).
// The service client is the FakeSupabase (existing tests/helpers style);
// env comes from the REAL getEnv fed with synthetic process.env values.
const SYNTH_ENV: Record<string, string> = {
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-key-0123456789',
  CRON_SECRET: 'synthetic-cron-secret-0123456789',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.invalid',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-anon-key-0123456789',
};
const TOUCHED_ENV = [...Object.keys(SYNTH_ENV), 'TOKEN_ENCRYPTION_KEY'];
const savedEnv: Record<string, string | undefined> = {};

function applySyntheticEnv(tokenKey: string): void {
  for (const [k, v] of Object.entries(SYNTH_ENV)) process.env[k] = v;
  process.env['TOKEN_ENCRYPTION_KEY'] = tokenKey;
}

async function loadSettings(fake: FakeSupabase) {
  vi.resetModules();
  const svc = await import('@/lib/supabase/service');
  vi.mocked(svc.createServiceClient).mockImplementation(
    () => fake as unknown as SupabaseClient
  );
  return import('@/lib/settings');
}

function seedSettingsRow(fake: FakeSupabase, encryptedSecret: string): void {
  fake.seed('app_settings', [
    {
      id: 1,
      meta_app_id: '123456789012',
      meta_app_secret_encrypted: encryptedSecret,
      meta_fb_app_secret_encrypted: null,
      webhook_verify_token: 'synthetic-verify-token',
      setup_completed: true,
    },
  ]);
}

describe('consumer non-destructiveness — getMetaSettings with an undecryptable stored secret', () => {
  beforeEach(() => {
    for (const k of TOUCHED_ENV) savedEnv[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of TOUCHED_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  it('returns null, invokes NO write path, and leaves the stored ciphertext byte-identical', async () => {
    const fake = new FakeSupabase();
    // Stored under KEY_A …
    const stored = encrypt(SECRET_PLAINTEXT, KEY_A);
    seedSettingsRow(fake, stored);
    // … but the instance now runs with KEY_B (key rotation / wrong key).
    applySyntheticEnv(KEY_B);
    const settings = await loadSettings(fake);

    const consoleSpies = (['log', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );

    await expect(settings.getMetaSettings()).resolves.toBeNull();

    // No write of any kind was invoked against any table.
    const writes = fake.calls.filter((c) => c.op !== 'select');
    expect(writes).toEqual([]);
    // The stored row is untouched.
    const row = fake.rows('app_settings')[0]!;
    expect(row['meta_app_secret_encrypted']).toBe(stored);

    // Log hygiene on this failure path: nothing logged carries secrets.
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        const rendered = JSON.stringify(call);
        expect(rendered).not.toContain(KEY_A);
        expect(rendered).not.toContain(KEY_B);
        expect(rendered).not.toContain(SECRET_PLAINTEXT);
      }
    }
  });

  it('positive control: with the matching key the same consumer returns the decrypted secret', async () => {
    const fake = new FakeSupabase();
    seedSettingsRow(fake, encrypt(SECRET_PLAINTEXT, KEY_A));
    applySyntheticEnv(KEY_A);
    const settings = await loadSettings(fake);

    const result = await settings.getMetaSettings();
    expect(result?.metaAppSecret).toBe(SECRET_PLAINTEXT);
    expect(result?.metaAppId).toBe('123456789012');
  });
});

// ── 4. Malformed ciphertext ──────────────────────────────────────────────────
describe('malformed ciphertext — every variant throws a controlled Error', () => {
  const valid = encrypt(SECRET_PLAINTEXT, KEY_A);
  const [iv, ct, tag] = valid.split(':') as [string, string, string];
  const flipFirstHex = (hex: string) => (hex.startsWith('0') ? '1' : '0') + hex.slice(1);

  const cases: Array<[string, string]> = [
    ['truncated (auth tag cut short)', valid.slice(0, valid.length - 10)],
    ['garbage with no separators', '!!!not-a-ciphertext!!!'],
    ['garbage non-hex segments', 'zz:zz:zz'],
    ['only two segments', `${iv}:${ct}`],
    ['four segments', `${iv}:${ct}:${tag}:extra`],
    ['empty string', ''],
    ['wrong IV length — too short (1 byte)', `00:${ct}:${tag}`],
    ['wrong IV length — too long (24 bytes)', `${iv}${'aa'.repeat(12)}:${ct}:${tag}`],
    ['empty IV segment', `:${ct}:${tag}`],
    ['tampered auth tag', `${iv}:${ct}:${flipFirstHex(tag)}`],
    ['tampered ciphertext body', `${iv}:${flipFirstHex(ct)}:${tag}`],
  ];

  it.each(cases)('throws: %s', (_label, malformed) => {
    const err = captureError(() => decrypt(malformed, KEY_A));
    expectCleanError(err, SECRET_PLAINTEXT);
  });
});

// ── 5. Missing key — fail closed ─────────────────────────────────────────────
describe('missing key — fail closed, never silently proceed', () => {
  it('encrypt/decrypt with an empty-string key throw the key error', () => {
    expect(captureError(() => encrypt('x', '')).message).toBe(KEY_ERROR);
    const stored = encrypt('x', KEY_A);
    expect(captureError(() => decrypt(stored, '')).message).toBe(KEY_ERROR);
  });

  it('encrypt/decrypt with an undefined key throw the key error (no TypeError leak, no proceed)', () => {
    const missing = undefined as unknown as string;
    expect(captureError(() => encrypt('x', missing)).message).toBe(KEY_ERROR);
    const stored = encrypt('x', KEY_A);
    expect(captureError(() => decrypt(stored, missing)).message).toBe(KEY_ERROR);
  });

  describe('env layer — real getEnv()', () => {
    beforeEach(() => {
      for (const k of TOUCHED_ENV) savedEnv[k] = process.env[k];
    });
    afterEach(() => {
      for (const k of TOUCHED_ENV) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it('TOKEN_ENCRYPTION_KEY unset → getEnv throws and names the variable (not any value)', async () => {
      for (const [k, v] of Object.entries(SYNTH_ENV)) process.env[k] = v;
      delete process.env['TOKEN_ENCRYPTION_KEY'];
      vi.resetModules();
      const { getEnv } = await import('@/lib/env');
      const err = captureError(() => getEnv());
      expect(err.message).toContain('TOKEN_ENCRYPTION_KEY');
    });

    it('TOKEN_ENCRYPTION_KEY empty → getEnv throws', async () => {
      applySyntheticEnv('');
      vi.resetModules();
      const { getEnv } = await import('@/lib/env');
      expect(captureError(() => getEnv()).message).toContain('TOKEN_ENCRYPTION_KEY');
    });

    it('positive control: a synthetic 64-hex key passes getEnv validation', async () => {
      applySyntheticEnv(KEY_A);
      vi.resetModules();
      const { getEnv } = await import('@/lib/env');
      expect(getEnv().TOKEN_ENCRYPTION_KEY).toBe(KEY_A);
    });
  });
});

// ── 6. Malformed key — rejected at key parse ─────────────────────────────────
describe('malformed key — throws at key parse', () => {
  const malformedKeys: Array<[string, string]> = [
    ['non-hex letters (64 chars)', 'g'.repeat(64)],
    ['non-hex pairs (64 chars)', 'zz'.repeat(32)],
    ['symbol characters (64 chars)', '!'.repeat(64)],
    ['hex but too short (32 chars / 16 bytes)', 'ab'.repeat(16)],
    ['hex but 62 chars (31 bytes)', 'a'.repeat(62)],
    ['hex but 66 chars (33 bytes)', 'a'.repeat(66)],
    ['odd-length hex (63 chars)', 'a'.repeat(63)],
    // Regression cases: a valid 64-hex prefix with trailing garbage used to
    // be silently ACCEPTED, because Buffer.from(_, 'hex') stops decoding at
    // the first non-hex pair and the decoded length still came out 32.
    ['valid 64 hex + trailing non-hex garbage', `${KEY_A}zz`],
    ['valid 64 hex + trailing space', `${KEY_A} `],
  ];

  it.each(malformedKeys)('encrypt throws the key error: %s', (_label, badKey) => {
    expect(captureError(() => encrypt('x', badKey)).message).toBe(KEY_ERROR);
  });

  it('decrypt rejects a malformed key before touching the ciphertext', () => {
    const stored = encrypt('x', KEY_A);
    expect(captureError(() => decrypt(stored, 'zz'.repeat(32))).message).toBe(KEY_ERROR);
    expect(captureError(() => decrypt(stored, `${KEY_A}zz`)).message).toBe(KEY_ERROR);
  });

  it('uppercase 64-hex is a valid key (env regex is case-insensitive) and round-trips', () => {
    const upper = KEY_A.toUpperCase();
    expect(decrypt(encrypt('case-check', upper), upper)).toBe('case-check');
    // Same bytes as the lowercase form.
    expect(decrypt(encrypt('case-check', KEY_A), upper)).toBe('case-check');
  });
});

// ── 7. No fallback / default key (source scan, ai-mixed-scope style) ────────
const SRC_ROOT = path.resolve(__dirname, '..', 'src');

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('no fallback / default key exists in the candidate source', () => {
  it('no file under src/ contains a hardcoded 64-hex string (a baked-in key literal)', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (/[0-9a-fA-F]{64}/.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('crypto.ts takes the key only as a parameter: it never reads process.env and has no || / ?? fallback', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib', 'crypto.ts'), 'utf8');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('TOKEN_ENCRYPTION_KEY');
  });

  it('env.ts declares TOKEN_ENCRYPTION_KEY as required (regex-validated, no .default / .optional)', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib', 'env.ts'), 'utf8');
    const field = src.slice(src.indexOf('TOKEN_ENCRYPTION_KEY: z'), src.indexOf('CRON_SECRET'));
    expect(field).toContain('.regex(/^[0-9a-f]{64}$/i');
    expect(field).not.toContain('.default');
    expect(field).not.toContain('.optional');
    // The value is read straight from the environment — no fallback operator.
    const assignment = src
      .split('\n')
      .find((line) => line.includes("process.env['TOKEN_ENCRYPTION_KEY']"));
    expect(assignment).toBeDefined();
    expect(assignment).not.toContain('||');
    expect(assignment).not.toContain('??');
  });
});

// ── 8. Log / error hygiene ───────────────────────────────────────────────────
describe('log / error hygiene on failure paths', () => {
  it('crypto.ts and settings.ts contain no logging calls at all (nothing to leak through)', () => {
    const cryptoSrc = fs.readFileSync(path.join(SRC_ROOT, 'lib', 'crypto.ts'), 'utf8');
    const settingsSrc = fs.readFileSync(path.join(SRC_ROOT, 'lib', 'settings.ts'), 'utf8');
    for (const src of [cryptoSrc, settingsSrc]) {
      expect(src).not.toContain('console.');
      expect(src).not.toContain('createLogger');
    }
  });

  it('no console output is produced by any crypto failure path, and no error carries secrets', () => {
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    try {
      const stored = encrypt(SECRET_PLAINTEXT, KEY_A);
      const failures: Array<() => unknown> = [
        () => decrypt(stored, KEY_B),
        () => decrypt('garbage', KEY_A),
        () => decrypt(stored.slice(0, -10), KEY_A),
        () => encrypt(SECRET_PLAINTEXT, ''),
        () => encrypt(SECRET_PLAINTEXT, 'zz'.repeat(32)),
      ];
      for (const fail of failures) {
        expectCleanError(captureError(fail), SECRET_PLAINTEXT, stored);
      }
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const rendered = JSON.stringify(call);
          expect(rendered).not.toContain(KEY_A);
          expect(rendered).not.toContain(KEY_B);
          expect(rendered).not.toContain(SECRET_PLAINTEXT);
        }
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
