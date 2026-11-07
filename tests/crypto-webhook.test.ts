/**
 * Area 7 (primitive level) — Webhook HMAC helpers (src/lib/crypto.ts):
 * hmacSha256Hex + safeCompare, the exact primitives the webhook route
 * composes into its `sha256=<hmac>` signature check. Route-level accept /
 * reject behaviour is covered in webhook-route.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { hmacSha256Hex, safeCompare } from '@/lib/crypto';

describe('hmacSha256Hex', () => {
  it('matches the published HMAC-SHA256 test vector', () => {
    // Widely published vector: key "key", message "The quick brown fox..."
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    );
  });

  it('accepts a Buffer payload identically to a string payload', () => {
    const body = '{"object":"instagram","entry":[]}';
    expect(hmacSha256Hex('secret', Buffer.from(body, 'utf8'))).toBe(hmacSha256Hex('secret', body));
  });

  it('produces different digests for different secrets and bodies', () => {
    expect(hmacSha256Hex('s1', 'body')).not.toBe(hmacSha256Hex('s2', 'body'));
    expect(hmacSha256Hex('s1', 'body')).not.toBe(hmacSha256Hex('s1', 'body-tampered'));
  });
});

describe('safeCompare', () => {
  it('returns true for identical strings', () => {
    expect(safeCompare('sha256=abc123', 'sha256=abc123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(safeCompare('sha256=abc123', 'sha256=abc124')).toBe(false);
  });

  it('returns false for different lengths (forged/truncated signatures)', () => {
    expect(safeCompare('sha256=abc', 'sha256=abc123')).toBe(false);
    expect(safeCompare('', 'sha256=abc123')).toBe(false);
  });

  it('composes into the webhook route signature check (sha256=<hmac>)', () => {
    const secret = 'webhook-secret';
    const rawBody = '{"entry":[]}';
    const header = `sha256=${hmacSha256Hex(secret, Buffer.from(rawBody, 'utf8'))}`;
    expect(safeCompare(header, `sha256=${hmacSha256Hex(secret, Buffer.from(rawBody, 'utf8'))}`)).toBe(true);
    expect(safeCompare(header, `sha256=${hmacSha256Hex(secret, Buffer.from('{}', 'utf8'))}`)).toBe(false);
  });
});
