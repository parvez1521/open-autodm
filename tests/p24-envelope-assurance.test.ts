/**
 * Programme 24 — Envelope cryptography independent assurance.
 *
 * Triage outcome of the ChatGPT independent review of Programme 23
 * (Master Task loop, Iteration 1): the review assessed design/evidence
 * only because the source was not in the submission. This file adds the
 * review's requested test evidence at the same unit tier as P16/P17/P23
 * (real cryptography, synthetic in-test keys; no higher tier claimed):
 *
 *  §1 (B2, high priority) cross-tenant AAD isolation with SHARED KEK
 *     material — stronger than the P23 wrong-tenant case: both tenants
 *     hold the IDENTICAL KEK bytes, so only the tenantId AAD binding
 *     can isolate them.
 *  §2 (B4) master-key length matrix on every key-consuming path.
 *  §3 (B5) wrapped-DEK IV/tag/ct malformed matrix.
 *  §4 (A2) plaintext-equivalence property: decrypt(original) ===
 *     decrypt(rewrapped), byte-for-byte.
 *  §5 full lifecycle chain k1 → k2 → k3 with key retirement.
 *  §6 (B3) data-seal tamper then re-wrap: pins the exact guarantee
 *     boundary — re-wrap authenticates the wrapped DEK only.
 *  §7 malformed serialized inputs + unexpected runtime shapes.
 *  §8 very large envelope (1 MB).
 *  §9 same-keyId / different-material rotation semantics, pinned as
 *     tested facts for the rotation lifecycle specification.
 *
 * NOT in scope (dispositioned in the P24 report): the review's two
 * API-boundary authorization scenarios — they belong to the future
 * KMS/integration tier (register SEC-12 / MT-5 / MT-6), not this
 * library's unit tier.
 *
 * Every malformed-input behaviour in §3/§7 was probed against the real
 * implementation before being pinned here.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptForTenant,
  decryptForTenant,
  rewrapForTenant,
  EnvelopeError,
} from '@/lib/crypto/envelope';

const K1 = randomBytes(32).toString('hex');
const K2 = randomBytes(32).toString('hex');
const K3 = randomBytes(32).toString('hex');
const SHARED = randomBytes(32).toString('hex'); // identical bytes held by BOTH tenants in §1
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PT = 'SYNTHETIC-P24-SECRET-MARKER-0123456789';

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
function tamper(envelope: string, mutate: (p: Record<string, unknown>) => void): string {
  const p = decode(envelope);
  mutate(p);
  return 'env1.' + Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
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
const flip = (hex: string): string => {
  const bytes = Buffer.from(hex, 'hex');
  bytes[0] = bytes[0]! ^ 0x01;
  return bytes.toString('hex');
};
const hexOfBytes = (n: number) => 'ab'.repeat(n); // n bytes = 2n hex chars

// ── §1 (B2) Cross-tenant AAD isolation with SHARED KEK material ────────────
describe('P24 §1 — shared-KEK cross-tenant isolation (ChatGPT B2)', () => {
  it('control: with identical KEK bytes, each tenant decrypts its own envelope under its own context', () => {
    const envA = enc(A, 'shared', SHARED, 'for-a');
    const envB = enc(B, 'shared', SHARED, 'for-b');
    expect(dec(envA, A, { shared: SHARED })).toBe('for-a');
    expect(dec(envB, B, { shared: SHARED })).toBe('for-b');
  });

  it('re-wrap of A\'s envelope under B\'s context fails at the stored-field check even though B holds the same KEK bytes', () => {
    const envA = enc(A, 'shared', SHARED);
    expect(capture(() => rewrap(envA, B, { shared: SHARED }, 'kB', K2)).code).toBe('tenant-mismatch');
  });

  it('TRANSPLANT: stored tenantId edited A→B, re-wrap for B with the IDENTICAL KEK bytes → decrypt-failed (AAD, not key material, isolates tenants)', () => {
    const forged = tamper(enc(A, 'shared', SHARED), (p) => { p['tenantId'] = B; });
    // The stored-field check now passes (stored === requested === B) and the
    // keyring holds literally the same bytes that wrapped the DEK — only the
    // GCM AAD (tenantId at wrap time) can stop this, and it does.
    expect(capture(() => rewrap(forged, B, { shared: SHARED }, 'kB', K2)).code).toBe('decrypt-failed');
  });

  it('TRANSPLANT: stored tenantId edited A→B, decrypt for B with the IDENTICAL KEK bytes → decrypt-failed', () => {
    const forged = tamper(enc(A, 'shared', SHARED), (p) => { p['tenantId'] = B; });
    expect(capture(() => dec(forged, B, { shared: SHARED })).code).toBe('decrypt-failed');
  });

  it('A-envelope + B target key: re-wrapping A\'s envelope under B\'s keyId/key does NOT transfer it to B', () => {
    // A legitimately re-wraps its own envelope onto B's keyId + B's distinct
    // key material (key custody is the caller's responsibility).
    const out = rewrap(enc(A, 'kA', K1), A, { kA: K1 }, 'kB', K2);
    expect(decode(out)['tenantId']).toBe(A);
    expect(decode(out)['keyId']).toBe('kB');
    // B cannot claim it: B's context fails the stored-field check…
    expect(capture(() => dec(out, B, { kB: K2 })).code).toBe('tenant-mismatch');
    // …and editing the stored tenantId to B fails GCM (AAD was bound to A at wrap time).
    const forged = tamper(out, (p) => { p['tenantId'] = B; });
    expect(capture(() => dec(forged, B, { kB: K2 })).code).toBe('decrypt-failed');
    // It remains A's envelope: A decrypts it with the target key.
    expect(dec(out, A, { kB: K2 })).toBe(PT);
  });
});

// ── §2 (B4) Master-key length matrix — every key-consuming path ────────────
describe('P24 §2 — master-key length matrix (ChatGPT B4)', () => {
  const badLengths: Array<[string, string]> = [
    ['16 bytes (32 hex)', hexOfBytes(16)],
    ['24 bytes (48 hex)', hexOfBytes(24)],
    ['31 bytes (62 hex)', hexOfBytes(31)],
    ['33 bytes (66 hex)', hexOfBytes(33)],
    ['empty', ''],
  ];

  it.each(badLengths)('encrypt rejects a %s master key with decrypt-failed and produces no envelope', (_l, key) => {
    expect(capture(() => enc(A, 'k1', key)).code).toBe('decrypt-failed');
  });
  it.each(badLengths)('decrypt rejects a %s keyring entry with decrypt-failed', (_l, key) => {
    expect(capture(() => dec(enc(), A, { k1: key })).code).toBe('decrypt-failed');
  });
  it.each(badLengths)('re-wrap rejects a %s CURRENT keyring entry with decrypt-failed', (_l, key) => {
    expect(capture(() => rewrap(enc(), A, { k1: key })).code).toBe('decrypt-failed');
  });
  it.each(badLengths)('re-wrap rejects a %s TARGET master key with decrypt-failed and produces no envelope', (_l, key) => {
    expect(capture(() => rewrap(enc(), A, { k1: K1 }, 'k2', key)).code).toBe('decrypt-failed');
  });

  it('exactly 32 bytes (64 hex) is accepted on every path; uppercase hex is equally valid', () => {
    const upper = enc(A, 'k1', K1.toUpperCase());
    expect(dec(upper, A, { k1: K1 })).toBe(PT); // same bytes — case-insensitive hex decoding
    const out = rewrap(enc(), A, { k1: K1 }, 'k2', K2.toUpperCase());
    expect(dec(out, A, { k2: K2 })).toBe(PT);
  });
});

// ── §3 (B5) Wrapped-DEK IV / tag / ct malformed matrix ─────────────────────
describe('P24 §3 — wrapped-DEK malformed matrix (ChatGPT B5)', () => {
  // PROGRAMME 25 NOTE (2026-11-07) — five expectations in this matrix
  // were TIGHTENED from 'decrypt-failed' to 'malformed-envelope' (WS2
  // format enforcement): wrappedDek iv wrong length (8 / 16 bytes) and
  // tag wrong length (8 / 15 / 17 bytes). The old pins asserted
  // 'decrypt-failed' because the P24 parser accepted any non-empty hex
  // IV/tag and GCM rejected the values at open time. The format now
  // fixes IV = exactly 24 hex chars and tag = exactly 32 hex chars, so
  // these mutations are rejected STRUCTURALLY at parse, before any GCM
  // work — the ChatGPT Iteration-2 finding F25-B. The mutation SET is
  // unchanged; every case still fails closed with a typed error on both
  // paths; no expectation moved in the lenient direction. The 'ct
  // truncated' row still asserts 'decrypt-failed' (ciphertext length is
  // legitimately variable). Genuinely-AUTHENTICATED envelopes with
  // non-standard IV/tag lengths (valid tags, built with raw crypto) are
  // pinned in tests/p25-envelope-hardening.test.ts §2.
  type Mut = (w: Record<string, unknown>) => void;
  const cases: Array<[string, Mut, 'malformed-envelope' | 'decrypt-failed']> = [
    ['iv missing', (w) => { delete w['iv']; }, 'malformed-envelope'],
    ['iv empty', (w) => { w['iv'] = ''; }, 'malformed-envelope'],
    ['iv odd-length hex', (w) => { w['iv'] = 'abc'; }, 'malformed-envelope'],
    ['iv non-hex', (w) => { w['iv'] = 'zz'.repeat(12); }, 'malformed-envelope'],
    ['iv wrong length (8 bytes)', (w) => { w['iv'] = randomBytes(8).toString('hex'); }, 'malformed-envelope'], // P25: was 'decrypt-failed'
    ['iv wrong length (16 bytes)', (w) => { w['iv'] = randomBytes(16).toString('hex'); }, 'malformed-envelope'], // P25: was 'decrypt-failed'
    ['tag missing', (w) => { delete w['tag']; }, 'malformed-envelope'],
    ['tag empty', (w) => { w['tag'] = ''; }, 'malformed-envelope'],
    ['tag wrong length (8 bytes)', (w) => { w['tag'] = randomBytes(8).toString('hex'); }, 'malformed-envelope'], // P25: was 'decrypt-failed'
    ['tag wrong length (15 bytes)', (w) => { w['tag'] = randomBytes(15).toString('hex'); }, 'malformed-envelope'], // P25: was 'decrypt-failed'
    ['tag wrong length (17 bytes)', (w) => { w['tag'] = randomBytes(17).toString('hex'); }, 'malformed-envelope'], // P25: was 'decrypt-failed'
    ['ct empty', (w) => { w['ct'] = ''; }, 'malformed-envelope'],
    ['ct missing', (w) => { delete w['ct']; }, 'malformed-envelope'],
    ['ct truncated (16 of 32 bytes)', (w) => { w['ct'] = (w['ct'] as string).slice(0, 32); }, 'decrypt-failed'],
  ];

  it.each(cases)('decrypt: wrappedDek %s → %s, typed error, no output', (_l, mutate, code) => {
    const forged = tamper(enc(), (p) => mutate(p['wrappedDek'] as Record<string, unknown>));
    expect(capture(() => dec(forged)).code).toBe(code);
  });

  it.each(cases)('re-wrap: wrappedDek %s → %s, typed error, no output', (_l, mutate, code) => {
    const forged = tamper(enc(), (p) => mutate(p['wrappedDek'] as Record<string, unknown>));
    expect(capture(() => rewrap(forged)).code).toBe(code);
  });

  // PROGRAMME 25 NOTE (2026-11-07): this test previously asserted
  // 'decrypt-failed' for both mutations; under WS2 format enforcement
  // the data seal's IV/tag lengths are structural (24 / 32 hex chars),
  // so both are now 'malformed-envelope' at parse — see the matrix note
  // above. Same mutations, earlier and more precise rejection.
  it('data-seal components are equally strict on decrypt: iv 8 bytes / tag 8 bytes → malformed-envelope (P25: was decrypt-failed)', () => {
    const badIv = tamper(enc(), (p) => { p['iv'] = randomBytes(8).toString('hex'); });
    const badTag = tamper(enc(), (p) => { p['tag'] = randomBytes(8).toString('hex'); });
    expect(capture(() => dec(badIv)).code).toBe('malformed-envelope');
    expect(capture(() => dec(badTag)).code).toBe('malformed-envelope');
  });
});

// ── §4 (A2) Plaintext-equivalence property ─────────────────────────────────
describe('P24 §4 — plaintext equivalence across re-wrap (ChatGPT A2)', () => {
  const plaintexts: Array<[string, string]> = [
    ['empty', ''],
    ['single char', 'a'],
    ['marker', PT],
    ['unicode + emoji', '🔐 токен — テスト ✓ café'],
    ['newlines + NUL', 'line1\nline2\u0000end'],
    ['10 KB repeated', 'x'.repeat(10_000)],
  ];
  it.each(plaintexts)('decrypt(original) === decrypt(rewrapped) === plaintext (%s)', (_l, pt) => {
    const original = enc(A, 'k1', K1, pt);
    const rewrapped = rewrap(original, A, { k1: K1 }, 'k2', K2);
    const fromOriginal = dec(original, A, { k1: K1 });
    const fromRewrapped = dec(rewrapped, A, { k2: K2 });
    expect(fromOriginal).toBe(pt);
    expect(fromRewrapped).toBe(pt);
    expect(fromRewrapped).toBe(fromOriginal); // byte-for-byte identical strings
  });
});

// ── §5 Full lifecycle chain with retirement ────────────────────────────────
describe('P24 §5 — full lifecycle chain k1 → k2 → k3', () => {
  it('each hop leaves the envelope decryptable ONLY under the newest key', () => {
    const e1 = enc(A, 'k1', K1, 'lifecycle');
    const e2 = rewrap(e1, A, { k1: K1 }, 'k2', K2);
    expect(dec(e2, A, { k2: K2 })).toBe('lifecycle');
    expect(capture(() => dec(e2, A, { k1: K1 })).code).toBe('unknown-key-id'); // k1 retired

    const e3 = rewrap(e2, A, { k2: K2 }, 'k3', K3);
    expect(decode(e3)['keyId']).toBe('k3');
    expect(dec(e3, A, { k3: K3 })).toBe('lifecycle');
    expect(capture(() => dec(e3, A, { k1: K1 })).code).toBe('unknown-key-id');
    expect(capture(() => dec(e3, A, { k2: K2 })).code).toBe('unknown-key-id');
    // The original k1 envelope is unaffected throughout (immutability).
    expect(dec(e1, A, { k1: K1 })).toBe('lifecycle');
  });
});

// ── §6 (B3) Data-seal tamper then re-wrap — the guarantee boundary ─────────
describe('P24 §6 — data-seal tamper then re-wrap (ChatGPT B3 guarantee boundary)', () => {
  // rewrapForTenant authenticates and re-protects the wrapped DEK; it does
  // NOT validate the integrity of the underlying encrypted payload. These
  // tests pin both halves of that sentence: re-wrap SUCCEEDS on a
  // data-tampered envelope (it never opens the data seal), and decrypt of
  // the result FAILS authentication.
  const tampers: Array<[string, (p: Record<string, unknown>) => void]> = [
    ['data ct bit-flip', (p) => { p['ct'] = flip(p['ct'] as string); }],
    ['data tag bit-flip', (p) => { p['tag'] = flip(p['tag'] as string); }],
    ['data iv bit-flip', (p) => { p['iv'] = flip(p['iv'] as string); }],
  ];
  it.each(tampers)('%s: re-wrap succeeds, decrypt of the re-wrapped envelope fails authentication', (_l, mutate) => {
    const forged = tamper(enc(), mutate);
    const out = rewrap(forged); // must NOT throw — the guarantee does not extend to the payload
    expect(decode(out)['keyId']).toBe('k2');
    expect(capture(() => dec(out, A, { k2: K2 })).code).toBe('decrypt-failed');
  });
});

// ── §7 Malformed serialized inputs + unexpected runtime shapes ─────────────
describe('P24 §7 — malformed serialized inputs and runtime shapes', () => {
  it.each([
    ['extra base64url chars appended', (e: string) => e + 'AA'],
    ['standard-base64 "+" substituted in', (e: string) => 'env1.' + e.slice(5).replace(/[A-Za-z0-9_-]/, '+')],
    ['standard-base64 "/" substituted in', (e: string) => 'env1.' + e.slice(5).replace(/[A-Za-z0-9_-]/, '/')],
    ['invalid characters only', () => 'env1.!!!'],
    ['empty body', () => 'env1.'],
    ['truncated to half length', (e: string) => e.slice(0, Math.floor(e.length / 2))],
  ])('serialized input (%s) → malformed-envelope on decrypt AND re-wrap', (_l, mutate) => {
    const bad = mutate(enc());
    expect(capture(() => dec(bad)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(bad)).code).toBe('malformed-envelope');
  });

  // PROGRAMME 25 NOTE (2026-11-07) — PIN SUPERSEDED, contract
  // TIGHTENED. This test previously ran under the name "DOCUMENTED
  // LENIENCY (observed, probed — not a requirement)" and asserted:
  //   dec(withSpace) === PT   and   dec(e + '=') === PT
  // i.e. whitespace inserted into the body and trailing '=' padding
  // were TOLERATED, because Node's base64url decoder ignores them and
  // the decoded bytes — hence the authenticated content — are
  // identical (recorded as observation O-1 in Programme 24). The
  // ChatGPT Iteration-2 review (finding F25-A, O-1 expanded) showed
  // the decoder also ignores EMBEDDED invalid characters (e.g. '!'),
  // so several distinct strings denoted one payload: the leniency was
  // reclassified from documented observation to defect, and Programme
  // 25 WS1 made the parser accept ONLY canonical unpadded base64url
  // (alphabet check + decode → re-encode round-trip). What replaces
  // the old pin: both mutations now fail 'malformed-envelope' before
  // any key lookup or GCM work. Nothing that previously failed now
  // succeeds. The full WS1 regression matrix (embedded punctuation,
  // standard-base64 alphabet chars, whitespace positions, padding,
  // non-canonical trailing bits, positive canonical pins) lives in
  // tests/p25-envelope-hardening.test.ts §1.
  it('SUPERSEDED PIN (Programme 25): whitespace and trailing padding are now REJECTED as malformed-envelope (was: documented leniency)', () => {
    const e = enc();
    const withSpace = 'env1.' + e.slice(5, 15) + ' ' + e.slice(15);
    expect(capture(() => dec(withSpace)).code).toBe('malformed-envelope');
    expect(capture(() => dec(e + '=')).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(withSpace)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(e + '=')).code).toBe('malformed-envelope');
  });

  it.each([
    ['null', null], ['array', []], ['number', 42], ['object', {}],
  ])('envelope as %s → malformed-envelope on decrypt AND re-wrap', (_l, value) => {
    const v = value as unknown as string;
    expect(capture(() => dec(v)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(v)).code).toBe('malformed-envelope');
  });

  it('wrong-typed FIELDS fail closed with typed errors (no untyped throws)', () => {
    const e = enc();
    expect(capture(() => dec(e, 42 as unknown as string)).code).toBe('tenant-mismatch');
    expect(capture(() => dec(e, A, { k1: 42 as unknown as string })).code).toBe('decrypt-failed');
    expect(capture(() => rewrap(e, A, { k1: K1 }, 42 as unknown as string, K2)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(e, A, { k1: K1 }, 'k2', [] as unknown as string)).code).toBe('decrypt-failed');
  });

  it('encrypt-side wrong-typed fields → typed EnvelopeError (P24 fix: plaintext previously threw an untyped TypeError)', () => {
    expect(capture(() => encryptForTenant({ masterKeyHex: K1, keyId: 'k1', tenantId: A, plaintext: 42 as unknown as string })).code)
      .toBe('malformed-envelope');
    expect(capture(() => encryptForTenant({ masterKeyHex: K1, keyId: 'k1', tenantId: 42 as unknown as string, plaintext: PT })).code)
      .toBe('malformed-envelope');
    expect(capture(() => encryptForTenant({ masterKeyHex: K1, keyId: 42 as unknown as string, tenantId: A, plaintext: PT })).code)
      .toBe('malformed-envelope');
  });
});

// ── §8 Very large envelope ─────────────────────────────────────────────────
describe('P24 §8 — very large envelope', () => {
  it('1 MB plaintext: encrypt → re-wrap → decrypt round-trips byte-for-byte', () => {
    const big = 'Ω'.repeat(500_000); // 500k chars, 1 MB as UTF-8
    expect(Buffer.byteLength(big, 'utf8')).toBe(1_000_000);
    const original = enc(A, 'k1', K1, big);
    const rewrapped = rewrap(original, A, { k1: K1 }, 'k2', K2);
    expect(dec(rewrapped, A, { k2: K2 })).toBe(big);
    expect(dec(original, A, { k1: K1 })).toBe(big);
  });
});

// ── §9 Same-keyId, different material — semantics pinned as tested facts ───
describe('P24 §9 — same-keyId material rotation: tested facts for the lifecycle spec', () => {
  const K1_ROTATED = randomBytes(32).toString('hex'); // same keyId 'k1', NEW material

  it('FACT 1: a same-keyId re-wrap produces an envelope that decrypts under the NEW material and fails under the OLD (decrypt-failed, not unknown-key-id)', () => {
    const out = rewrap(enc(), A, { k1: K1 }, 'k1', K1_ROTATED);
    expect(decode(out)['keyId']).toBe('k1'); // keyId unchanged — indistinguishable by identifier
    expect(dec(out, A, { k1: K1_ROTATED })).toBe(PT);
    expect(capture(() => dec(out, A, { k1: K1 })).code).toBe('decrypt-failed');
  });

  it('FACT 2: pre- and post-rotation envelopes share the keyId but need different material — the keyId alone cannot distinguish them (the A3 ambiguity)', () => {
    const before = enc(); // wrapped under K1 at 'k1'
    const after = rewrap(before, A, { k1: K1 }, 'k1', K1_ROTATED);
    expect(dec(before, A, { k1: K1 })).toBe(PT);
    expect(capture(() => dec(before, A, { k1: K1_ROTATED })).code).toBe('decrypt-failed');
    expect(dec(after, A, { k1: K1_ROTATED })).toBe(PT);
    expect(capture(() => dec(after, A, { k1: K1 })).code).toBe('decrypt-failed');
  });

  it('FACT 3: if the keyring entry is replaced BEFORE the re-wrap runs, the stranded envelope can no longer be rescued (unwrap fails — decrypt-failed)', () => {
    const stranded = enc(); // still wrapped under the OLD material
    // Ring already updated to the rotated material: the rescue path is gone.
    expect(capture(() => rewrap(stranded, A, { k1: K1_ROTATED }, 'k2', K2)).code).toBe('decrypt-failed');
  });

  it('FACT 4: same-keyId re-wrap to the IDENTICAL material is a harmless no-op rotation (fresh wrap IV, same decryptability)', () => {
    const out = rewrap(enc(), A, { k1: K1 }, 'k1', K1);
    expect(dec(out, A, { k1: K1 })).toBe(PT);
  });
});
