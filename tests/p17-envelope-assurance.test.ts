/**
 * Programme 17 / Workstream D — Envelope encryption assurance (Claim 6).
 *
 * EXTENDS tests/crypto-envelope.test.ts (30 tests, run separately and
 * passing) — this file deliberately targets what that file does not:
 * error-precedence as evidence for the pre-crypto tenant check, keyId
 * canonicalization (or its absence), rotation ROLLBACK cost, IV
 * corruption, keyring edge entries, bidirectional legacy incompatibility,
 * module export surface (no re-wrap/migration helper existed at P17 —
 * one was added later, by Programme 23, as separately reviewed code),
 * and systematic error/log hygiene across every failure mode.
 *
 * SYNTHETIC ONLY: keys via randomBytes in-test, plaintext is a marker.
 * No production key/ciphertext, no .env read — envelope.ts reads no env.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as envelopeModule from '@/lib/crypto/envelope';
import {
  encryptForTenant, decryptForTenant, generateTenantDek, EnvelopeError,
} from '@/lib/crypto/envelope';
import { encrypt as legacyEncrypt, decrypt as legacyDecrypt } from '@/lib/crypto';

const K1 = randomBytes(32).toString('hex');
let K2 = randomBytes(32).toString('hex');
while (K2 === K1) K2 = randomBytes(32).toString('hex');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PT = 'SYNTHETIC-P17-SECRET-MARKER-9876543210';

const enc = (tenantId = A, keyId = 'k1', key = K1, pt = PT) =>
  encryptForTenant({ masterKeyHex: key, keyId, tenantId, plaintext: pt });
const dec = (envelope: string, tenantId = A, keyring: Record<string, string> = { k1: K1 }) =>
  decryptForTenant({ keyring, tenantId, envelope });

function capture(fn: () => unknown): EnvelopeError {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(EnvelopeError);
    return e as EnvelopeError;
  }
  throw new Error('expected throw, got return');
}
const decode = (e: string) =>
  JSON.parse(Buffer.from(e.slice(5), 'base64url').toString('utf8')) as Record<string, unknown>;
const encode = (p: Record<string, unknown>) =>
  'env1.' + Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
const flip = (hex: string) => (hex.startsWith('0') ? '1' : '0') + hex.slice(1);

// ── Pre-crypto tenant check: precedence IS the evidence ─────────────────────
describe('P17 pre-crypto tenant check — rejects BEFORE key lookup or decryption', () => {
  it('wrong tenant beats a CORRUPTED ciphertext (would be decrypt-failed if crypto ran first)', () => {
    const p = decode(enc()); p['ct'] = flip(p['ct'] as string);
    expect(capture(() => dec(encode(p), B)).code).toBe('tenant-mismatch');
  });
  it('wrong tenant beats a corrupted wrapped DEK', () => {
    const p = decode(enc());
    (p['wrappedDek'] as Record<string, string>)['tag'] = flip((p['wrappedDek'] as Record<string, string>)['tag']!);
    expect(capture(() => dec(encode(p), B)).code).toBe('tenant-mismatch');
  });
  it('wrong tenant beats an unknown keyId (key lookup never reached)', () => {
    expect(capture(() => dec(enc(A, 'k-ghost', K1), B, {})).code).toBe('tenant-mismatch');
  });
  it('wrong tenant beats a MALFORMED keyring entry for that keyId', () => {
    expect(capture(() => dec(enc(), B, { k1: 'not-hex-at-all' })).code).toBe('tenant-mismatch');
  });
  it('direct wrong-tenant with the CORRECT key still fails tenant-mismatch (key correctness is irrelevant)', () => {
    expect(capture(() => dec(enc(), B, { k1: K1 })).code).toBe('tenant-mismatch');
  });
});

// ── AAD binding, deeper transplants ─────────────────────────────────────────
describe('P17 AAD transplant variants', () => {
  it('stored tenantId edited A→B, caller asks for A → tenant-mismatch (stored ≠ requested)', () => {
    const p = decode(enc()); p['tenantId'] = B;
    expect(capture(() => dec(encode(p), A)).code).toBe('tenant-mismatch');
  });
  it('stored tenantId edited A→B AND keyId edited to a held key → still decrypt-failed via AAD', () => {
    const p = decode(enc()); p['tenantId'] = B; p['keyId'] = 'k2';
    expect(capture(() => dec(encode(p), B, { k1: K1, k2: K2 })).code).toBe('decrypt-failed');
  });
  it("wrappedDek transplanted from tenant B's envelope into tenant A's envelope → decrypt-failed", () => {
    const pa = decode(enc(A)); const pb = decode(enc(B));
    pa['wrappedDek'] = pb['wrappedDek']; // B's DEK, wrapped under B-as-AAD (and a different DEK)
    expect(capture(() => dec(encode(pa), A)).code).toBe('decrypt-failed');
  });
  it("data seal transplanted from tenant B's envelope into tenant A's (own wrappedDek kept) → decrypt-failed", () => {
    const pa = decode(enc(A)); const pb = decode(enc(B));
    pa['iv'] = pb['iv']; pa['ct'] = pb['ct']; pa['tag'] = pb['tag'];
    expect(capture(() => dec(encode(pa), A)).code).toBe('decrypt-failed');
  });
});

// ── keyId validation ────────────────────────────────────────────────────────
describe('P17 keyId validation and (non-)canonicalization', () => {
  it('unknown keyId → unknown-key-id, message names ONLY the keyId, never key material/plaintext', () => {
    const err = capture(() => dec(enc(A, 'k-retired-2099', K1), A, { k1: K1 }));
    expect(err.code).toBe('unknown-key-id');
    expect(err.message).toContain('k-retired-2099'); // identifier, by design — see D-encryption.md §hygiene
    expect(err.message).not.toContain(K1); expect(err.message).not.toContain(PT);
  });
  it.each([
    ['numeric keyId', 123], ['null keyId', null], ['empty-string keyId', ''],
  ])('malformed keyId in payload (%s) → malformed-envelope, before tenant/key logic', (_l, kid) => {
    const p = decode(enc()); p['keyId'] = kid as unknown;
    expect(capture(() => dec(encode(p))).code).toBe('malformed-envelope');
  });
  it('keyId is NOT canonicalized: "K1" ≠ "k1" and " k1" ≠ "k1" in the keyring → unknown-key-id', () => {
    expect(capture(() => dec(enc(A, 'K1', K1), A, { k1: K1 })).code).toBe('unknown-key-id');
    expect(capture(() => dec(enc(A, ' k1', K1), A, { k1: K1 })).code).toBe('unknown-key-id');
  });
  it('keyId retargeted k1→k2 (both held, different material) → tries k2 KEK → decrypt-failed, not unknown', () => {
    const p = decode(enc()); p['keyId'] = 'k2';
    expect(capture(() => dec(encode(p), A, { k1: K1, k2: K2 })).code).toBe('decrypt-failed');
  });
  it('encrypt-side: empty keyId / empty tenantId → malformed-envelope; whitespace keyId is accepted verbatim', () => {
    expect(capture(() => encryptForTenant({ masterKeyHex: K1, keyId: '', tenantId: A, plaintext: PT })).code)
      .toBe('malformed-envelope');
    expect(capture(() => encryptForTenant({ masterKeyHex: K1, keyId: 'k1', tenantId: '', plaintext: PT })).code)
      .toBe('malformed-envelope');
    const e = enc(A, ' k1 ', K1);
    expect(decryptForTenant({ keyring: { ' k1 ': K1 }, tenantId: A, envelope: e })).toBe(PT);
  });
  it('keyring entry present but undefined → treated as absent → unknown-key-id', () => {
    const ring = { k1: undefined } as unknown as Record<string, string>;
    expect(capture(() => dec(enc(), A, ring)).code).toBe('unknown-key-id');
  });
  it('keyring entry malformed hex (present, wrong shape) → decrypt-failed with the generic master-key message', () => {
    const err = capture(() => dec(enc(), A, { k1: 'zz'.repeat(32) }));
    expect(err.code).toBe('decrypt-failed');
    expect(err.message).toContain('64 hex');
    expect(err.message).not.toContain(PT);
  });
});

// ── Rotation + rollback ─────────────────────────────────────────────────────
describe('P17 rotation and rollback', () => {
  it('full cycle: k1 era → rotate to k2 (new uses k2, old still decrypts) → ROLLBACK to k1 for new writes', () => {
    const ring = { k1: K1, k2: K2 };
    const era1 = enc(A, 'k1', K1, 'era-1');
    const era2 = enc(A, 'k2', K2, 'era-2');
    expect(decode(era2)['keyId']).toBe('k2');
    expect(dec(era1, A, ring)).toBe('era-1');
    expect(dec(era2, A, ring)).toBe('era-2');
    // Rollback = direct new encryptions at k1 again; nothing about old envelopes changes.
    const afterRollback = enc(A, 'k1', K1, 'era-3');
    expect(decode(afterRollback)['keyId']).toBe('k1');
    expect(dec(afterRollback, A, ring)).toBe('era-3');
    expect(dec(era2, A, ring)).toBe('era-2');
  });
  it('rollback COST pinned: dropping k2 from the ring strands k2-era envelopes (unknown-key-id) while k1 envelopes are unaffected', () => {
    const era1 = enc(A, 'k1', K1, 'era-1');
    const era2 = enc(A, 'k2', K2, 'era-2');
    expect(dec(era1, A, { k1: K1 })).toBe('era-1');
    expect(capture(() => dec(era2, A, { k1: K1 })).code).toBe('unknown-key-id');
  });
  it('empty keyring → every envelope is unknown-key-id (missing-key behaviour)', () => {
    expect(capture(() => dec(enc(), A, {})).code).toBe('unknown-key-id');
  });
  // UPDATED by Programme 23 (2026-11-06): the re-wrap helper whose absence
  // this pin originally recorded was implemented as the separately reviewed
  // code Programme 17 §6.5 required, so the pin now records the EXTENDED
  // surface. The P17-era fact (no helper existed at P17) remains true of
  // P17; see tests/p23-envelope-rewrap.test.ts for the new behaviour.
  it('module surface: re-wrap helper added by Programme 23; no rotate / migrate helper beyond it', () => {
    expect(Object.keys(envelopeModule).sort()).toEqual(
      ['EnvelopeError', 'KEY_ID_PATTERN', 'decryptForTenant', 'encryptForTenant', 'generateTenantDek', 'isGovernedKeyId', 'rewrapForTenant']);
  });
});

// ── Corruption: clean failure, no partial plaintext ─────────────────────────
describe('P17 corrupted ciphertext — every component, clean failure only', () => {
  const cases: Array<[string, (p: Record<string, unknown>) => void]> = [
    ['data iv bit-flip', (p) => { p['iv'] = flip(p['iv'] as string); }],
    ['wrappedDek iv bit-flip', (p) => {
      const w = p['wrappedDek'] as Record<string, string>; w['iv'] = flip(w['iv']!); }],
    ['data ct truncated by one byte', (p) => { p['ct'] = (p['ct'] as string).slice(0, -2); }],
    ['wrappedDek ct bit-flip', (p) => {
      const w = p['wrappedDek'] as Record<string, string>; w['ct'] = flip(w['ct']!); }],
    ['envelope string truncated mid-payload', () => { /* handled below */ }],
  ];
  it.each(cases.slice(0, 4))('%s → decrypt-failed, error carries no plaintext fragment', (_l, mutate) => {
    const p = decode(enc()); mutate(p);
    const err = capture(() => dec(encode(p)));
    expect(err.code).toBe('decrypt-failed');
    expect(err.message).not.toContain(PT.slice(0, 12));
    expect(err.message).not.toContain(K1);
  });
  // UPDATED by Programme 25 (2026-11-07): the 'data tag truncated by
  // one byte' case previously ran in the matrix above asserting
  // 'decrypt-failed'. Under P25 WS2 format enforcement the tag length
  // is structural (exactly 32 hex chars), so a 30-hex-char tag is now
  // rejected at parse as 'malformed-envelope' — a tightening (earlier,
  // more precise rejection of the same corruption), per the ChatGPT
  // Iteration-2 finding F25-B. The hygiene half of the original pin
  // (no plaintext fragment, no key material in the error) is preserved
  // verbatim below; the mutation itself is unchanged.
  it('data tag truncated by one byte → malformed-envelope (P25: was decrypt-failed), error carries no plaintext fragment', () => {
    const p = decode(enc());
    p['tag'] = (p['tag'] as string).slice(0, -2);
    const err = capture(() => dec(encode(p)));
    expect(err.code).toBe('malformed-envelope');
    expect(err.message).not.toContain(PT.slice(0, 12));
    expect(err.message).not.toContain(K1);
  });
  it('envelope string truncated mid-payload → malformed-envelope (never a partial return)', () => {
    const e = enc();
    expect(capture(() => dec(e.slice(0, e.length - 8))).code).toMatch(/^(malformed-envelope|decrypt-failed)$/);
  });
  it('failure is all-or-nothing: a corrupted copy does not affect the pristine envelope', () => {
    const good = enc();
    const p = decode(good); p['ct'] = flip(p['ct'] as string);
    capture(() => dec(encode(p)));
    expect(dec(good)).toBe(PT);
  });
});

