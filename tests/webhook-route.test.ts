/**
 * Area 7 (route level) — POST /api/webhook signature gate.
 * Settings + downstream processing are mocked; the HMAC verification under
 * test is the REAL route code composing the REAL crypto primitives.
 * Valid signature → 200; anything else → 403 before any processing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hmacSha256Hex } from '@/lib/crypto';

const IG_SECRET = 'webhook-ig-secret';
const FB_SECRET = 'webhook-fb-secret';

vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn() }));
vi.mock('@/lib/automation/processWebhook', () => ({
  processWebhookPayload: vi.fn(async () => 0),
}));
vi.mock('@/lib/automation/engine', () => ({
  processDueJobs: vi.fn(async () => ({ claimed: 0, done: 0, rescheduled: 0, failed: 0 })),
}));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));

import { POST } from '@/app/api/webhook/route';
import { getMetaSettings } from '@/lib/settings';

const mockGetMetaSettings = vi.mocked(getMetaSettings);

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

beforeEach(() => {
  mockGetMetaSettings.mockReset();
  mockGetMetaSettings.mockResolvedValue({
    metaAppId: '123',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'token',
    setupCompleted: true,
  });
});

describe('POST /api/webhook signature verification', () => {
  it('accepts a body signed with the Instagram app secret (200)', async () => {
    const res = await POST(webhookRequest(RAW_BODY, sign(IG_SECRET, RAW_BODY)));
    expect(res.status).toBe(200);
  });

  it('accepts a body signed with the Facebook app secret (fallback, 200)', async () => {
    const res = await POST(webhookRequest(RAW_BODY, sign(FB_SECRET, RAW_BODY)));
    expect(res.status).toBe(200);
  });

  it('rejects a tampered body (signature no longer matches, 403)', async () => {
    const res = await POST(webhookRequest(`${RAW_BODY} `, sign(IG_SECRET, RAW_BODY)));
    expect(res.status).toBe(403);
  });

  it('rejects a signature made with an unknown secret (403)', async () => {
    const res = await POST(webhookRequest(RAW_BODY, sign('attacker-secret', RAW_BODY)));
    expect(res.status).toBe(403);
  });

  it('rejects a missing signature header (403)', async () => {
    const res = await POST(webhookRequest(RAW_BODY, null));
    expect(res.status).toBe(403);
  });

  it('rejects when the app is not configured (no secrets to verify against, 403)', async () => {
    mockGetMetaSettings.mockResolvedValue(null);
    const res = await POST(webhookRequest(RAW_BODY, sign(IG_SECRET, RAW_BODY)));
    expect(res.status).toBe(403);
  });
});
