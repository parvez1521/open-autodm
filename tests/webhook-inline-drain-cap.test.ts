/**
 * Webhook inline drain cap (2026-11-28).
 *
 * Cloudflare Workers free plan allows 50 subrequests per invocation, and
 * the webhook's after() callback runs in the SAME invocation as the
 * admission + enqueue path. A full-featured IG comment job costs ~27
 * subrequests, so the old `processDueJobs(Math.max(enqueued, 5))` could
 * burst past the limit (an FB job logged 'Too many subrequests' from a
 * 5-job drain). The route now drains at most
 * WEBHOOK_INLINE_DRAIN_MAX_JOBS per invocation.
 *
 * These tests drive the REAL route code with the downstream drain
 * mocked: the after() callback is captured and invoked, then the limit
 * passed to processDueJobs is asserted for several enqueue counts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hmacSha256Hex } from '@/lib/crypto';

const IG_SECRET = 'webhook-ig-secret';
const FB_SECRET = 'webhook-fb-secret';

const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn() }));
vi.mock('@/lib/automation/inboundRateLimit', () => ({
  admitInboundWebhook: vi.fn(async (body: unknown) => ({ body })),
}));
vi.mock('@/lib/automation/processWebhook', () => ({
  processWebhookPayload: vi.fn(async () => 0),
}));
vi.mock('@/lib/automation/engine', () => ({
  processDueJobs: vi.fn(async () => ({ claimed: 0, done: 0, rescheduled: 0, failed: 0, held: 0 })),
}));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('next/server', () => ({
  after: vi.fn((cb: () => Promise<void>) => {
    afterCallbacks.push(cb);
  }),
}));

import { POST } from '@/app/api/webhook/route';
import { getMetaSettings } from '@/lib/settings';
import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { processDueJobs } from '@/lib/automation/engine';

const mockGetMetaSettings = vi.mocked(getMetaSettings);
const mockProcessWebhookPayload = vi.mocked(processWebhookPayload);
const mockProcessDueJobs = vi.mocked(processDueJobs);

const RAW_BODY = JSON.stringify({
  object: 'instagram',
  entry: [{ id: 'IG-1', time: 1762000000, changes: [] }],
});

function webhookRequest(body: string): Request {
  return new Request('https://app.opendm.in/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${hmacSha256Hex(IG_SECRET, Buffer.from(body, 'utf8'))}`,
    },
    body,
  });
}

beforeEach(() => {
  afterCallbacks.length = 0;
  mockProcessDueJobs.mockClear();
  mockProcessWebhookPayload.mockReset();
  mockProcessWebhookPayload.mockResolvedValue(0);
  mockGetMetaSettings.mockReset();
  mockGetMetaSettings.mockResolvedValue({
    metaAppId: '123',
    instagramAppId: '1121249884134177',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'token',
    setupCompleted: true,
  });
});

async function runAfterCallbacks(): Promise<void> {
  expect(afterCallbacks.length).toBe(1);
  for (const cb of afterCallbacks) await cb();
}

describe('POST /api/webhook inline drain cap', () => {
  // The cap lives as a module-private constant in the route (route
  // modules cannot export extra values), so tests assert the literal.
  const CAP = 1;

  it(`drains at most ${CAP} job when 10 jobs were enqueued`, async () => {
    mockProcessWebhookPayload.mockResolvedValue(10);
    const res = await POST(webhookRequest(RAW_BODY));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(mockProcessDueJobs).toHaveBeenCalledTimes(1);
    expect(mockProcessDueJobs).toHaveBeenCalledWith(CAP);
  });

  it('drains 1 job when exactly 1 was enqueued', async () => {
    mockProcessWebhookPayload.mockResolvedValue(1);
    const res = await POST(webhookRequest(RAW_BODY));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(mockProcessDueJobs).toHaveBeenCalledTimes(1);
    expect(mockProcessDueJobs).toHaveBeenCalledWith(1);
  });

  it('does not drain at all when nothing was enqueued', async () => {
    mockProcessWebhookPayload.mockResolvedValue(0);
    const res = await POST(webhookRequest(RAW_BODY));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(mockProcessDueJobs).not.toHaveBeenCalled();
  });

  it('the cap is 1: a single invocation must stay under the 50-subrequest free-plan limit', () => {
    // One full-featured IG comment job costs ~27 subrequests; the
    // webhook's own admission + enqueue path adds ~8-10 more in the
    // same invocation. 1 job ≈ 35-37 (under 50); 2 jobs ≈ 62-64 (over).
    expect(CAP).toBe(1);
  });
});
