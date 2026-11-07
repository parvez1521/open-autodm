/**
 * Build Meta-format signed_request values for tests:
 * base64url(HMAC-SHA256(secret, encodedPayload)) + "." + base64url(payload JSON)
 * - the exact construction parseSignedRequest verifies.
 */

import { createHmac } from 'node:crypto';

export function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function buildSignedRequest(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(encodedPayload, 'utf8').digest();
  return `${base64Url(signature)}.${encodedPayload}`;
}

export const IG_SECRET = 'ig-app-secret-for-tests';
export const FB_SECRET = 'fb-app-secret-for-tests';

export function metaPayload(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    algorithm: 'HMAC-SHA256',
    issued_at: 1762000000,
    user_id: userId,
    ...overrides,
  };
}
