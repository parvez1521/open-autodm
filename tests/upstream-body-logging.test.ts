/**
 * Phase 10.5 — NEW-2: upstream response bodies must NOT persist via logs.
 *
 * Two call sites logged the raw upstream (Meta) response body:
 *   1. src/lib/instagram/api.ts — subscribeToWebhookFields() logged
 *      `{ igUserId, status, body }` on subscription failure.
 *   2. src/app/api/instagram/posts/[accountId]/route.ts — the media fetch
 *      failure path logged `{ accountId, status, body: body.slice(0, 300) }`.
 *
 * The S-11 logger scrubber only redacts secret-SHAPED values; an arbitrary
 * upstream payload (a message body, a caption, any plain-text content) is
 * not secret-shaped and passed through verbatim. These tests therefore use
 * plain-text synthetic markers that the scrubber deliberately does NOT
 * match: pre-fix they appear in the emitted log line (test FAILS);
 * post-fix the log lines carry only sanitized metadata (HTTP status,
 * body length, parsed Meta error code) and the markers never appear.
 *
 * Synthetic values only — no real tokens, no real message content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Synthetic markers (plain text on purpose — NOT secret-shaped) ──────────
const FAKE_TOKEN_MARKER = 'synthetic-fake-access-token-payload';
const FAKE_MESSAGE_MARKER = 'synthetic-fake-message-body-content';
const UPSTREAM_BODY =
  `{"error":{"message":"${FAKE_MESSAGE_MARKER}","code":190,"type":"OAuthException"},` +
  `"echo":"access_token=${FAKE_TOKEN_MARKER} plus trailing upstream prose"}`;

// ── Mocks for the posts route (auth / db / crypto / env) ───────────────────
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(async () => ({ id: 'owner-user-1', email: 'owner@example.com' })),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'acct-1',
                  instagram_user_id: 'ig-user-1',
                  access_token_encrypted: 'synthetic-ciphertext',
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/crypto', () => ({ decrypt: () => 'synthetic-decrypted-token' }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'synthetic-key' }) }));

import { subscribeToWebhookFields } from '@/lib/instagram/api';
import { GET as postsGET } from '@/app/api/instagram/posts/[accountId]/route';

describe('NEW-2 — upstream bodies never persist through logs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function allEmitted(): string {
    return [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((c) => String(c[0]))
      .join('\n');
  }

  it('subscribeToWebhookFields: failure log carries status + bodyLength + meta code, never the raw body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => UPSTREAM_BODY }))
    );

    const result = await subscribeToWebhookFields('ig-user-1', 'synthetic-token');
    expect(result.ok).toBe(false);

    const emitted = allEmitted();
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).not.toContain(FAKE_MESSAGE_MARKER);
    expect(emitted).not.toContain(FAKE_TOKEN_MARKER);
    expect(emitted).not.toContain('trailing upstream prose');
    // Sanitized metadata is retained for debuggability.
    expect(emitted).toContain('"status":400');
    expect(emitted).toContain(`"bodyLength":${UPSTREAM_BODY.length}`);
    expect(emitted).toContain('"metaCode":190');
  });

  it('posts route: Meta media failure log carries status + bodyLength, never the raw body; client response stays generic', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, text: async () => UPSTREAM_BODY }))
    );

    const res = await postsGET(new Request('https://app.example/api/instagram/posts/acct-1'), {
      params: Promise.resolve({ accountId: 'acct-1' }),
    });
    expect(res.status).toBe(502);
    const responseText = await res.text();
    expect(responseText).not.toContain(FAKE_MESSAGE_MARKER);
    expect(responseText).not.toContain(FAKE_TOKEN_MARKER);

    const emitted = allEmitted();
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).not.toContain(FAKE_MESSAGE_MARKER);
    expect(emitted).not.toContain(FAKE_TOKEN_MARKER);
    expect(emitted).not.toContain('trailing upstream prose');
    expect(emitted).toContain('"status":502');
    expect(emitted).toContain(`"bodyLength":${UPSTREAM_BODY.length}`);
  });

  it('source scan: neither fixed call site passes an upstream body to a logger', () => {
    const SRC_ROOT = path.resolve(__dirname, '..', 'src');
    const api = fs.readFileSync(path.join(SRC_ROOT, 'lib/instagram/api.ts'), 'utf8');
    const posts = fs.readFileSync(
      path.join(SRC_ROOT, 'app/api/instagram/posts/[accountId]/route.ts'),
      'utf8'
    );
    // The exact pre-fix shapes must not reappear.
    expect(api).not.toContain('status: res.status, body }');
    expect(posts).not.toContain('body: body.slice(0, 300)');
    // And both files log the sanitized length instead.
    expect(api).toContain('bodyLength');
    expect(posts).toContain('bodyLength');
  });
});
