/**
 * Verified-user email request header — middleware → (main) layout.
 *
 * Slow-load fix (2026-11-23): the (main) layout used to run its own
 * supabase.auth.getUser() on EVERY page load/navigation just to show
 * the sidebar email — one more sequential Auth round-trip on the
 * critical path, after the middleware had already verified the same
 * session for the same request. The middleware now stamps the email
 * of the user it just verified onto the request headers forwarded to
 * the page; the layout reads this header first and only falls back
 * to its own getUser() when the header is absent (e.g. the middleware
 * was bypassed).
 *
 * SAFETY — this header is display-only and never an authorization
 * input:
 *   - It is only ever READ server-side, and only affects the sidebar
 *     email line + Setup nav visibility. The /setup route enforces
 *     its own admin gate; nothing here grants access.
 *   - The middleware DELETES it whenever the request is unverified,
 *     so a client-sent spoof can never survive into a page render.
 *   - The value is the email of the user the middleware verified
 *     with supabase.auth.getUser() on this exact request — never a
 *     local token decode, never client input.
 */
export const VERIFIED_USER_EMAIL_HEADER = 'x-opendm-user-email';

/** Read the stamped email from request headers; blank/absent → null. */
export function readVerifiedUserEmail(headers: Pick<Headers, 'get'>): string | null {
  const value = headers.get(VERIFIED_USER_EMAIL_HEADER);
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
