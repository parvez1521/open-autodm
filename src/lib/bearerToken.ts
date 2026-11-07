/**
 * Shared `Authorization: Bearer …` header parsing — the ONE parser for
 * every user-auth layer.
 *
 * WHY THIS MODULE EXISTS: RFC 9110 §11.1 states that HTTP
 * authentication scheme names are case-insensitive. Both user-auth
 * layers previously recognised the Bearer scheme only via the literal
 * case-sensitive prefix `Bearer `, so a valid credential sent as
 * `bearer <jwt>` or `BEARER <jwt>` was not recognised as Bearer at
 * all and silently fell through to cookie authentication — the
 * request authenticated as the cookie user (or failed) instead of
 * the Bearer identity. BOTH layers must use this parser so they can
 * never disagree about whether a Bearer credential was supplied:
 *   - src/lib/auth.ts                  (getAuthenticatedUser)
 *   - src/lib/supabase/userClient.ts   (createUserRpcClient)
 * (The cron route's `Bearer ` check is a server-to-server
 * exact-secret comparison — a different contract — and deliberately
 * does NOT use this parser.)
 *
 * PARSING CONTRACT (the exact semantics both callers rely on):
 *   Input:  the raw `Authorization` header value
 *           (string | null | undefined). The platform Headers API
 *           already strips leading/trailing value whitespace, so
 *           parsing operates on that normalized value.
 *   Output: a discriminated result —
 *     { kind: 'none' }         header absent or empty; no credential
 *                              of any scheme was supplied.
 *     { kind: 'other-scheme' } a scheme is present but is not Bearer
 *                              (e.g. `Basic …`, `Token …`). Callers
 *                              treat this EXACTLY as "no Bearer
 *                              supplied".
 *     { kind: 'bearer', token } the scheme token, compared ASCII
 *                              case-insensitively, is `bearer`.
 *
 *   Grammar: the scheme is the first run of non-space characters;
 *   the separator is one or more SP (0x20) characters, ALL of which
 *   are consumed (RFC 9110 credentials grammar uses 1*SP); the token
 *   is the remainder of the header BYTE-FOR-BYTE — never trimmed,
 *   never case-folded, never otherwise modified.
 *   A Bearer scheme with no separator and no token (bare `Bearer` /
 *   `bearer` with nothing after it) yields
 *   { kind: 'bearer', token: '' }.
 *   A tab is NOT a separator: `Bearer\t<jwt>` parses as one
 *   non-space scheme run ≠ bearer, i.e. 'other-scheme'.
 *   `token` may be an empty string when the token is missing;
 *   callers MUST treat an empty or whitespace-only token as
 *   malformed and fail closed (never fall back to another
 *   transport).
 *
 * This module is pure: no imports beyond types, no I/O, no logging.
 */

export type BearerParseResult =
  | { kind: 'none' }
  | { kind: 'other-scheme' }
  | { kind: 'bearer'; token: string };

/** ASCII case-insensitive equality (A–Z folds to a–z; nothing else folds). */
function asciiEqualsIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca >= 0x41 && ca <= 0x5a) ca += 0x20;
    if (cb >= 0x41 && cb <= 0x5a) cb += 0x20;
    if (ca !== cb) return false;
  }
  return true;
}

export function parseBearerToken(header: string | null | undefined): BearerParseResult {
  if (header === null || header === undefined || header.length === 0) {
    return { kind: 'none' };
  }

  const firstSpace = header.indexOf(' ');
  const scheme = firstSpace === -1 ? header : header.slice(0, firstSpace);
  if (!asciiEqualsIgnoreCase(scheme, 'bearer')) {
    return { kind: 'other-scheme' };
  }
  if (firstSpace === -1) {
    // Bare scheme, no separator and no token ⇒ malformed Bearer.
    return { kind: 'bearer', token: '' };
  }

  // Consume ALL SP (0x20) separators; the token is the remainder,
  // byte-for-byte.
  let i = firstSpace;
  while (i < header.length && header.charCodeAt(i) === 0x20) i++;
  return { kind: 'bearer', token: header.slice(i) };
}
