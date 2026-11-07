/**
 * Waitlist helpers (preview launch preparation, 2026-11-07).
 *
 * Kept out of src/app/api/waitlist/route.ts on purpose: Next.js route
 * modules may only export HTTP verbs and route config, so the pure
 * validation logic lives here where the route and the tests can both
 * import it.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase a submitted address; null when it is not usable. */
export function normalizeWaitlistEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return EMAIL_RE.test(email) ? email : null;
}
