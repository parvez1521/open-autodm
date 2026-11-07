/**
 * Lightweight structured logger.
 *
 * JSON-line output that both Vercel and Cloudflare log viewers parse natively.
 * Never log tokens, secrets, or full webhook bodies.
 *
 * Redaction is two-layered (Phase 10.4 §9, S-11 defence-in-depth):
 *  1. KEY-name redaction — any field whose key looks sensitive is replaced
 *     wholesale, at any nesting depth.
 *  2. VALUE-pattern scrubbing — free-text strings (the log message itself,
 *     ctx string values, nested metadata, serialised Error messages) are
 *     scanned for secret-SHAPED values and those values are replaced with
 *     [redacted]: JWTs, `Bearer <token>`, `access_token=` / `secret=` style
 *     assignments, and long hex strings (≥ 32 chars — the shape of the
 *     encryption key, HMACs and Meta tokens). Dashed UUIDs, short hex refs,
 *     numbers and ordinary prose are deliberately NOT matched, so owner IDs
 *     and operational counters survive.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (ctx: Record<string, unknown>, msg: string) => void;
  info: (ctx: Record<string, unknown>, msg: string) => void;
  warn: (ctx: Record<string, unknown>, msg: string) => void;
  error: (ctx: Record<string, unknown>, msg: string) => void;
}

const REDACTED = '[redacted]';
const SENSITIVE_KEY = /token|secret|password|authorization/i;

/**
 * Scrub secret-shaped VALUES out of a single string. Pattern order matters:
 * structured carriers (JWT, Bearer, query assignments) run before the bare
 * long-hex sweep so their replacements stay readable.
 */
export function scrubSecretShapedValues(input: string): string {
  if (!input) return input;
  return input
    // JWTs: header segment always base64url-decodes to {"alg":…} → starts eyJ.
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    // Authorization carriers: keep the scheme word, drop the credential.
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`)
    // Query/form/JSON-ish assignments: access_token=…, "access_token": "…",
    // secret=…, refresh_token=… — keep the key, drop the value.
    .replace(
      /((?:access_token|refresh_token|api_key|secret)\s*["']?\s*[=:]\s*["']?)[^\s&"',;}\]]+/gi,
      `$1${REDACTED}`
    )
    // Bare long hex (encryption keys, HMAC hex, hex tokens): ≥ 32 chars.
    // Dashed UUIDs never match (the dashes break the run), by design.
    .replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTED);
}

/**
 * Recursively scrub a log value: strings are value-scrubbed, sensitive KEYS
 * are wholesale-redacted at any depth, Errors serialise with a scrubbed
 * message. Primitives pass through untouched. Depth-capped so a pathological
 * structure degrades to today's behaviour instead of recursing forever.
 */
export function scrubLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecretShapedValues(value);
  if (value instanceof Error) {
    return { name: value.name, message: scrubSecretShapedValues(value.message) };
  }
  if (depth >= 6) return value;
  if (Array.isArray(value)) return value.map((v) => scrubLogValue(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value; // Date, etc. — stringify as-is
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubLogValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, scope: string, ctx: Record<string, unknown>, msg: string): void {
  const line = JSON.stringify({
    level,
    scope,
    msg: scrubSecretShapedValues(msg),
    time: new Date().toISOString(),
    ...sanitize(ctx),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Redact anything that looks like a secret and serialize Error objects. */
function sanitize(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = scrubLogValue(value);
    }
  }
  return out;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (ctx, msg) => emit('debug', scope, ctx, msg),
    info: (ctx, msg) => emit('info', scope, ctx, msg),
    warn: (ctx, msg) => emit('warn', scope, ctx, msg),
    error: (ctx, msg) => emit('error', scope, ctx, msg),
  };
}
