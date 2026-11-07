/**
 * Phase 10.4 Workstream E — §9 logging privacy (S-11 defence-in-depth).
 *
 * Written FIRST, before the fix: on the pre-fix code the secret-shaped
 * values below pass through logger/debugLog untouched (sanitize() only
 * redacted by KEY name; debugLog inserted free text unscrubbed), so the
 * scrubbing assertions FAIL. After the fix in src/lib/logger.ts +
 * src/lib/debugLog.ts they pass.
 *
 * Surfaces under test are the PUBLIC ones only (createLogger, debugLog),
 * so the pre-fix failure is a clean assertion failure, not an import error.
 *
 * Mocking note (checked before writing): every other suite that touches
 * debugLog replaces it wholesale with `vi.mock('@/lib/debugLog', …)`
 * (webhook-route, parity-*, e2e/*, ai-generate-route, …), and
 * tests/debug-events-route.test.ts exercises the debug-events READ route
 * against FakeSupabase — neither depends on debugLog's internals, so
 * scrubbing inside debugLog/logger cannot break them. This file is the
 * only one that imports the REAL debugLog, with the service client mocked
 * to capture the inserted row.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Synthetic secret-shaped fixtures (NOT real credentials) ────────────────
const HEX64 = '0123456789abcdef'.repeat(4); // 64-char hex — TOKEN_ENCRYPTION_KEY shape
const HEX32 = 'deadbeef'.repeat(4); // 32-char hex — minimum long-hex shape
const BEARER_TOKEN = 'xY9_abc-DEF1234567890tokenvalue'; // non-hex, only the Bearer rule catches it
const ACCESS_TOKEN_VALUE = 'tok_ABC-123-xyz-secret-value'; // non-hex, only access_token= catches it
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const OWNER_UUID = '550e8400-e29b-41d4-a716-446655440000'; // dashed UUID — must SURVIVE scrubbing

const ALL_SECRETS = [HEX64, HEX32, BEARER_TOKEN, ACCESS_TOKEN_VALUE, JWT];

// ── debugLog capture: mock ONLY the service client ─────────────────────────
const { insertedRows } = vi.hoisted(() => ({ insertedRows: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';

async function flushDebugLog(): Promise<void> {
  // debugLog is fire-and-forget async; let its insert settle.
  await new Promise((r) => setTimeout(r, 25));
}

describe('logger value-pattern scrubbing (S-11)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function emittedLine(spy: ReturnType<typeof vi.spyOn>): string {
    expect(spy).toHaveBeenCalled();
    return String(spy.mock.calls[0]![0]);
  }

  it('scrubs a long-hex token in a ctx string value (key name is innocuous)', () => {
    const logger = createLogger('test');
    logger.info({ note: `upstream echoed key ${HEX64} back` }, 'plain message');
    const line = emittedLine(logSpy);
    expect(line).not.toContain(HEX64);
    expect(line).toContain('[redacted]');
    expect(line).toContain('plain message');
  });

  it('scrubs secret-shaped values in the free-text msg argument itself', () => {
    const logger = createLogger('test');
    logger.info({}, `request failed with Bearer ${BEARER_TOKEN} attached`);
    const line = emittedLine(logSpy);
    expect(line).not.toContain(BEARER_TOKEN);
    expect(line).toContain('[redacted]');
  });

  it('scrubs access_token= values and JWTs nested in objects and arrays', () => {
    const logger = createLogger('test');
    logger.warn(
      {
        detail: {
          url: `https://graph.example/me?access_token=${ACCESS_TOKEN_VALUE}&fields=id`,
          chain: [`session ${JWT}`, 'ordinary text'],
        },
      },
      'nested check'
    );
    const line = emittedLine(warnSpy);
    expect(line).not.toContain(ACCESS_TOKEN_VALUE);
    expect(line).not.toContain(JWT);
    expect(line).toContain('[redacted]');
    expect(line).toContain('ordinary text');
  });

  it('scrubs the message of a serialised Error object', () => {
    const logger = createLogger('test');
    logger.error({ err: new Error(`Meta said token ${HEX32} is invalid`) }, 'send failed');
    const line = emittedLine(errorSpy);
    expect(line).not.toContain(HEX32);
    expect(line).toContain('[redacted]');
    expect(line).toContain('send failed');
  });

  it('key-name redaction still applies (short secret under a sensitive key)', () => {
    const logger = createLogger('test');
    logger.info({ accessToken: 'short-value', note: 'kept' }, 'keys');
    const line = emittedLine(logSpy);
    expect(line).not.toContain('short-value');
    expect(line).toContain('kept');
  });

  it('does NOT scrub non-secret values: UUIDs, short hex, numbers, plain text survive', () => {
    const logger = createLogger('test');
    logger.info(
      { userId: OWNER_UUID, shortRef: 'abc123', count: 42, note: 'Rate limit OK - 17/180 this hour' },
      'ordinary operational log'
    );
    const line = emittedLine(logSpy);
    expect(line).toContain(OWNER_UUID);
    expect(line).toContain('abc123');
    expect(line).toContain('17/180');
    expect(line).not.toContain('[redacted]');
  });
});

describe('debugLog value-pattern scrubbing (S-11)', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrubs a token-shaped string from the free-text message before insert', async () => {
    debugLog('webhook', 'error', 'signature_check', 'error',
      `HMAC check used secret ${HEX64} while verifying`, {});
    await flushDebugLog();
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(String(row['message'])).not.toContain(HEX64);
    expect(String(row['message'])).toContain('[redacted]');
  });

  it('scrubs metadata string values (incl. nested) before insert', async () => {
    debugLog('instagram', 'error', 'dm_send_failed', 'error', 'DM failed', {
      detail: `Bearer ${BEARER_TOKEN}`,
      nested: { link: `https://x.test/cb?access_token=${ACCESS_TOKEN_VALUE}` },
      list: [JWT],
    });
    await flushDebugLog();
    expect(insertedRows).toHaveLength(1);
    const stored = JSON.stringify(insertedRows[0]);
    for (const secret of ALL_SECRETS) expect(stored).not.toContain(secret);
    expect(stored).toContain('[redacted]');
  });

  it('userId extraction still works and the owner UUID survives scrubbing', async () => {
    debugLog('worker', 'info', 'dm_sent', 'ok', 'DM sent', { userId: OWNER_UUID, jobId: 'job-1' });
    await flushDebugLog();
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row['user_id']).toBe(OWNER_UUID);
    expect(JSON.stringify(row['metadata'])).toContain(OWNER_UUID);
  });

  it('§12 malicious payload: a payload carrying every secret shape stores NONE of them', async () => {
    // Simulates the worst realistic debugLog call: an upstream error body /
    // webhook-adjacent payload echoed into message + metadata, alongside
    // ordinary content markers. The scrubber's contract is narrow and
    // honest: SECRET-SHAPED values must not persist; non-secret operational
    // text is not the scrubber's job (content minimisation is S-05/S-06).
    const maliciousMessage =
      `processing failed for content-marker-hello with Bearer ${BEARER_TOKEN} ` +
      `and access_token=${ACCESS_TOKEN_VALUE} and jwt ${JWT} and hex ${HEX64}`;
    debugLog('webhook', 'error', 'payload_processing', 'error', maliciousMessage, {
      error: `upstream body echoed key ${HEX32}`,
      contentMarker: 'content-marker-hello',
      nested: { deep: [`tok ${HEX64}`, `auth Bearer ${BEARER_TOKEN}`] },
    });
    await flushDebugLog();
    expect(insertedRows).toHaveLength(1);
    const stored = JSON.stringify(insertedRows[0]);
    for (const secret of ALL_SECRETS) {
      expect(stored, `stored debug row must not contain a secret-shaped value`).not.toContain(secret);
    }
    // The event itself is still recorded (scrubbing ≠ dropping the event).
    expect(insertedRows[0]!['event_type']).toBe('payload_processing');
    expect(stored).toContain('[redacted]');
  });
});

describe('S-05 regression re-verified (Phase 10.4 §9)', () => {
  const SRC_ROOT = path.resolve(__dirname, '..', 'src');

  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        collectSourceFiles(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it('no *Preview field exists anywhere in src/ and instagram/api.ts keeps length-only fields', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('messagePreview') || src.includes('replyPreview')) {
        offenders.push(path.relative(SRC_ROOT, file).replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
    const api = fs.readFileSync(path.join(SRC_ROOT, 'lib/instagram/api.ts'), 'utf8');
    expect(api).toContain('messageLength: messageText.length');
    expect(api).toContain('replyLength: replyText.length');
  });
});