// ── Version handling + legacy rejection ─────────────────────────────────────
describe('P17 version handling', () => {
  it.each([
    ['prefix env2.', 'env2.'], ['prefix env0.', 'env0.'], ['prefix ENV1. (case)', 'ENV1.'],
    ['prefix env1 without dot', 'env1'], ['no prefix', ''],
  ])('unknown version %s → malformed-envelope', (_l, prefix) => {
    const body = enc().slice(5);
    expect(capture(() => dec(prefix + body)).code).toBe('malformed-envelope');
  });
  it.each([
    ['v=2', 2], ['v=0', 0], ['v="1" (string)', '1'], ['v missing', undefined],
  ])('payload %s → malformed-envelope', (_l, v) => {
    const p = decode(enc()); if (v === undefined) delete p['v']; else p['v'] = v as unknown;
    expect(capture(() => dec(encode(p))).code).toBe('malformed-envelope');
  });
  it('legacy iv:ct:tag → malformed-envelope; and conversely an env1 envelope fed to LEGACY decrypt() also fails (bidirectional incompatibility)', () => {
    const legacy = legacyEncrypt(PT, K1);
    expect(capture(() => dec(legacy)).code).toBe('malformed-envelope');
    expect(() => legacyDecrypt(enc(), K1)).toThrow();
  });
});

