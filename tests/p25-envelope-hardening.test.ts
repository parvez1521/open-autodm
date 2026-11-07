/**
 * Programme 25 — Envelope format hardening & keyring correctness.
 *
 * Triage outcome of the ChatGPT independent review of Programme 24
 * (Master Task loop, Iteration 2; verdict ACCEPTED WITH
 * QUALIFICATIONS). The review inspected the actual source and returned
 * three findings against `src/lib/crypto/envelope.ts`, all
 * independently re-verified against the pre-fix implementation with a
 * temporary probe before being closed here (same unit tier as
 * P16/P17/P23/P24: real cryptography, synthetic in-test keys; no
 * higher tier claimed):
 *
 *  §1 (F25-A / O-1 expanded) — the serialized parser decoded via
 *     Node's base64url decoder with NO lexical validation. The decoder
 *     ignores whitespace and trailing padding (P24's O-1) AND embedded
 *     invalid characters (the review's repro: 'eyJhIjoxfQ' and
 *     'eyJh!IjoxfQ' decode identically), so several distinct strings
 *     denoted one payload. WS1: the parser now accepts ONLY canonical
 *     unpadded base64url (alphabet check + decode → re-encode
 *     round-trip). P24 §7's leniency pin was superseded there with a
 *     dated note; this section is the full regression matrix.
 *  §2 (F25-B) — `isGcmSealed` accepted any non-empty hex IV/tag, so a
 *     GENUINELY AUTHENTICATED envelope built with an 8-byte IV passed
 *     structural checks and decrypted, contradicting the documented
 *     12-byte-IV / 16-byte-tag format. WS2: IV = exactly 24 hex chars
 *     and tag = exactly 32 hex chars are enforced structurally for
 *     BOTH seals. Every envelope here is built with raw Node crypto
 *     and PROVEN cryptographically valid by a raw-crypto control open
 *     — the library's rejection is the format contract, never an
 *     authentication failure. P24 §3's wrong-length expectations were
 *     tightened there with dated notes.
 *  §3 (F25-C) — keyring lookup used plain indexing, so keyIds naming
 *     inherited Object properties ('constructor', 'toString', …)
 *     resolved instead of being absent, yielding 'decrypt-failed'
 *     where the contract requires 'unknown-key-id'. WS3: own-property
 *     lookup (`Object.hasOwn`) at both call sites.
 *  §4 (test-completeness) — independent data-seal AAD isolation: the
 *     P24 §1 transplant scenarios fail at DEK unwrap, so no test had
 *     isolated the DATA seal's AAD. Here the wrapped DEK is valid
 *     under the target tenant's context (byte-identical to a control
 *     that decrypts) while ONLY the data seal is authenticated under
 *     the other tenant — decrypt must fail, and the failure is
 *     attributable to the data seal alone.
 *  §5 (test-completeness) — non-string master keys pinned table-driven
 *     across ALL FOUR key-consuming paths (encrypt, decrypt ring
 *     entry, re-wrap current ring entry, re-wrap target).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  encryptForTenant,
  decryptForTenant,
  rewrapForTenant,
  EnvelopeError,
} from '@/lib/crypto/envelope';

const K1 = randomBytes(32).toString('hex');
const K2 = randomBytes(32).toString('hex');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PT = 'SYNTHETIC-P25-SECRET-MARKER-0123456789';

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

function capture(fn: () => unknown): EnvelopeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvelopeError);
    return err as EnvelopeError;
  }
  throw new Error('expected the call to throw');
}

// ── §1 (F25-A) Serialized-parser hardening — canonical base64url only ──────
describe('P25 §1 — parser accepts only canonical unpadded base64url (F25-A / O-1 closed)', () => {
  it('documented decoder fact being defended against: Node base64url ignores an EMBEDDED invalid character', () => {
    // The ChatGPT Iteration-2 repro at the raw-decoder level. This pins
    // the PLATFORM behaviour that makes lexical validation necessary —
    // the library itself must never rely on the decoder's leniency.
    expect(Buffer.from('eyJhIjoxfQ', 'base64url').equals(Buffer.from('eyJh!IjoxfQ', 'base64url'))).toBe(true);
  });

  it.each([
    ['embedded "!"', (body: string) => body.slice(0, 10) + '!' + body.slice(10)],
    ['embedded "."', (body: string) => body.slice(0, 10) + '.' + body.slice(10)],
    ['embedded "+" (standard-base64 alphabet)', (body: string) => body.slice(0, 10) + '+' + body.slice(10)],
    ['embedded "/" (standard-base64 alphabet)', (body: string) => body.slice(0, 10) + '/' + body.slice(10)],
  ])('embedded punctuation (%s) inserted into the body → malformed-envelope on decrypt AND re-wrap', (_l, mutate) => {
    const e = enc();
    const forged = 'env1.' + mutate(e.slice('env1.'.length));
    expect(capture(() => dec(forged)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(forged)).code).toBe('malformed-envelope');
  });

  it.each([
    ['leading space (immediately after the prefix)', (body: string) => ' ' + body],
    ['inner space', (body: string) => body.slice(0, 15) + ' ' + body.slice(15)],
    ['inner newline', (body: string) => body.slice(0, 15) + '\n' + body.slice(15)],
    ['inner tab', (body: string) => body.slice(0, 15) + '\t' + body.slice(15)],
    ['trailing space', (body: string) => body + ' '],
  ])('whitespace (%s) → malformed-envelope on decrypt AND re-wrap', (_l, mutate) => {
    const e = enc();
    const forged = 'env1.' + mutate(e.slice('env1.'.length));
    expect(capture(() => dec(forged)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(forged)).code).toBe('malformed-envelope');
  });

  it.each([
    ['single "=" padding', (e: string) => e + '='],
    ['double "==" padding', (e: string) => e + '=='],
  ])('trailing padding (%s) → malformed-envelope on decrypt AND re-wrap', (_l, mutate) => {
    const forged = mutate(enc());
    expect(capture(() => dec(forged)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(forged)).code).toBe('malformed-envelope');
  });

  it('empty component ("env1." with no body) → malformed-envelope on decrypt AND re-wrap', () => {
    expect(capture(() => dec('env1.')).code).toBe('malformed-envelope');
    expect(capture(() => rewrap('env1.')).code).toBe('malformed-envelope');
  });

  it('non-canonical trailing bits: a different string decoding to IDENTICAL bytes → malformed-envelope (round-trip check, not the alphabet check, catches this)', () => {
    // When the body's length mod 4 is 2 or 3, the final character
    // carries unused low bits. Flipping one yields a DIFFERENT string
    // over the SAME alphabet that the raw decoder maps to the SAME
    // bytes — the alphabet check alone cannot reject it; only the
    // decode → re-encode byte-comparison can. Find such a mutation
    // deterministically across a few plaintext lengths.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let original: string | undefined;
    let forged: string | undefined;
    let sourcePt = '';
    for (let n = 0; n < 16 && forged === undefined; n++) {
      const e = enc(A, 'k1', K1, 'x'.repeat(n));
      const body = e.slice('env1.'.length);
      if (body.length % 4 !== 2 && body.length % 4 !== 3) continue;
      const idx = ALPHABET.indexOf(body[body.length - 1]!);
      for (const bit of [1, 2, 4, 8]) {
        const mutated = body.slice(0, -1) + ALPHABET[idx ^ bit];
        if (mutated !== body && Buffer.from(mutated, 'base64url').equals(Buffer.from(body, 'base64url'))) {
          original = e;
          forged = 'env1.' + mutated;
          sourcePt = 'x'.repeat(n);
          break;
        }
      }
    }
    expect(forged).toBeDefined();
    // Preconditions: the forged string is a genuinely DIFFERENT
    // serialized form of the SAME payload — it differs from the
    // original envelope string, it is alphabet-clean (so only the
    // round-trip check can catch it), and it decodes to identical
    // bytes (so pre-P25 it authenticated — the §1 probe proved this
    // shape live). The original still decrypts; the twin must not.
    expect(forged).not.toBe(original);
    expect(forged!.slice('env1.'.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      Buffer.from(forged!.slice('env1.'.length), 'base64url')
        .equals(Buffer.from(original!.slice('env1.'.length), 'base64url')),
    ).toBe(true);
    expect(dec(original!)).toBe(sourcePt);
    expect(capture(() => dec(forged!)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(forged!)).code).toBe('malformed-envelope');
  });

  it.each([
    ['empty plaintext', ''],
    ['single char', 'a'],
    ['marker', PT],
    ['unicode + emoji', '🔐 токен — テスト ✓ café'],
    ['10 KB', 'x'.repeat(10_000)],
    ['1 MB', 'Ω'.repeat(500_000)],
  ])('positive pin (%s): every self-produced envelope is canonical — alphabet-clean, re-encodes to itself, decrypts and re-wraps', (_l, pt) => {
    const e = enc(A, 'k1', K1, pt);
    const body = e.slice('env1.'.length);
    expect(e).toMatch(/^env1\.[A-Za-z0-9_-]+$/);
    // Canonical by construction: decoding and re-encoding reproduces
    // the exact component the encryptor emitted (no padding, no
    // non-canonical trailing bits) — so WS1 can never reject a
    // self-produced envelope.
    expect(Buffer.from(body, 'base64url').toString('base64url')).toBe(body);
    expect(dec(e)).toBe(pt);
    expect(dec(rewrap(e), A, { k2: K2 })).toBe(pt);
  });
});

// ── §2 (F25-B) Format enforcement — genuinely authenticated non-standard ───
// IV / tag lengths, rejected structurally.

interface RawSeal { iv: string; ct: string; tag: string }

function rawSeal(key: Buffer, data: Buffer, aad: string, ivLength: number, tagLength: number): RawSeal {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagLength });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv: iv.toString('hex'), ct: ct.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function rawOpen(key: Buffer, sealed: RawSeal, aad: string): Buffer {
  const tag = Buffer.from(sealed.tag, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'), {
    authTagLength: tag.length,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'hex')), decipher.final()]);
}

interface RawShape { wrapIv: number; wrapTag: number; dataIv: number; dataTag: number }
const STANDARD: RawShape = { wrapIv: 12, wrapTag: 16, dataIv: 12, dataTag: 16 };

function buildRawEnvelope(shape: RawShape): { envelope: string; dek: Buffer; wrappedDek: RawSeal; data: RawSeal } {
  const kek = Buffer.from(K1, 'hex');
  const dek = randomBytes(32);
  const wrappedDek = rawSeal(kek, dek, A, shape.wrapIv, shape.wrapTag);
  const data = rawSeal(dek, Buffer.from(PT, 'utf8'), A, shape.dataIv, shape.dataTag);
  const payload = { v: 1, tenantId: A, keyId: 'k1', wrappedDek, iv: data.iv, ct: data.ct, tag: data.tag };
  return { envelope: 'env1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), dek, wrappedDek, data };
}

/** Prove the raw-built envelope is GENUINELY authenticated: raw crypto opens both seals. */
function expectRawAuthenticates(shape: RawShape): string {
  const { envelope, dek, wrappedDek, data } = buildRawEnvelope(shape);
  expect(rawOpen(Buffer.from(K1, 'hex'), wrappedDek, A).equals(dek)).toBe(true);
  expect(rawOpen(dek, data, A).toString('utf8')).toBe(PT);
  return envelope;
}

