/**
 * Area 1 — Meta signed_request verification (src/lib/meta/signedRequest.ts).
 * Pure-function tests: no mocks, no DB, no network.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { parseSignedRequest } from '@/lib/meta/signedRequest';
import { base64Url, buildSignedRequest, metaPayload, IG_SECRET, FB_SECRET } from './helpers/signedRequest';

const SECRETS = [IG_SECRET, FB_SECRET];

describe('parseSignedRequest', () => {
  it('accepts a correctly signed request and extracts user_id + issued_at', () => {
    const sr = buildSignedRequest(metaPayload('17841400008460056'), IG_SECRET);
    const parsed = parseSignedRequest(sr, SECRETS);
    expect(parsed).toEqual({ userId: '17841400008460056', issuedAt: 1762000000 });
  });

  it('accepts a request signed with the fallback (Facebook) secret', () => {
    const sr = buildSignedRequest(metaPayload('999'), FB_SECRET);
    expect(parseSignedRequest(sr, SECRETS)?.userId).toBe('999');
  });

  it('rejects a tampered payload (payload swapped after signing)', () => {
    const sr = buildSignedRequest(metaPayload('victim'), IG_SECRET);
    const sig = sr.split('.')[0]!;
    const tampered = `${sig}.${base64Url(JSON.stringify(metaPayload('attacker')))}`;
    expect(parseSignedRequest(tampered, SECRETS)).toBeNull();
  });

  it('rejects a signature made with the wrong secret', () => {
    const sr = buildSignedRequest(metaPayload('123'), 'some-other-secret');
    expect(parseSignedRequest(sr, SECRETS)).toBeNull();
  });

  it('rejects when no candidate secrets are configured', () => {
    const sr = buildSignedRequest(metaPayload('123'), IG_SECRET);
    expect(parseSignedRequest(sr, [])).toBeNull();
  });

  it('rejects a non-HMAC-SHA256 algorithm even when correctly signed', () => {
    const sr = buildSignedRequest(metaPayload('123', { algorithm: 'HMAC-SHA1' }), IG_SECRET);
    expect(parseSignedRequest(sr, SECRETS)).toBeNull();
  });

  it('accepts the algorithm value case-insensitively', () => {
    const sr = buildSignedRequest(metaPayload('123', { algorithm: 'hmac-sha256' }), IG_SECRET);
    expect(parseSignedRequest(sr, SECRETS)?.userId).toBe('123');
  });

  it('rejects a signature computed over the DECODED JSON (HMAC must cover the encoded segment)', () => {
    const payload = metaPayload('123');
    const decodedJson = JSON.stringify(payload);
    const sigOverDecoded = createHmac('sha256', IG_SECRET).update(decodedJson, 'utf8').digest();
    const sr = `${base64Url(sigOverDecoded)}.${base64Url(decodedJson)}`;
    expect(parseSignedRequest(sr, SECRETS)).toBeNull();
  });

  it('rejects malformed inputs', () => {
    for (const bad of ['', 'garbage', 'a.b.c', '.', 'abc.', '.abc', 'a.b']) {
      expect(parseSignedRequest(bad, SECRETS)).toBeNull();
    }
  });

  it('rejects a correctly signed payload that is not JSON', () => {
    const encodedPayload = base64Url('this is not json');
    const sig = createHmac('sha256', IG_SECRET).update(encodedPayload, 'utf8').digest();
    expect(parseSignedRequest(`${base64Url(sig)}.${encodedPayload}`, SECRETS)).toBeNull();
  });

  it('rejects a payload with a missing or empty user_id', () => {
    const noUser = buildSignedRequest({ algorithm: 'HMAC-SHA256', issued_at: 1 }, IG_SECRET);
    const emptyUser = buildSignedRequest(metaPayload(''), IG_SECRET);
    expect(parseSignedRequest(noUser, SECRETS)).toBeNull();
    expect(parseSignedRequest(emptyUser, SECRETS)).toBeNull();
  });

  it('normalises a numeric user_id to a string', () => {
    const sr = buildSignedRequest(metaPayload('x', { user_id: 12345678 }), IG_SECRET);
    expect(parseSignedRequest(sr, SECRETS)?.userId).toBe('12345678');
  });

  it('returns issuedAt null when issued_at is absent', () => {
    const sr = buildSignedRequest({ algorithm: 'HMAC-SHA256', user_id: '42' }, IG_SECRET);
    expect(parseSignedRequest(sr, SECRETS)).toEqual({ userId: '42', issuedAt: null });
  });
});
