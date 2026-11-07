/**
 * Phase 10.3 E2E harness — the no-real-DM guarantee, implemented.
 *
 * Outbound Meta traffic in the candidate funnels through exactly two
 * modules, both on the global `fetch`:
 *   - src/lib/instagram/api.ts   → https://graph.instagram.com/v23.0/…
 *   - src/lib/instagram/oauth.ts → https://api.instagram.com/… and
 *                                  https://graph.instagram.com/…
 * (There is no graph.facebook.com usage in the candidate — Instagram
 * Business Login talks to graph.instagram.com — but the guard blocks
 * both Graph hosts plus the Instagram OAuth hosts, so a future code
 * path cannot slip past it.)
 *
 * Two interception layers, used together:
 *   1. Module mock — engine-level journeys mock `@/lib/instagram/api`
 *      with counting vi.fn()s (the established parity-suite pattern);
 *      a send can then only ever increment a counter.
 *   2. Fetch guard — every E2E file ALSO stubs global fetch with
 *      `createFetchGuard()`: any fetch to a Meta host that was NOT
 *      explicitly routed by a test's mock router throws
 *      MetaBlockedError. An unmocked Meta call therefore fails the
 *      test loudly instead of reaching the network. There is no code
 *      path in this harness that can produce a real DM.
 */

import { vi } from 'vitest';

export const META_HOSTS = new Set([
  'graph.facebook.com',
  'graph.instagram.com',
  'api.instagram.com',
  'www.instagram.com',
]);

export class MetaBlockedError extends Error {
  constructor(url: string) {
    super(
      `E2E HARNESS BLOCK: unmocked fetch to Meta host (${url}). ` +
        'The harness must never reach Meta — mock @/lib/instagram/api or route the URL in the test fetch router.'
    );
    this.name = 'MetaBlockedError';
  }
}

export function isMetaUrl(input: unknown): boolean {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url?: string })?.url ?? '');
    return META_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return ((input as { url?: string })?.url ?? String(input));
}

export interface FetchGuard {
  fetchImpl: (input: unknown, init?: unknown) => Promise<Response>;
  /** Every URL the stub was called with, in order. */
  attempts: string[];
  /** Subset of attempts that targeted a Meta host (all blocked/routed). */
  metaAttempts: string[];
}

/**
 * Global-fetch stub that makes real Meta traffic impossible:
 *  - Meta host + a router that recognises the URL → the router's
 *    synthetic response (still no network — the router is local code).
 *  - Meta host + no matching route → throws MetaBlockedError.
 *  - Non-Meta host → throws unless a fallback handler was supplied.
 */
export function createFetchGuard(
  router?: (url: string, init?: unknown) => Response | null,
  fallback?: (url: string, init?: unknown) => Promise<Response>
): FetchGuard {
  const attempts: string[] = [];
  const metaAttempts: string[] = [];
  const fetchImpl = async (input: unknown, init?: unknown): Promise<Response> => {
    const url = urlOf(input);
    attempts.push(url);
    if (isMetaUrl(input)) {
      metaAttempts.push(url);
      const routed = router?.(url, init);
      if (routed) return routed;
      throw new MetaBlockedError(url);
    }
    if (fallback) return fallback(url, init);
    throw new Error(`E2E HARNESS BLOCK: unmocked non-Meta fetch to ${url}`);
  };
  return { fetchImpl: fetchImpl as FetchGuard['fetchImpl'], attempts, metaAttempts };
}

/** Install a fetch guard as the global fetch for the current test file. */
export function stubFetchGuard(guard: FetchGuard): void {
  vi.stubGlobal('fetch', guard.fetchImpl);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Fetch router for the Instagram OAuth journey (e2e-ig-connect): serves
 * the four Meta endpoints the REAL oauth/api code calls, with synthetic
 * tokens. Any other Meta URL falls through to the guard's block.
 */
export function createOAuthFetchRouter(options: { failTokenExchange?: boolean } = {}): {
  router: (url: string) => Response | null;
  calls: string[];
} {
  const calls: string[] = [];
  const router = (url: string): Response | null => {
    calls.push(url);
    if (url.startsWith('https://api.instagram.com/oauth/access_token')) {
      if (options.failTokenExchange) {
        return jsonResponse({ error_type: 'OAuthException', error_message: 'synthetic failure' }, 400);
      }
      return jsonResponse({ access_token: 'synthetic-short-lived-token', user_id: 'IG-E2E-NEW' });
    }
    if (url.startsWith('https://graph.instagram.com/access_token')) {
      return jsonResponse({
        access_token: 'synthetic-long-lived-token',
        token_type: 'bearer',
        expires_in: 5184000,
      });
    }
    if (url.startsWith('https://graph.instagram.com/me')) {
      return jsonResponse({
        user_id: 'IG-E2E-NEW',
        username: 'e2e_new_creator',
        name: 'E2E New Creator',
        profile_picture_url: null,
      });
    }
    if (url.includes('/subscribed_apps')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return null; // unrecognised Meta URL → guard throws
  };
  return { router, calls };
}

/**
 * Collapse the 2–5s human-like send jitter (and the 1.2–2.5s inter-message
 * jitter) to 0ms, exactly as the parity suites do — timing only; send
 * assertions are unaffected. Returns a restore function for afterEach.
 */
export function collapseJitter(): () => void {
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout);
  return () => spy.mockRestore();
}