describe('P25 §2 — IV/tag format enforcement against genuinely authenticated envelopes (F25-B)', () => {
  it('control: a raw-built envelope with the STANDARD shape (12-byte IVs, 16-byte tags) decrypts via the library', () => {
    expect(dec(expectRawAuthenticates(STANDARD))).toBe(PT);
  });

  it.each([8, 11, 13, 16])('wrapped-DEK IV of %i bytes (valid tag, genuinely authenticated) → malformed-envelope on decrypt AND re-wrap', (iv) => {
    const envelope = expectRawAuthenticates({ ...STANDARD, wrapIv: iv });
    expect(capture(() => dec(envelope)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(envelope)).code).toBe('malformed-envelope');
  });

  it.each([8, 11, 13, 16])('data-seal IV of %i bytes (valid tag, genuinely authenticated) → malformed-envelope on decrypt AND re-wrap', (iv) => {
    const envelope = expectRawAuthenticates({ ...STANDARD, dataIv: iv });
    expect(capture(() => dec(envelope)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(envelope)).code).toBe('malformed-envelope');
  });

  it.each([8, 12])('wrapped-DEK tag of %i bytes (genuinely authenticated) → malformed-envelope on decrypt AND re-wrap', (tag) => {
    const envelope = expectRawAuthenticates({ ...STANDARD, wrapTag: tag });
    expect(capture(() => dec(envelope)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(envelope)).code).toBe('malformed-envelope');
  });

  it.each([8, 12])('data-seal tag of %i bytes (genuinely authenticated) → malformed-envelope on decrypt AND re-wrap', (tag) => {
    const envelope = expectRawAuthenticates({ ...STANDARD, dataTag: tag });
    expect(capture(() => dec(envelope)).code).toBe('malformed-envelope');
    expect(capture(() => rewrap(envelope)).code).toBe('malformed-envelope');
  });
});

