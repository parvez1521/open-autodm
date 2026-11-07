/**
 * Phase 10.4 Workstream C (S-07 + S-15) — route-level wiring for
 * POST /api/webhook admission and the GET verification challenge.
 *
 * Settings, downstream processing and the limiter module are mocked; the
 * HMAC verification and verify-token comparison under test are the REAL
 * route code composing the REAL crypto primitives.
 *
 * Pins:
 *  - invalid signature → 403 BEFORE the limiter is consulted (an
 *    unauthenticated flood pays no limiter/store cost);
 *  - valid signature → 200 immediately; admission runs inside after()
 *    and only its filtered body reaches processWebhookPayload;
 *  - admission returning null (all duplicate/shed) → no processing call;
 *  - GET challenge uses the constant-time comparison (S-15): correct
 *    token echoes the challenge, wrong/missing token → 403.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hmacSha256Hex } from '@/lib/crypto';

const IG_SECRET = 'webhook-ig-secret';
const VERIFY_TOKEN = 'verify-token-123';

vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn() }));
vi.mock('@/lib/automation/processWebhook', () => ({
  processWebhookPayload: vi.fn(async () => 0),
}));
vi.mock('@/lib/automation/inboundRateLimit', () => ({
  admitInboundWebhook: vi.fn(),
}));
vi.mock('@/lib/automation/engine', () => ({
  processDueJobs: vi.fn(async () => ({ claimed: 0, done: 0, rescheduled: 0, failed: 0, held: 0 })),
}));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));

import { GET, POST } from '@/app/api/webhook/route';
import { getMetaSettings } from '@/lib/settings';
import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { admitInboundWebhook } from '@/lib/automation/inboundRateLimit';
import { after } from 'next/server';

const mockGetMetaSettings = vi.mocked(getMetaSettings);
const mockProcess = vi.mocked(processWebhookPayload);
const mockAdmit = vi.mocked(admitInboundWebhook);
const mockAfter = vi.mocked(after);

const RAW_BODY = JSON.stringify({
  object: 'instagram',
  entry: [{ id: 'IG-1', time: 1762000000, changes: [] }],
});

function webhookRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return new Request('https://app.opendm.in/api/webhook', { method: 'POST', headers, body });
}

function sign(secret: string, body: string): string {
  return `sha256=${hmacSha256Hex(secret, Buffer.from(body, 'utf8'))}`;
}

/** Runs the callback the route registered with next/server's after(). */
async function runAfterCallback(): Promise<void> {
  const calls = mockAfter.mock.calls as unknown as Array<[() => Promise<void>]>;
  expect(calls.length).toBeGreaterThan(0);
  await calls[calls.length - 1]![0]();
}

beforeEach(() => {
  mockGetMetaSettings.mockReset();
  mockGetMetaSettings.mockResolvedValue({
    metaAppId: '123',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: null,
    webhookVerifyToken: VERIFY_TOKEN,
    setupCompleted: true,
  });
  mockProcess.mockClear();
  mockProcess.mockResolvedValue(0);
  mockAdmit.mockReset();
  mockAdmit.mockImplementation(async (body) => ({
    body,
    stats: { admitted: 0, duplicates: 0, shed: 0, passthrough: 0, failOpen: false, shedByAccount: {} },
  }));
  mockAfter.mockClear();
});

describe('POST admission ordering (S-07)', () => {
  it('rejects an invalid signature with 403 BEFORE the limiter is consulted', async () => {
    const res = await POST(webhookRequest(RAW_BODY, sign('attacker-secret', RAW_BODY)));
    expect(res.status).toBe(403);
    expect(mockAdmit).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('rejects a missing signature with 403 BEFORE the limiter is consulted', async () => {
    const res = await POST(webhookRequest(RAW_BODY, null));
    expect(res.status).toBe(403);
    expect(mockAdmit).not.toHaveBeenCalled();
  });

  it('valid signature → 200; admission runs in after() and its body is processed', async () => {
    const filtered = {
      object: 'instagram' as const,
      entry: [{ id: 'IG-1', time: 1762000000, changes: [] }],
    };
    mockAdmit.mockResolvedValue({
      body: filtered,
      stats: { admitted: 1, duplicates: 0, shed: 0, passthrough: 0, failOpen: false, shedByAccount: {} },
    });
    const res = await POST(webhookRequest(RAW_BODY, sign(IG_SECRET, RAW_BODY)));
    expect(res.status).toBe(200);
    // Processing is deferred: nothing has run until after() fires.
    expect(mockAdmit).not.toHaveBeenCalled();
    await runAfterCallback();
    expect(mockAdmit).toHaveBeenCalledTimes(1);
    expect(mockAdmit.mock.calls[0]![0]).toEqual(JSON.parse(RAW_BODY));
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(mockProcess).toHaveBeenCalledWith(filtered);
  });

  it('admission returning null (all duplicate/shed) → 200 and no processing', async () => {
    mockAdmit.mockResolvedValue({
      body: null,
      stats: { admitted: 0, duplicates: 2, shed: 1, passthrough: 0, failOpen: false, shedByAccount: { 'IG-1': 1 } },
    });
    const res = await POST(webhookRequest(RAW_BODY, sign(IG_SECRET, RAW_BODY)));
    expect(res.status).toBe(200);
    await runAfterCallback();
    expect(mockProcess).not.toHaveBeenCalled();
  });
});

describe('GET verification challenge (S-15 constant-time compare)', () => {
  function challengeRequest(token: string | null): Request {
    const params = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.challenge': 'challenge-42' });
    if (token !== null) params.set('hub.verify_token', token);
    return new Request(`https://app.opendm.in/api/webhook?${params.toString()}`);
  }

  it('echoes the challenge for the correct verify token', async () => {
    const res = await GET(challengeRequest(VERIFY_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-42');
  });

  it('rejects a wrong token of the same length (403)', async () => {
    const res = await GET(challengeRequest('verify-token-124'));
    expect(res.status).toBe(403);
  });

  it('rejects a wrong token of a different length (403)', async () => {
    const res = await GET(challengeRequest('nope'));
    expect(res.status).toBe(403);
  });

  it('rejects a missing token parameter (403)', async () => {
    const res = await GET(challengeRequest(null));
    expect(res.status).toBe(403);
  });
});
