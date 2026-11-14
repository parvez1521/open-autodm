/**
 * Pure helpers for resolving an Instagram post from a pasted link.
 *
 * Why this exists (2026-11-15): the picker's list comes from the Graph
 * API `/{ig-user-id}/media`, which returns ONLY posts where the
 * connected account is the collaboration OWNER (first-named in the
 * collab header). Collab posts owned by the other account — e.g. the
 * Nov 14 "Clone any tool" reel, owned by tech_hacks.ai with
 * @beyond_the.feed as collaborator — never appear in the grid, no
 * matter how often the user hits Refresh. Pasting the post's link
 * resolves it by ID instead, which the API does return.
 *
 * Kept in a plain .ts module (no JSX) so the node-environment
 * Vitest suite can import it.
 */

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Extract the shortcode from an Instagram post URL. Accepts
 * instagram.com/p/{code}, /reel/{code}, /reels/{code} and /tv/{code}
 * (any instagram.com subdomain), with or without a trailing slash
 * or query params. Returns null for anything else — non-Instagram
 * hosts, profile/explore URLs, empty codes.
 */
export function extractInstagramShortcode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const kind = segments[0];
  const code = segments[1];
  if (kind === undefined || code === undefined) return null;
  if (kind !== 'p' && kind !== 'reel' && kind !== 'reels' && kind !== 'tv') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
  return code;
}

/** Canonical post URL for a shortcode (what oEmbed receives). */
export function normalizeInstagramPostUrl(shortcode: string): string {
  return `https://www.instagram.com/p/${shortcode}/`;
}

/**
 * Decode an Instagram shortcode to its numeric media ID (decimal
 * string). A shortcode IS the media ID encoded in base-64 with
 * alphabet A-Za-z0-9-_ — the same encoding every public
 * shortcode-to-ID tool uses. BigInt because media IDs exceed
 * Number.MAX_SAFE_INTEGER. Returns null for an invalid shortcode.
 */
export function decodeInstagramShortcode(shortcode: string): string | null {
  if (!shortcode || !/^[A-Za-z0-9_-]+$/.test(shortcode)) return null;
  let id = 0n;
  for (const char of shortcode) {
    const digit = SHORTCODE_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    id = id * 64n + BigInt(digit);
  }
  return id.toString();
}

/** Inverse of decodeInstagramShortcode (used by the round-trip test). */
export function encodeInstagramShortcode(mediaId: string): string {
  let id: bigint;
  try {
    id = BigInt(mediaId);
  } catch {
    return '';
  }
  if (id < 0n) return '';
  if (id === 0n) return SHORTCODE_ALPHABET.charAt(0);
  let out = '';
  while (id > 0n) {
    out = SHORTCODE_ALPHABET.charAt(Number(id % 64n)) + out;
    id = id / 64n;
  }
  return out;
}
