/**
 * Phase D2 / Programme 16 — tenant-aware envelope encryption tests
 * (src/lib/crypto/envelope.ts).
 *
 * SYNTHETIC MATERIAL ONLY: every master key and DEK in this file is
 * generated in-test with `randomBytes`; every plaintext is a synthetic
 * marker string. No production key, no production ciphertext, and no
 * .env file is ever read — the module under test never reads env at
 * all (keys arrive as caller-supplied parameters).
 *
 * The last describe block pins an honesty property: the LEGACY
 * src/lib/crypto.ts `iv:ct:tag` format is NOT a valid envelope.
 * Compatibility between the two schemes is explicitly NOT claimed —
 * existing ciphertext stays on the legacy scheme until a separately
 * gated re-encryption project (see
 * saas/PHASE_16_ENCRYPTION_AND_STORAGE.md).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  generateTenantDek,
  encryptForTenant,
  decryptForTenant,
  EnvelopeError,
} from '@/lib/crypto/envelope';
import { encrypt as legacyEncrypt } from '@/lib/crypto';

// ── Synthetic keys (fresh per run; never a real key) ────────────────────────
function syntheticMasterKey(): string {
  return randomBytes(32).toString('hex'); // 64 hex chars = 32 bytes
}
const K1 = syntheticMasterKey();
let K2 = syntheticMasterKey();
while (K2 === K1) K2 = syntheticMasterKey();

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PLAINTEXT = 'SYNTHETIC-TENANT-SECRET-MARKER-0123456789';

function encryptA(plaintext: string = PLAINTEXT, keyId = 'k1', masterKeyHex: string = K1): string {
  return encryptForTenant({ masterKeyHex, keyId, tenantId: TENANT_A, plaintext });
}

function decryptA(envelope: string, keyring: Record<string, string> = { k1: K1 }): string {
  return decryptForTenant({ keyring, tenantId: TENANT_A, envelope });
}

/** Capture an EnvelopeError, asserting its type. */
function captureEnvelopeError(fn: () => unknown): EnvelopeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvelopeError);
    return err as EnvelopeError;
  }
  throw new Error('expected the function to throw, but it returned');
}