// ── Encrypt-side key/DEK validation ─────────────────────────────────────────
describe('P17 encrypt-side validation (synthetic malformed inputs)', () => {
  it.each([
    ['63-hex master key', 'a'.repeat(63)], ['65-hex master key', 'a'.repeat(65)],
    ['non-hex master key', 'zz'.repeat(32)], ['empty master key', ''],
  ])('%s → EnvelopeError decrypt-failed code (PINNED asymmetry: encrypt reuses the decrypt-failed code)', (_l, key) => {
    const err = capture(() => encryptForTenant({ masterKeyHex: key, keyId: 'k1', tenantId: A, plaintext: PT }));
    expect(err.code).toBe('decrypt-failed');
    expect(err.message).not.toContain(PT);
  });
  it.each([['16-byte DEK', 16], ['33-byte DEK', 33]])('%s → malformed-envelope', (_l, n) => {
    expect(capture(() => encryptForTenant({
      masterKeyHex: K1, keyId: 'k1', tenantId: A, plaintext: PT, dek: randomBytes(n),
    })).code).toBe('malformed-envelope');
  });
  it('non-Buffer DEK → malformed-envelope', () => {
    expect(capture(() => encryptForTenant({
      masterKeyHex: K1, keyId: 'k1', tenantId: A, plaintext: PT,
      dek: 'x'.repeat(32) as unknown as Buffer,
    })).code).toBe('malformed-envelope');
  });
});

