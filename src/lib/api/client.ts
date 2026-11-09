/**
 * Typed API client for the app's own /api routes (same origin).
 * Attaches the current Supabase JWT as a Bearer token.
 *
 * Flakiness fix (2026-11-08, investigation:
 * automations-flakiness-investigation.md §3 H1/H5, fix-plan items
 * 2 + 4):
 *  - TIMEOUT: every call runs under an AbortController with a
 *    bounded timeout (default {@link API_REQUEST_TIMEOUT_MS}). A
 *    wedged getSession or fetch now SETTLES as a typed
 *    ApiTimeoutError — which React Query treats like any other
 *    failure (retry + the pages' error panels) — instead of leaving
 *    a query in its loading skeleton forever. A caller-supplied
 *    AbortSignal still wins independently: aborting it aborts the
 *    call without being misreported as a timeout.
 *  - SHARED SESSION: concurrent calls share ONE in-flight
 *    getSession() promise instead of each acquiring the supabase-js
 *    Web Lock and racing token refresh. The memo clears the moment
 *    the promise settles, so the next call after settlement reads a
 *    fresh session — this is a single-flight, never a cache.
 */

import { createBrowserClient } from '@/lib/supabase/clients';
import type { Session } from '@supabase/supabase-js';

const API_URL = '/api';

/** Default per-call timeout for apiClient (fetch + session legs). */
export const API_REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    // `code` added 2026-11-09 (persona-QA fix 1): several routes
    // answer failures with a machine-readable code next to the
    // human message (e.g. PLAN_LIMIT_REACHED from the entitlement
    // guard); callers need it to tell a plan-limit refusal apart
    // from a genuine permission failure instead of guessing from
    // the HTTP status alone.
    public readonly body: { error?: string; message?: string; code?: string; details?: unknown }
  ) {
    super(body.message ?? body.error ?? `API error ${status}`);
    this.name = 'ApiError';
  }
}

/**
 * The call exceeded its timeout (session acquisition or fetch).
 * Deliberately NOT an ApiError: no response was received, so for
 * mutation callers this is an AMBIGUOUS outcome (the server may
 * have committed) — the same class as a transport failure in the
 * save-outcome rules (see hooks/useAutomations.ts).
 */
export class ApiTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'ApiTimeoutError';
  }
}

let inFlightSession: Promise<Session | null> | null = null;

/**
 * The one in-flight getSession() shared by every concurrent
 * apiClient call. Clears on settle (success or failure), so a
 * later call always re-reads the session.
 */
export function getSharedSession(): Promise<Session | null> {
  if (!inFlightSession) {
    const promise = (async (): Promise<Session | null> => {
      const supabase = createBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return session;
    })();
    inFlightSession = promise;
    const clear = () => {
      if (inFlightSession === promise) inFlightSession = null;
    };
    // Both branches handled: the derived promise never rejects.
    promise.then(clear, clear);
  }
  return inFlightSession;
}

/**
 * Race a promise against an AbortSignal. Rejects with the signal's
 * reason (a DOMException AbortError) so callers can distinguish
 * their own abort from a timeout at the catch site.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface ApiClientOptions extends RequestInit {
  skipAuth?: boolean;
  /** Per-call timeout override (ms). Default API_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

export async function apiClient<T>(path: string, options?: ApiClientOptions): Promise<T> {
  // Headers-normalized construction (Programme 28): `new Headers(...)`
  // preserves plain-object, Headers-instance and tuple-array inputs
  // without corruption (the previous Record spread destroyed the
  // latter two). Observable precedence is preserved:
  // - Content-Type: the JSON default applies only when a body exists
  //   and the caller did not supply a Content-Type (caller wins).
  //   Bodyless requests get no JSON Content-Type — some runtimes
  //   would otherwise try to parse an empty body.
  // - Authorization: set after caller headers, so it wins when a
  //   session token exists and auth is not skipped.
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const timeoutMs = options?.timeoutMs ?? API_REQUEST_TIMEOUT_MS;
  const callerSignal = options?.signal ?? null;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    if (!options?.skipAuth) {
      const session = await raceWithAbort(getSharedSession(), controller.signal);
      if (session?.access_token) {
        headers.set('Authorization', `Bearer ${session.access_token}`);
      }
    }

    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, { ...options, headers, signal: controller.signal });
    } catch (err) {
      // fetch rejects with the signal's AbortError on abort; only a
      // timeout-driven abort is reported as ApiTimeoutError — a
      // caller-driven abort keeps its original shape.
      if (timedOut) throw new ApiTimeoutError(timeoutMs);
      throw err;
    }

    if (!res.ok) {
      let body: { error?: string; message?: string } = {};
      try {
        body = (await res.json()) as { error?: string; message?: string };
      } catch {
        // ignore parse errors
      }
      throw new ApiError(res.status, body);
    }

    // Awaited (not returned bare) so the timeout above also covers
    // reading the body — a headers-then-hang response must settle
    // as a timeout, not stream forever.
    return (await res.json()) as T;
  } catch (err) {
    // A timeout during the SESSION leg surfaces from raceWithAbort
    // as an AbortError — translate it here. A timeout during fetch
    // was already translated above.
    if (timedOut && !(err instanceof ApiTimeoutError)) {
      throw new ApiTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}