// ── §3 (F25-C) Keyring own-property lookup ─────────────────────────────────
describe('P25 §3 — keyring lookup is own-property only (F25-C)', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'keyId "%s" ABSENT from the keyring (inherited property only) → unknown-key-id on decrypt AND re-wrap (was: decrypt-failed)',
    (keyId) => {
      const e = enc(A, keyId, K1);
      const err = capture(() => dec(e, A, {}));
      expect(err.code).toBe('unknown-key-id');
      expect(capture(() => rewrap(e, A, {}, 'k2', K2)).code).toBe('unknown-key-id');
    },
  );

  it('the unknown-key-id message still echoes the stored keyId verbatim (SEC-11 pinned contract, unchanged)', () => {
    const e = enc(A, 'constructor', K1);
    expect(capture(() => dec(e, A, {})).message).toBe(
      "No master key in the keyring for keyId 'constructor'.",
    );
  });

  it.each(['constructor', 'toString'])(
    'a keyring that genuinely OWNS the keyId "%s" still decrypts and re-wraps',
    (keyId) => {
      const e = enc(A, keyId, K1);
      const ring: Record<string, string> = {};
      ring[keyId] = K1; // an OWN property (assignment creates one, even for 'constructor')
      expect(Object.hasOwn(ring, keyId)).toBe(true);
      expect(dec(e, A, ring)).toBe(PT);
      expect(dec(rewrap(e, A, ring, 'k2', K2), A, { k2: K2 })).toBe(PT);
    },
  );

  it('a null-prototype keyring works (Object.hasOwn does not depend on the prototype chain)', () => {
    const ring: Record<string, string> = Object.create(null);
    ring['k1'] = K1;
    expect(dec(enc(), A, ring)).toBe(PT);
  });

  it('a key reachable only through the keyring PROTOTYPE chain counts as absent → unknown-key-id', () => {
    const ring: Record<string, string> = Object.create({ k1: K1 });
    expect(capture(() => dec(enc(), A, ring)).code).toBe('unknown-key-id');
  });

  it('an own property explicitly set to undefined is still "absent" → unknown-key-id (prior semantics preserved)', () => {
    expect(capture(() => dec(enc(), A, { k1: undefined as unknown as string })).code).toBe('unknown-key-id');
  });
});