/** Decode an envelope's JSON payload (test-side tampering helper). */
function decodePayload(envelope: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(envelope.slice('env1.'.length), 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/** Re-encode a (possibly tampered) payload as an envelope string. */
function encodePayload(payload: Record<string, unknown>): string {
  return 'env1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

const flipFirstHex = (hex: string) => (hex.startsWith('0') ? '1' : '0') + hex.slice(1);

// ── Round-trip ──────────────────────────────────────────────────────────────
describe('envelope round-trip (synthetic keys)', () => {
  it('decrypts back to the original plaintext', () => {
    expect(decryptA(encryptA())).toBe(PLAINTEXT);
  });

  it('round-trips empty and unicode plaintexts', () => {
    expect(decryptA(encryptA(''))).toBe('');
    expect(decryptA(encryptA('🔐 токен — テスト ✓ café'))).toBe('🔐 токен — テスト ✓ café');
  });

  it('produces the documented env1.<base64url(JSON)> format with all fields', () => {
    const envelope = encryptA();
    expect(envelope.startsWith('env1.')).toBe(true);
    const payload = decodePayload(envelope);
    expect(payload['v']).toBe(1);
    expect(payload['tenantId']).toBe(TENANT_A);
    expect(payload['keyId']).toBe('k1');
    const wrapped = payload['wrappedDek'] as Record<string, string>;
    for (const field of ['iv', 'ct', 'tag']) {
      expect(wrapped[field]).toMatch(/^[0-9a-f]+$/);
      expect(payload[field]).toMatch(/^[0-9a-f]+$/);
    }
    // Wrapped DEK ciphertext is exactly the 32-byte DEK.
    expect(wrapped['ct']).toHaveLength(64);
  });

  it('two encryptions of the same plaintext differ (fresh IVs / fresh DEK) and both decrypt', () => {
    const first = encryptA('same-plaintext');
    const second = encryptA('same-plaintext');
    expect(first).not.toBe(second);
    expect(decryptA(first)).toBe('same-plaintext');
    expect(decryptA(second)).toBe('same-plaintext');
  });

  it('an explicitly supplied tenant DEK is honoured and round-trips', () => {
    const dek = generateTenantDek();
    const envelope = encryptForTenant({
      masterKeyHex: K1,
      keyId: 'k1',
      tenantId: TENANT_A,
      plaintext: PLAINTEXT,
      dek,
    });
    expect(decryptA(envelope)).toBe(PLAINTEXT);
  });
});

describe('generateTenantDek', () => {
  it('returns a fresh random 32-byte Buffer per call', () => {
    const a = generateTenantDek();
    const b = generateTenantDek();
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});

// ── Tenant binding ──────────────────────────────────────────────────────────
describe('tenant binding', () => {
  it('cross-tenant decrypt fails with tenant-mismatch (stored-field check, before crypto)', () => {
    const envelope = encryptA();
    const err = captureEnvelopeError(() =>
      decryptForTenant({ keyring: { k1: K1 }, tenantId: TENANT_B, envelope }),
    );
    expect(err.code).toBe('tenant-mismatch');
  });

  it('tenant-mismatch is reported even when the keyring could not decrypt anyway (check order)', () => {
    const envelope = encryptA();
    const err = captureEnvelopeError(() =>
      decryptForTenant({ keyring: {}, tenantId: TENANT_B, envelope }),
    );
    expect(err.code).toBe('tenant-mismatch');
  });

  it('AAD binding: an envelope whose stored tenantId is EDITED to another tenant fails GCM, not succeeds', () => {
    // Attacker transplants tenant A's envelope to tenant B by rewriting
    // the stored tenantId field, then asks for tenant B. The stored-field
    // check now passes (stored === requested), so ONLY the GCM AAD
    // binding can stop this — and it must, with decrypt-failed.
    const payload = decodePayload(encryptA());
    payload['tenantId'] = TENANT_B;
    const transplanted = encodePayload(payload);
    const err = captureEnvelopeError(() =>
      decryptForTenant({ keyring: { k1: K1 }, tenantId: TENANT_B, envelope: transplanted }),
    );
    expect(err.code).toBe('decrypt-failed');
  });

  it('two tenants encrypting the same plaintext under the same master key produce different envelopes, each bound to its own tenant', () => {
    const envA = encryptForTenant({ masterKeyHex: K1, keyId: 'k1', tenantId: TENANT_A, plaintext: 'shared' });
    const envB = encryptForTenant({ masterKeyHex: K1, keyId: 'k1', tenantId: TENANT_B, plaintext: 'shared' });
    expect(envA).not.toBe(envB);
    expect(decryptForTenant({ keyring: { k1: K1 }, tenantId: TENANT_A, envelope: envA })).toBe('shared');
    expect(decryptForTenant({ keyring: { k1: K1 }, tenantId: TENANT_B, envelope: envB })).toBe('shared');
    expect(
      captureEnvelopeError(() =>
        decryptForTenant({ keyring: { k1: K1 }, tenantId: TENANT_B, envelope: envA }),
      ).code,
    ).toBe('tenant-mismatch');
  });
});

// ── Tampering ───────────────────────────────────────────────────────────────
describe('tampering fails closed with decrypt-failed', () => {
  it('tampered wrapped DEK ciphertext fails', () => {
    const payload = decodePayload(encryptA());
    const wrapped = payload['wrappedDek'] as Record<string, string>;
    wrapped['ct'] = flipFirstHex(wrapped['ct']!);
    expect(captureEnvelopeError(() => decryptA(encodePayload(payload))).code).toBe('decrypt-failed');
  });

  it('tampered wrapped DEK auth tag fails', () => {
    const payload = decodePayload(encryptA());
    const wrapped = payload['wrappedDek'] as Record<string, string>;
    wrapped['tag'] = flipFirstHex(wrapped['tag']!);
    expect(captureEnvelopeError(() => decryptA(encodePayload(payload))).code).toBe('decrypt-failed');
  });

  it('tampered data ciphertext fails', () => {
    const payload = decodePayload(encryptA());
    payload['ct'] = flipFirstHex(payload['ct'] as string);
    expect(captureEnvelopeError(() => decryptA(encodePayload(payload))).code).toBe('decrypt-failed');
  });

  it('tampered data auth tag fails', () => {
    const payload = decodePayload(encryptA());
    payload['tag'] = flipFirstHex(payload['tag'] as string);
    expect(captureEnvelopeError(() => decryptA(encodePayload(payload))).code).toBe('decrypt-failed');
  });

  it('wrong master key (right keyId, wrong key material) fails', () => {
    const envelope = encryptA();
    const err = captureEnvelopeError(() => decryptA(envelope, { k1: K2 }));
    expect(err.code).toBe('decrypt-failed');
    expect(err.message).not.toContain(K1);
    expect(err.message).not.toContain(K2);
    expect(err.message).not.toContain(PLAINTEXT);
  });
});

// ── Keyring rotation ────────────────────────────────────────────────────────
describe('keyring rotation', () => {
  it('encrypt under k1 → rotate to k2 for new envelopes → old envelope still decrypts with {k1,k2}', () => {
    const oldEnvelope = encryptA(PLAINTEXT, 'k1', K1);
    const newEnvelope = encryptA(PLAINTEXT, 'k2', K2);
    const keyring = { k1: K1, k2: K2 };
    expect(decryptForTenant({ keyring, tenantId: TENANT_A, envelope: oldEnvelope })).toBe(PLAINTEXT);
    expect(decryptForTenant({ keyring, tenantId: TENANT_A, envelope: newEnvelope })).toBe(PLAINTEXT);
    expect(decodePayload(oldEnvelope)['keyId']).toBe('k1');
    expect(decodePayload(newEnvelope)['keyId']).toBe('k2');
  });

  it('old envelope fails as unknown-key-id once k1 leaves the keyring', () => {
    const oldEnvelope = encryptA(PLAINTEXT, 'k1', K1);
    const err = captureEnvelopeError(() =>
      decryptForTenant({ keyring: { k2: K2 }, tenantId: TENANT_A, envelope: oldEnvelope }),
    );
    expect(err.code).toBe('unknown-key-id');
  });

  it('an envelope naming a keyId nobody holds fails as unknown-key-id', () => {
    const envelope = encryptA(PLAINTEXT, 'k-retired', K1);
    expect(captureEnvelopeError(() => decryptA(envelope, { k1: K1 })).code).toBe('unknown-key-id');
  });
});

// ── Malformed envelopes ─────────────────────────────────────────────────────
describe('malformed envelopes fail with malformed-envelope', () => {
  const validPayload = decodePayload(encryptA());
  const malformed: Array<[string, string]> = [
    ['empty string', ''],
    ['no env1 prefix', Buffer.from(JSON.stringify(validPayload), 'utf8').toString('base64url')],
    ['wrong version prefix', 'env2.' + Buffer.from(JSON.stringify(validPayload), 'utf8').toString('base64url')],
    ['prefix only, empty payload', 'env1.'],
    ['payload is not JSON', 'env1.' + Buffer.from('not json at all', 'utf8').toString('base64url')],
    ['payload is a JSON scalar', 'env1.' + Buffer.from('42', 'utf8').toString('base64url')],
    ['payload missing fields', encodePayload({ v: 1, tenantId: TENANT_A })],
    ['payload with wrong version', encodePayload({ ...validPayload, v: 2 })],
    ['payload with non-hex iv', encodePayload({ ...validPayload, iv: 'zz' })],
    [
      'payload with non-hex wrapped DEK',
      encodePayload({
        ...validPayload,
        wrappedDek: { iv: 'zz', ct: 'aa', tag: 'bb' },
      }),
    ],
  ];

  it.each(malformed)('rejects: %s', (_label, envelope) => {
    expect(captureEnvelopeError(() => decryptA(envelope)).code).toBe('malformed-envelope');
  });

  it('rejects a non-string envelope value', () => {
    expect(
      captureEnvelopeError(() =>
        decryptForTenant({ keyring: { k1: K1 }, tenantId: TENANT_A, envelope: undefined as unknown as string }),
      ).code,
    ).toBe('malformed-envelope');
  });
});

// ── Non-compatibility with the legacy scheme (honest documentation) ─────────
describe('legacy crypto.ts format is NOT an envelope (no compatibility claimed)', () => {
  it('decryptForTenant rejects a legacy iv:ct:tag string as malformed-envelope', () => {
    const legacy = legacyEncrypt(PLAINTEXT, K1);
    expect(legacy).toMatch(/^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/);
    const err = captureEnvelopeError(() => decryptA(legacy));
    expect(err.code).toBe('malformed-envelope');
  });
});
