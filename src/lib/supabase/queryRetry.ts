/**
 * Bounded retry for transient PostgREST failures — flakiness fix
 * (2026-11-08, investigation: automations-flakiness-investigation.md
 * §3 H2 / fix-plan item 6).
 *
 * Why this exists: the workspace list routes (automations, Instagram
 * accounts, contacts) run trivial scoped selects against a free-tier
 * staging project. Under the page-mount burst (~15–25 Supabase
 * operations in the same second, all through the pooler) an
 * individual leg intermittently returns a connection-class PostgREST
 * error, and before this module that single blip became the route's
 * 500 — twice in a row once React Query's own retry re-ran the whole
 * chain. One bounded server-side retry on the DATA leg absorbs the
 * blip where it happens.
 *
 * Contract (deliberately narrow):
 *   - AT MOST one retry (two attempts total), after a short backoff.
 *   - ONLY transient failures are retried: SQLSTATE connection class
 *     (08xxx), too-many-connections (53300), cannot-connect-now
 *     (57P03), statement timeout (57014), runtime fetch failures
 *     (TypeError — undici's 'fetch failed' class), and plain-object
 *     errors whose message names a connection failure.
 *   - NEVER retried: auth/authorization failures (PGRST301/302,
 *     42501, WorkspaceAccessError codes), validation/integrity
 *     errors (22xxx/23xxx, PGRST1xx/2xx request errors), and
 *     anything else — those are deterministic; a retry would only
 *     double the latency of a correct failure.
 *   - Every retry event is logged (console, JSON line) with the
 *     operation name and per-attempt durations, so a future incident
 *     is diagnosable from function logs alone. A retry that recovers
 *     is logged at info; a retry that still fails at error.
 *
 * This module is transport-only: it creates no clients, reads no
 * tables, and knows nothing about workspaces — callers pass a thunk
 * that builds a FRESH query per attempt (a supabase-js builder must
 * not be awaited twice).
 */

export interface TransientRetryOptions {
  /** Backoff before the single retry, in ms. Default 250. */
  backoffMs?: number;
  /** Injectable sleep (tests). Default: setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable log sink (tests). Default: console, JSON lines. */
  log?: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) => void;
}

export const TRANSIENT_RETRY_BACKOFF_MS = 250;

/** Attempts slower than this are logged even when they succeed. */
const SLOW_ATTEMPT_LOG_MS = 2000;

/** SQLSTATE codes that name a transient availability failure. */
const TRANSIENT_PG_CODES: ReadonlySet<string> = new Set([
  '53300', // too_many_connections
  '57P03', // cannot_connect_now
  '57014', // query_canceled — in practice the statement timeout
]);

/**
 * Message shapes of connection failures when no SQLSTATE survives
 * (plain-object PostgREST/fetch error bodies). Kept narrow on
 * purpose: no auth, validation, or business wording matches.
 */
const TRANSIENT_MESSAGE =
  /fetch failed|failed to fetch|econnreset|econnrefused|econnaborted|etimedout|socket hang up|connection (reset|terminated|refused|closed)|could not connect|network (error|is unreachable)/i;

interface ErrorShape {
  code?: unknown;
  message?: unknown;
  name?: unknown;
}

function shapeOf(error: unknown): ErrorShape {
  if (error !== null && typeof error === 'object') return error as ErrorShape;
  return {};
}

/**
 * Is this failure the transient kind a single retry can plausibly
 * absorb? Pure and total: unknown shapes are NOT transient (fail
 * closed — a deterministic error must surface immediately).
 */
export function isTransientPostgrestError(error: unknown): boolean {
  // undici/fetch transport failures surface as TypeError
  // ('fetch failed', 'terminated', …). On the server data path a
  // TypeError out of a query thunk is a network failure, never a
  // programming result the caller should see unretried.
  if (error instanceof TypeError) return true;

  const shape = shapeOf(error);
  const code = typeof shape.code === 'string' ? shape.code : null;
  if (code) {
    // SQLSTATE connection-exception class: 08000–08007.
    if (code.startsWith('08') && code.length === 5) return true;
    if (TRANSIENT_PG_CODES.has(code)) return true;
    // A coded error that is not in the transient set is a definite,
    // deterministic failure (auth, validation, integrity, request
    // shape) — never retry it, whatever its message says.
    return false;
  }

  const message = typeof shape.message === 'string' ? shape.message : '';
  return TRANSIENT_MESSAGE.test(message);
}

function describeError(error: unknown): { code: string | null; message: string } {
  const shape = shapeOf(error);
  return {
    code: typeof shape.code === 'string' ? shape.code : null,
    message:
      typeof shape.message === 'string'
        ? shape.message
        : error instanceof Error
          ? error.message
          : String(error),
  };
}

function defaultLog(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>): void {
  const line = JSON.stringify({ scope: 'query-retry', ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `run` once; on a TRANSIENT failure only, wait a short backoff
 * and run it exactly once more. The second failure (transient or
 * not) propagates, as does any non-transient first failure —
 * immediately, with no backoff and no second attempt.
 */
export async function withTransientQueryRetry<T>(
  operation: string,
  run: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const backoffMs = options.backoffMs ?? TRANSIENT_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? defaultLog;

  const firstStartedAt = Date.now();
  try {
    const value = await run();
    const durationMs = Date.now() - firstStartedAt;
    if (durationMs >= SLOW_ATTEMPT_LOG_MS) {
      log('info', { operation, attempt: 1, durationMs, outcome: 'ok-slow' });
    }
    return value;
  } catch (err) {
    const firstDurationMs = Date.now() - firstStartedAt;
    if (!isTransientPostgrestError(err)) throw err;
    log('warn', {
      operation,
      attempt: 1,
      durationMs: firstDurationMs,
      outcome: 'transient-error-retrying',
      error: describeError(err),
    });
    await sleep(backoffMs);
    const retryStartedAt = Date.now();
    try {
      const value = await run();
      log('info', {
        operation,
        attempt: 2,
        durationMs: Date.now() - retryStartedAt,
        totalDurationMs: Date.now() - firstStartedAt,
        outcome: 'ok-after-retry',
      });
      return value;
    } catch (retryErr) {
      log('error', {
        operation,
        attempt: 2,
        durationMs: Date.now() - retryStartedAt,
        totalDurationMs: Date.now() - firstStartedAt,
        outcome: 'error-after-retry',
        error: describeError(retryErr),
      });
      throw retryErr;
    }
  }
}