// ── §4 Independent data-seal AAD isolation (test-completeness) ─────────────
describe('P25 §4 — data-seal AAD isolation, independent of the DEK-wrap AAD', () => {
  // Construction (raw crypto — the library API cannot express split
  // AADs): ONE wrapped DEK, sealed under tenant B's context (valid for
  // B — the unwrap under B succeeds). The data seal is then made twice
  // over the SAME DEK: once with AAD = B (control) and once with
  // AAD = A (the isolation case). The wrappedDek bytes are IDENTICAL
  // in both envelopes, so any difference in outcome is attributable
  // to the data seal's AAD alone — the gap P24 §1 could not isolate
  // (its transplants all failed earlier, at unwrap).
  const kekB = randomBytes(32);
  const dek = randomBytes(32);
  const wrappedDek = rawSeal(kekB, dek, B, 12, 16);
  const buildWithDataAad = (dataAad: string): string => {
    const data = rawSeal(dek, Buffer.from(PT, 'utf8'), dataAad, 12, 16);
    const payload = { v: 1, tenantId: B, keyId: 'kB', wrappedDek, iv: data.iv, ct: data.ct, tag: data.tag };
    return 'env1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  };
  const ringB: Record<string, string> = { kB: kekB.toString('hex') };

  it('control: data seal authenticated under B (matching the wrap) → decrypts for B', () => {
    expect(dec(buildWithDataAad(B), B, ringB)).toBe(PT);
  });

  it('wrapped DEK valid under B, data seal authenticated under A → decrypt-failed, at the DATA seal specifically', () => {
    // The unwrap cannot be the failure: the identical wrappedDek bytes
    // open in the control above. The stored-tenant check passes
    // (stored === requested === B) and the keyId resolves. Only the
    // data seal's AAD (A ≠ B at decrypt time) can fail — and it does.
    expect(capture(() => dec(buildWithDataAad(A), B, ringB)).code).toBe('decrypt-failed');
  });

  it('mirror: wrapped DEK authenticated under A (invalid for B) with data seal under B → decrypt-failed at the UNWRAP (each seal\'s AAD is independently load-bearing)', () => {
    const wrappedForA = rawSeal(kekB, dek, A, 12, 16);
    const data = rawSeal(dek, Buffer.from(PT, 'utf8'), B, 12, 16);
    const payload = { v: 1, tenantId: B, keyId: 'kB', wrappedDek: wrappedForA, iv: data.iv, ct: data.ct, tag: data.tag };
    const envelope = 'env1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(capture(() => dec(envelope, B, ringB)).code).toBe('decrypt-failed');
  });
});

// ── §5 Non-string master keys, table-driven across all four paths ──────────
describe('P25 §5 — non-string master keys rejected on EVERY key-consuming path', () => {
  const NON_STRINGS: Array<[string, unknown]> = [
    ['number', 42],
    ['null', null],
    ['boolean', true],
    ['plain object', {}],
    ['array', []],
    ['Buffer (32 bytes — right size, wrong type)', randomBytes(32)],
  ];

  it.each(NON_STRINGS)('encrypt path: masterKeyHex as %s → decrypt-failed', (_l, value) => {
    expect(capture(() => encryptForTenant({
      masterKeyHex: value as string, keyId: 'k1', tenantId: A, plaintext: PT,
    })).code).toBe('decrypt-failed');
  });

  it.each(NON_STRINGS)('decrypt path: keyring entry as %s → decrypt-failed', (_l, value) => {
    expect(capture(() => dec(enc(), A, { k1: value as string })).code).toBe('decrypt-failed');
  });

  it.each(NON_STRINGS)('re-wrap CURRENT-key path: keyring entry as %s → decrypt-failed', (_l, value) => {
    expect(capture(() => rewrap(enc(), A, { k1: value as string }, 'k2', K2)).code).toBe('decrypt-failed');
  });

  it.each(NON_STRINGS)('re-wrap TARGET-key path: newMasterKeyHex as %s → decrypt-failed', (_l, value) => {
    // Reached only after a successful unwrap (precedence note PN-1):
    // the envelope and current key are valid here by construction.
    expect(capture(() => rewrap(enc(), A, { k1: K1 }, 'k2', value as string)).code).toBe('decrypt-failed');
  });

  it.each([
    ['encrypt path', () => encryptForTenant({ masterKeyHex: undefined as unknown as string, keyId: 'k1', tenantId: A, plaintext: PT })],
    // Direct call (not the `rewrap` helper): the helper's default
    // parameter would substitute K2 for an explicit `undefined`.
    ['re-wrap target path', () => rewrapForTenant({
      envelope: enc(), tenantId: A, keyring: { k1: K1 }, newKeyId: 'k2',
      newMasterKeyHex: undefined as unknown as string,
    })],
  ])('undefined master key on the %s → decrypt-failed (ring paths treat undefined as absence instead — §3)', (_l, fn) => {
    expect(capture(fn).code).toBe('decrypt-failed');
  });
});
