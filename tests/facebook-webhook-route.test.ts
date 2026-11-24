/**
 * Facebook Page automation (2026-11-19) — POST /api/webhook, route level.
 *
 * The HMAC gate is shared with Instagram (either app secret verifies);
 * what this file proves for Facebook is the DISPATCH: a verified Page
 * body (object === 'page') runs through processFacebookWebhook, while
 * an Instagram body still runs through processWebhookPayload. The
 * `after()` callback is captured (not executed by the route in tests)
 * and invoked explicitly, so the dispatch itself is exercised.
 * Signature behaviour is the REAL route code + REAL crypto primitives.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';
import { hmacSha256Hex } from '@/lib/crypto';

const fake = new FakeSupabase();

const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<unknown>>);
const mockProcessFacebookWebhook = vi.hoisted(() => vi.fn(async () => 3));
const mockProcessWebhookPayload = vi.hoisted(() => vi.fn(async () => 0));

vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn() }));
vi.mock('@/lib/automation/processWebhook', () => ({
  processWebhookPayload: mockProcessWebhookPayload,
}));
vi.mock('@/lib/facebook/processFacebookWebhook', () => ({
  processFacebookWebhook: mockProcessFacebookWebhook,
}));
vi.mock('@/lib/automation/engine', () => ({
  processDueJobs: vi.fn(async () => ({ claimed: 0, done: 0, rescheduled: 0, failed: 0 })),
}));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('next/server', () => ({
  after: (cb: () => Promise<unknown>) => {
    afterCallbacks.push(cb);
  },
}));

import { POST } from '@/app/api/webhook/route';
import { getMetaSettings } from '@/lib/settings';

const mockGetMetaSettings = vi.mocked(getMetaSettings);

const IG_SECRET = 'instagram-app-secret';
const FB_SECRET = 'facebook-app-secret';

const PAGE_BODY = JSON.stringify({
  object: 'page',
  entry: [
    {
      id: 'PAGE-1',
      time: 1762000000,
      changes: [
        {
          field: 'feed',
          value: {
            item: 'comment',
            verb: 'add',
            comment_id: 'STORY-1_CMT-1',
            post_id: 'PAGE-1_STORY-1',
            parent_id: 'PAGE-1_STORY-1',
            message: 'GUIDE please',
            from: { id: 'USER-1', name: 'Fan' },
            created_time: 1762000000,
          },
        },
      ],
    },
  ],
});

const IG_BODY = JSON.stringify({
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

async function runAfterCallbacks(): Promise<void> {
  const cbs = afterCallbacks.splice(0, afterCallbacks.length);
  for (const cb of cbs) await cb();
}

beforeEach(() => {
  mockGetMetaSettings.mockReset();
  mockGetMetaSettings.mockResolvedValue({
    metaAppId: '123',
    instagramAppId: '1121249884134177',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'token',
    setupCompleted: true,
  });
  mockProcessFacebookWebhook.mockClear();
  mockProcessWebhookPayload.mockClear();
  afterCallbacks.length = 0;
  fake.replaceRows('inbound_webhook_events', []);
  fake.replaceRows('instagram_accounts', []);
});

describe('POST /api/webhook — Facebook Page dispatch', () => {
  it('accepts a Page body signed with either secret (200) and routes it to processFacebookWebhook', async () => {
    const res = await POST(webhookRequest(PAGE_BODY, sign(IG_SECRET, PAGE_BODY)));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(mockProcessFacebookWebhook).toHaveBeenCalledTimes(1);
    expect(mockProcessFacebookWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ object: 'page' }),
    );
    expect(mockProcessWebhookPayload).not.toHaveBeenCalled();
  });

  it('accepts a Page body signed with the Facebook app secret (200)', async () => {
    const res = await POST(webhookRequest(PAGE_BODY, sign(FB_SECRET, PAGE_BODY)));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(mockProcessFacebookWebhook).toHaveBeenCalledTimes(1);
  });

  it('still routes Instagram bodies to processWebhookPayload (no regression)', async () => {
    const res = await POST(webhookRequest(IG_BODY, sign(IG_SECRET, IG_BODY)));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(mockProcessWebhookPayload).toHaveBeenCalledTimes(1);
    expect(mockProcessFacebookWebhook).not.toHaveBeenCalled();
  });

  it('rejects a tampered Page body (403) and dispatches nothing', async () => {
    const res = await POST(webhookRequest(`${PAGE_BODY} `, sign(IG_SECRET, PAGE_BODY)));
    expect(res.status).toBe(403);
    await runAfterCallbacks();
    expect(mockProcessFacebookWebhook).not.toHaveBeenCalled();
    expect(mockProcessWebhookPayload).not.toHaveBeenCalled();
  });

  it('rejects a Page body signed with an unknown secret (403)', async () => {
    const res = await POST(webhookRequest(PAGE_BODY, sign('attacker-secret', PAGE_BODY)));
    expect(res.status).toBe(403);
    await runAfterCallbacks();
    expect(mockProcessFacebookWebhook).not.toHaveBeenCalled();
  });

  it('rejects a Page body with no signature header (403)', async () => {
    const res = await POST(webhookRequest(PAGE_BODY, null));
    expect(res.status).toBe(403);
    await runAfterCallbacks();
    expect(mockProcessFacebookWebhook).not.toHaveBeenCalled();
  });
});