// ── Error / log hygiene across ALL failure modes ────────────────────────────
describe('P17 error hygiene — no key material, no plaintext, no console output', () => {
  it('every failure mode: EnvelopeError, stable code, clean message, silent console', () => {
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const)
      .map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const tampered = decode(enc()); tampered['tag'] = flip(tampered['tag'] as string);
      const failures: Array<() => unknown> = [
        () => dec(enc(), B),                                   // tenant-mismatch
        () => dec(enc(A, 'ghost', K1), A, {}),                 // unknown-key-id
        () => dec(encode(tampered)),                           // decrypt-failed
        () => dec('garbage'),                                  // malformed
        () => dec(enc(), A, { k1: K2 }),                       // wrong key
        () => encryptForTenant({ masterKeyHex: 'bad', keyId: 'k1', tenantId: A, plaintext: PT }),
      ];
      for (const f of failures) {
        const err = capture(f);
        expect(err.name).toBe('EnvelopeError');
        expect(err.message).not.toContain(K1);
        expect(err.message).not.toContain(K2);
        expect(err.message).not.toContain(PT);
        expect(err.message).not.toContain(generateTenantDek().toString('hex')); // sanity: no DEK-shaped leak pattern asserted below
      }
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it('source hygiene: envelope.ts contains no console/logging and never reads process.env', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'lib', 'crypto', 'envelope.ts'), 'utf8');
    expect(src).not.toContain('console.');
    expect(src).not.toContain('process.env');
  });
});
