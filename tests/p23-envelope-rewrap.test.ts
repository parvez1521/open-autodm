/**
 * Programme 23 — Envelope re-wrap helper + governed keyId format.
 *
 * Closes the two operational gaps Programme 17 recorded for
 * src/lib/crypto/envelope.ts:
 *  - §6.5: rotation rollback strands envelopes at 'unknown-key-id' and
 *    "any re-wrap pass must be written as new, separately reviewed
 *    code" — rewrapForTenant is that code.
 *  - §6.3 / §5: no keyId format validation or canonicalization existed;
 *    issuance governance is now expressed as isGovernedKeyId /
 *    KEY_ID_PATTERN and enforced for the TARGET of a re-wrap, while
 *    encrypt/decrypt keep their pinned verbatim exact-match semantics.
 *
 * SYNTHETIC ONLY: all keys via randomBytes in-test, plaintext is a
 * marker. No production key/ciphertext, no .env read — envelope.ts
 * reads no env (pinned below for the extended module as well).
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptForTenant,
  decryptForTenant,
  rewrapForTenant,
  isGovernedKeyId,
  KEY_ID_PATTERN,
  EnvelopeError,
} from '@/lib/crypto/envelope';

const K1 = randomBytes(32).toString('hex');
const K1_ROTATED = randomBytes(32).toString('hex');
const K2 = randomBytes(32).toString('hex');
const K3 = randomBytes(32).toString('hex');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PT = 'SYNTHETIC-P23-SECRET-MARKER-0123456789';

const enc = (tenantId = A, keyId = 'k1', key = K1, pt = PT) =>
  encryptForTenant({ masterKeyHex: key, keyId, tenantId, plaintext: pt });

const dec = (envelope: string, tenantId = A, keyring: Record<string, string> = { k1: K1 }) =>
  decryptForTenant({ keyring, tenantId, envelope });

const rewrap = (
  envelope: string,
  tenantId = A,
  keyring: Record<string, string> = { k1: K1 },
  newKeyId = 'k2',
  newMasterKeyHex = K2,
) => rewrapForTenant({ envelope, tenantId, keyring, newKeyId, newMasterKeyHex });

function decode(envelope: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(envelope.slice('env1.'.length), 'base64url').toString('utf8')) as Record<string, unknown>;
}

function capture(fn: () => unknown): EnvelopeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvelopeError);
    return err as EnvelopeError;
  }
  throw new Error('expected the call to throw');
}

function flip(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  bytes[0] = bytes[0]! ^ 0x01;
  return bytes.toString('hex');
}

function tamper(envelope: string, mutate: (p: Record<string, unknown>) => void): string {
  const p = decode(envelope);
  mutate(p);
  return 'env1.' + Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

// ── Governed keyId format ───────────────────────────────────────────────────
describe('P23 governed keyId format (isGovernedKeyId / KEY_ID_PATTERN)', () => {
  it.each(['k1', 'K2026-11', 'key_1.prod', 'a', 'A0.-_', 'x'.repeat(64)])(
    'accepts governed keyId %j',
    (keyId) => {
      expect(isGovernedKeyId(keyId)).toBe(true);
      expect(KEY_ID_PATTERN.test(keyId)).toBe(true);
    },
  );

  it.each(['', ' k1', 'k1 ', 'k 1', '-k1', '.k1', '_k1', 'k/1', 'k:1', 'k#1', 'é1', 'x'.repeat(65)])(
    'rejects ungoverned keyId %j',
    (keyId) => {
      expect(isGovernedKeyId(keyId)).toBe(false);
    },
  );

  it('rejects non-string input', () => {
    expect(isGovernedKeyId(123 as unknown as string)).toBe(false);
    expect(isGovernedKeyId(undefined as unknown as string)).toBe(false);
  });

  it('governance does NOT tighten encrypt/decrypt: a verbatim whitespace keyId still round-trips (P17 §6.3 pin preserved)', () => {
    const e = enc(A, ' k1 ', K1);
    expect(decryptForTenant({ keyring: { ' k1 ': K1 }, tenantId: A, envelope: e })).toBe(PT);
  });
});

// ── Re-wrap: core behaviour ─────────────────────────────────────────────────
describe('P23 rewrapForTenant — core behaviour', () => {
  it('returns a NEW envelope: keyId updated, tenant preserved, data seal byte-identical, wrapped DEK re-sealed', () => {
    const original = enc();
    const out = rewrap(original);
    expect(out).not.toBe(original);
    const before = decode(original);
    const after = decode(out);
    expect(after['keyId']).toBe('k2');
    expect(after['tenantId']).toBe(A);
    // Data seal carried over untouched — plaintext is never decrypted on this path.
    expect(after['iv']).toBe(before['iv']);
    expect(after['ct']).toBe(before['ct']);
    expect(after['tag']).toBe(before['tag']);
    // Wrapped DEK differs (fresh IV under the new KEK).
    expect(after['wrappedDek']).not.toEqual(before['wrappedDek']);
  });

  it('the rewrapped envelope decrypts under a keyring holding ONLY the target key', () => {
    const out = rewrap(enc());
    expect(dec(out, A, { k2: K2 })).toBe(PT);
  });

  it('the input envelope is not mutated and still decrypts under the old key alone', () => {
    const original = enc();
    rewrap(original);
    expect(dec(original, A, { k1: K1 })).toBe(PT);
  });

  it('RESCUE SCENARIO (P17 §6.5 cost, inverted): rewrap BEFORE retiring the old key prevents stranding', () => {
    const era = enc(A, 'k1', K1, 'era-1');
    const rescued = rewrap(era, A, { k1: K1 }, 'k2', K2);
    // Old key retired: the rewrapped envelope survives, the untouched one strands.
    expect(dec(rescued, A, { k2: K2 })).toBe('era-1');
    expect(capture(() => dec(era, A, { k2: K2 })).code).toBe('unknown-key-id');
  });

  it('chains: k1 → k2 → k3, decryptable under the final key alone', () => {
    const step1 = rewrap(enc(), A, { k1: K1 }, 'k2', K2);
    const step2 = rewrap(step1, A, { k2: K2 }, 'k3', K3);
    expect(decode(step2)['keyId']).toBe('k3');
    expect(dec(step2, A, { k3: K3 })).toBe(PT);
  });

  it('supports key-material rotation under the SAME keyId (new KEK supplied explicitly)', () => {
    const out = rewrap(enc(), A, { k1: K1 }, 'k1', K1_ROTATED);
    expect(dec(out, A, { k1: K1_ROTATED })).toBe(PT);
    expect(capture(() => dec(out, A, { k1: K1 })).code).toBe('decrypt-failed');
  });

  it('rewraps an empty-plaintext envelope', () => {
    const out = rewrap(enc(A, 'k1', K1, ''));
    expect(dec(out, A, { k2: K2 })).toBe('');
  });
});

// ── Re-wrap: fault injection + pinned check order ───────────────────────────
describe('P23 rewrapForTenant — fault injection and check precedence', () => {
  it('wrong tenant → tenant-mismatch, and it beats a bad target keyId AND an unknown current keyId', () => {
    const err = capture(() => rewrap(enc(), B, {}, 'bad key!', K2));
    expect(err.code).toBe('tenant-mismatch');
  });

  it('ungoverned target keyId → malformed-envelope, and it beats an unknown current keyId', () => {
    expect(capture(() => rewrap(enc(), A, {}, 'bad key!', K2)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(enc(), A, { k1: K1 }, '', K2)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(enc(), A, { k1: K1 }, '-lead', K2)).code).toBe('malformed-envelope');
  });

  it('current keyId absent from the keyring → unknown-key-id', () => {
    expect(capture(() => rewrap(enc(), A, { k2: K2 })).code).toBe('unknown-key-id');
    expect(capture(() => rewrap(enc(), A, {})).code).toBe('unknown-key-id');
  });

  it('wrong current key material → decrypt-failed', () => {
    expect(capture(() => rewrap(enc(), A, { k1: K2 })).code).toBe('decrypt-failed');
  });

  it('tampered wrapped-Dek ciphertext → decrypt-failed, no output produced', () => {
    const forged = tamper(enc(), (p) => {
      const w = p['wrappedDek'] as Record<string, string>;
      w['ct'] = flip(w['ct']!);
    });
    expect(capture(() => rewrap(forged)).code).toBe('decrypt-failed');
  });

  it('tampered wrapped-Dek tag → decrypt-failed', () => {
    const forged = tamper(enc(), (p) => {
      const w = p['wrappedDek'] as Record<string, string>;
      w['tag'] = flip(w['tag']!);
    });
    expect(capture(() => rewrap(forged)).code).toBe('decrypt-failed');
  });

  it('malformed envelope input → malformed-envelope (incl. legacy iv:ct:tag strings)', () => {
    expect(capture(() => rewrap('not-an-envelope')).code).toBe('malformed-envelope');
    expect(capture(() => rewrap('aa:bb:cc')).code).toBe('malformed-envelope');
  });

  it('malformed target master key → decrypt-failed with the generic 64-hex message', () => {
    const err = capture(() => rewrap(enc(), A, { k1: K1 }, 'k2', 'zz'.repeat(32)));
    expect(err.code).toBe('decrypt-failed');
    expect(err.message).toContain('64 hex');
  });

  it('malformed current keyring entry → decrypt-failed', () => {
    expect(capture(() => rewrap(enc(), A, { k1: 'zz'.repeat(32) })).code).toBe('decrypt-failed');
  });
});

// ── Re-wrap: error + log hygiene ────────────────────────────────────────────
describe('P23 rewrapForTenant — hygiene', () => {
  it('no failure message contains key material, the plaintext marker, or the supplied target keyId', () => {
    const failures: Array<() => unknown> = [
      () => rewrap(enc(), B),
      () => rewrap(enc(), A, { k1: K1 }, 'bad key!'),
      () => rewrap(enc(), A, {}),
      () => rewrap(enc(), A, { k1: K2 }),
      () => rewrap(enc(), A, { k1: K1 }, 'k2', 'zz'.repeat(32)),
    ];
    for (const fn of failures) {
      const err = capture(fn);
      expect(err.message).not.toContain(K1);
      expect(err.message).not.toContain(K2);
      expect(err.message).not.toContain(PT);
      expect(err.message).not.toContain('bad key!');
    }
  });

  it('produces no console output on success or failure', () => {
    const spies = ['log', 'warn', 'error', 'debug', 'info'].map((m) =>
      vi.spyOn(console, m as 'log').mockImplementation(() => undefined),
    );
    rewrap(enc());
    capture(() => rewrap(enc(), B));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
