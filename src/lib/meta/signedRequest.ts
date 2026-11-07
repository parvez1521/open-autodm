/**
 * Meta `signed_request` parsing and verification.
 *
 * Meta POSTs a signed_request to the deauthorize and data-deletion
 * callbacks. Format (Meta's official sample):
 *
 *   signed_request = base64url(signature) + "." + base64url(payload JSON)
 *
 * CRITICAL: the signature is HMAC-SHA256 over the *still-encoded* payload
 * segment (the base64url string exactly as received), keyed with the App
 * Secret - NOT over the decoded JSON. Payload fields relied on here:
 * `algorithm` (must be "HMAC-SHA256"), `user_id` (app-scoped ID), `issued_at`.
 *
 * Pure and side-effect free so it can be unit-tested without a database.
 * Never logs - and callers must never log - the raw signed_request, any
 * signature, or any secret.
 */

import { createHmac } from 'node:crypto';
import { safeCompare } from '@/lib/crypto';

export interface SignedRequestData {
  /** App-scoped user ID from the verified payload (IG-scoped ID for IG Login). */
  userId: string;
  /** `issued_at` from the payload (unix seconds), or null when absent/invalid. */
  issuedAt: number | null;
}

function base64UrlToBuffer(segment: string): Buffer {
  // Meta's base64_url_decode: translate the URL-safe alphabet, then decode.
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify and parse a signed_request against a list of candidate secrets.
 *
 * Accepts the request if ANY candidate verifies (callers pass the Instagram
 * App Secret first, then the parent Facebook App Secret - Meta signs IG
 * Login callbacks with the IG secret, but accepting either removes the
 * parent-vs-IG ambiguity, mirroring the webhook verifier).
 *
 * Returns null for ANY failure: malformed input, non-JSON payload, wrong
 * algorithm, signature mismatch, or a missing/empty user_id. On null the
 * caller must process nothing.
 */
export function parseSignedRequest(raw: string, candidateSecrets: string[]): SignedRequestData | null {
  if (typeof raw !== 'string' || candidateSecrets.length === 0) return null;

  // Exactly two segments: encoded_sig "." encoded_payload. Neither segment
  // can itself contain a dot (base64url alphabet has none).
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const encodedSig = raw.slice(0, dot);
  const encodedPayload = raw.slice(dot + 1);
  if (encodedPayload.includes('.')) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlToBuffer(encodedPayload).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;

  // Meta's official sample rejects any other algorithm.
  const algorithm = typeof data['algorithm'] === 'string' ? data['algorithm'].toUpperCase() : '';
  if (algorithm !== 'HMAC-SHA256') return null;

  // HMAC over the ENCODED payload segment, compared in constant time.
  // (Hex encodings of both digests are compared so safeCompare's length
  // check rejects truncated/forged signatures before timingSafeEqual.)
  const receivedSigHex = base64UrlToBuffer(encodedSig).toString('hex');
  let verified = false;
  for (const secret of candidateSecrets) {
    if (!secret) continue;
    const expectedSigHex = createHmac('sha256', secret).update(encodedPayload, 'utf8').digest('hex');
    if (safeCompare(expectedSigHex, receivedSigHex)) {
      verified = true;
      break;
    }
  }
  if (!verified) return null;

  // user_id is the only field the callbacks act on. Meta sends it as a
  // string; accept a JSON number defensively and normalise to string.
  const rawUserId = data['user_id'];
  const userId =
    typeof rawUserId === 'string' ? rawUserId : typeof rawUserId === 'number' ? String(rawUserId) : '';
  if (!userId) return null;

  const rawIssuedAt = data['issued_at'];
  const issuedAt = typeof rawIssuedAt === 'number' && Number.isFinite(rawIssuedAt) ? rawIssuedAt : null;

  return { userId, issuedAt };
}
