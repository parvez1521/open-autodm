/**
 * Phase 10.3 E2E (Area 3) — webhook ingestion, HTTP edge to job queue.
 *
 * tests/webhook-route.test.ts proves the signature gate in isolation
 * (downstream mocked away). This file EXTENDS it into the full journey:
 * the REAL route composes the REAL HMAC check, then the captured
 * `after()` background work runs the REAL processWebhookPayload against
 * the FakeSupabase world, and the assertion lands on the job_queue —
 * i.e. "a correctly signed Meta delivery becomes exactly one queued
 * job; anything else becomes nothing, safely."
 *
 * Malformed-payload contract (from the route source): a SIGNED but
 * unparseable body is acknowledged 200 {status:'ignored'} so Meta does
 * not retry forever; a signed non-Instagram object is accepted at the
 * edge and ignored downstream. Both must create zero jobs and never throw.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import { hmacSha256Hex } from '@/lib/crypto';
import { accountRow, automationRow, commentWebhookBody, E2E } from './fixtures/payloads';

const fake = new FakeSupabase();
const IG_SECRET = 'e2e-webhook-ig-secret';
const FB_SECRET = 'e2e-webhook-fb-secret';

const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock('@/lib/settings', () => ({ getMetaSettings: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

import { GET, POST } from '@/app/api/webhook/route';
import { getMetaSettings } from '@/lib/settings';

const mockGetMetaSettings = vi.mocked(getMetaSettings);

function sign(secret: string, body: string): string {
  return `sha256=${hmacSha256Hex(secret, Buffer.from(body, 'utf8'))}`;
}

function webhookRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return new Request('https://app.opendm.in/api/webhook', { method: 'POST', headers, body });
}

async function drainAfter(): Promise<void> {
  const pending = afterCallbacks.splice(0, afterCallbacks.length);
  for (const fn of pending) await fn();
}

beforeEach(() => {
  afterCallbacks.length = 0;
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [accountRow()]);
  fake.replaceRows('automations', [automationRow()]);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('recipient_opt_outs', []);
  mockGetMetaSettings.mockReset();
  mockGetMetaSettings.mockResolvedValue({
    metaAppId: '123',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'e2e-verify-token',
    setupCompleted: true,
  });
});

describe('GET /api/webhook — subscription verification', () => {
  it('echoes the challenge for the correct verify token', async () => {
    const res = await GET(
      new Request(
        'https://app.opendm.in/api/webhook?hub.mode=subscribe&hub.challenge=challenge-42&hub.verify_token=e2e-verify-token'
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-42');
  });

  it('rejects a wrong verify token with 403', async () => {
    const res = await GET(
      new Request(
        'https://app.opendm.in/api/webhook?hub.mode=subscribe&hub.challenge=challenge-42&hub.verify_token=wrong'
      )
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/webhook — signed delivery becomes a queued job; everything else becomes nothing', () => {
  it('valid IG-secret signature → 200, background processing enqueues exactly one job', async () => {
    const body = JSON.stringify(commentWebhookBody('LINK'));
    const res = await POST(webhookRequest(body, sign(IG_SECRET, body)));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(1);
    expect(fake.rows('job_queue')[0]!['dedupe_key']).toBe(`event_${E2E.automationId}_${E2E.commentId}`);
  });

  it('valid FB-secret signature (fallback secret) → 200 and the same single job', async () => {
    const body = JSON.stringify(commentWebhookBody('LINK'));
    const res = await POST(webhookRequest(body, sign(FB_SECRET, body)));
    expect(res.status).toBe(200);
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(1);
  });

  it('invalid signature → 403, NO background work is even scheduled, zero jobs', async () => {
    const body = JSON.stringify(commentWebhookBody('LINK'));
    const res = await POST(webhookRequest(body, sign('attacker-secret', body)));
    expect(res.status).toBe(403);
    expect(afterCallbacks).toHaveLength(0);
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('tampered body (signature computed over different bytes) → 403, zero jobs', async () => {
    const body = JSON.stringify(commentWebhookBody('LINK'));
    const res = await POST(webhookRequest(`${body} `, sign(IG_SECRET, body)));
    expect(res.status).toBe(403);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('missing signature header → 403, zero jobs', async () => {
    const body = JSON.stringify(commentWebhookBody('LINK'));
    const res = await POST(webhookRequest(body, null));
    expect(res.status).toBe(403);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('app not configured (no secrets to verify against) → 403 even for a well-formed signature', async () => {
    mockGetMetaSettings.mockResolvedValue(null);
    const body = JSON.stringify(commentWebhookBody('LINK'));
    const res = await POST(webhookRequest(body, sign(IG_SECRET, body)));
    expect(res.status).toBe(403);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('SIGNED but malformed JSON → acknowledged 200 {status:ignored}, zero jobs, no throw', async () => {
    const body = '{"object":"instagram","entry":[{broken';
    const res = await POST(webhookRequest(body, sign(IG_SECRET, body)));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ignored');
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('SIGNED valid JSON for a non-Instagram object → 200 at the edge, ignored downstream, zero jobs', async () => {
    const body = JSON.stringify({ object: 'facebook', entry: [{ id: 'x', time: 1, changes: [] }] });
    const res = await POST(webhookRequest(body, sign(IG_SECRET, body)));
    expect(res.status).toBe(200);
    await drainAfter();
    expect(fake.rows('job_queue')).toHaveLength(0);
  });
});
