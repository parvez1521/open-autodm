/**
 * Phase 10.3 §6 — Meta callback LIFECYCLE audit tests.
 *
 * Covers only the gaps left by the existing suites:
 *  - signed-request.test.ts (13 tests): pure parseSignedRequest unit tests.
 *  - meta-callbacks.test.ts (14 tests): happy paths, invalid signature,
 *    missing signed_request (deauthorize), duplicate-callback code reuse,
 *    status known/unknown/missing-code.
 *  - account-data.test.ts: library-level scoping/idempotency/failure marking.
 *
 * New here: route-level malformed bodies for the deletion callback, exact
 * response-shape/content-type pins, scoped deletion with multiple tenants,
 * deauthorize ≠ audience deletion, the failure → failed-record → retry with
 * a NEW code lifecycle, honest `failed` status reporting, no-leakage pins
 * (responses never contain DB error text, secrets, stack traces, or the raw
 * signed_request), and downstream-failure handling when the settings load
 * or the service-client construction itself THROWS (regression tests for
 * the two Phase 10.3 fixes in lib/meta/callback.ts and the data-deletion
 * route). All secrets are synthetic; the Supabase layer is the in-memory
 * fake — no real DB, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { FakeSupabase } from './helpers/fakeSupabase';
import { base64Url, buildSignedRequest, metaPayload } from './helpers/signedRequest';
import { parseSignedRequest } from '@/lib/meta/signedRequest';

const fake = new FakeSupabase();

/** Fresh synthetic secret, deliberately NOT the shared helper constants. */
const SYNTH_SECRET = 'synthetic-app-secret-phase-10-3';

const mocks = vi.hoisted(() => ({
  getMetaSettings: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: mocks.createServiceClient,
}));

vi.mock('@/lib/settings', () => ({
  getMetaSettings: mocks.getMetaSettings,
}));

import { POST as deauthorizePOST } from '@/app/api/meta/deauthorize/route';
import { POST as deletionPOST } from '@/app/api/meta/data-deletion/route';
import { GET as statusGET } from '@/app/api/meta/data-deletion/status/route';

const DEAUTH_URL = 'https://app.opendm.in/api/meta/deauthorize';
const DELETION_URL = 'https://app.opendm.in/api/meta/data-deletion';
const STATUS_URL = 'https://app.opendm.in/api/meta/data-deletion/status';

function formRequest(url: string, signedRequest: string | null): Request {
  const body = new URLSearchParams();
  if (signedRequest !== null) body.set('signed_request', signedRequest);
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

function sr(userId: string, secret: string = SYNTH_SECRET): string {
  return buildSignedRequest(metaPayload(userId), secret);
}

const TABLES = [
  'instagram_accounts',
  'data_deletion_requests',
  'contacts',
  'automation_sessions',
  'dm_sent_log',
  'dm_jobs',
  'job_queue',
] as const;

const originalAppUrl = process.env['NEXT_PUBLIC_APP_URL'];

beforeEach(() => {
  fake.calls.length = 0;
  for (const t of TABLES) fake.replaceRows(t, []);
  mocks.getMetaSettings.mockReset();
  mocks.getMetaSettings.mockResolvedValue({
    metaAppId: '1121249884134177',
    metaAppSecret: SYNTH_SECRET,
    metaFbAppSecret: null,
    webhookVerifyToken: 'synthetic-verify-token',
    setupCompleted: true,
  });
  mocks.createServiceClient.mockReset();
  mocks.createServiceClient.mockImplementation(() => fake);
  process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.opendm.in';
});

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env['NEXT_PUBLIC_APP_URL'];
  else process.env['NEXT_PUBLIC_APP_URL'] = originalAppUrl;
});

// ── Acceptance with a fresh synthetic secret ────────────────────────────────

describe('lifecycle: valid signed_request with a synthetic secret', () => {
  it('deauthorize accepts and acts (no hard-coded secret dependency)', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-1', username: 'creator' },
    ]);
    const res = await deauthorizePOST(formRequest(DEAUTH_URL, sr('IG-1')));
    expect(res.status).toBe(200);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
  });

  it('data-deletion returns the EXACT contract shape: only {url, confirmation_code}, JSON, 200', async () => {
    const res = await deletionPOST(formRequest(DELETION_URL, sr('IG-GHOST')));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['confirmation_code', 'url']);
    expect(typeof body['confirmation_code']).toBe('string');
    expect(body['confirmation_code'] as string).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(body['url']).toBe(
      `https://app.opendm.in/data-deletion/status?code=${body['confirmation_code'] as string}`
    );
  });

  it('helper: base64url segments WITH padding are accepted (Meta PHP decoder tolerates both)', () => {
    const payload = metaPayload('IG-PAD');
    const encodedPayload = Buffer.from(JSON.stringify(payload))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_'); // keep any '=' padding this time
    const sig = createHmac('sha256', SYNTH_SECRET).update(encodedPayload, 'utf8').digest();
    const encodedSig = sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(parseSignedRequest(`${encodedSig}.${encodedPayload}`, [SYNTH_SECRET])?.userId).toBe('IG-PAD');
  });

  it('helper: no freshness/expiry check — a stale issued_at still verifies (pins Meta-sample behaviour)', () => {
    const stale = buildSignedRequest(metaPayload('IG-OLD', { issued_at: 1, expires: 2 }), SYNTH_SECRET);
    expect(parseSignedRequest(stale, [SYNTH_SECRET])?.userId).toBe('IG-OLD');
  });
});

// ── Malformed / invalid inputs at route level (deletion-route gaps) ─────────

describe('lifecycle: malformed signed_request handling', () => {
  it('missing signed_request on the DATA-DELETION route → 400, no record', async () => {
    const res = await deletionPOST(formRequest(DELETION_URL, null));
    expect(res.status).toBe(400);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('empty signed_request → 400 on both routes', async () => {
    expect((await deletionPOST(formRequest(DELETION_URL, ''))).status).toBe(400);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, ''))).status).toBe(400);
  });

  it('no dot separator → 401, nothing processed', async () => {
    const res = await deletionPOST(formRequest(DELETION_URL, 'singlesegmentnodelimiter'));
    expect(res.status).toBe(401);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('bad base64 payload segment → 401, nothing processed', async () => {
    const res = await deletionPOST(formRequest(DELETION_URL, 'AAAA.!!!not-base64!!!'));
    expect(res.status).toBe(401);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('correctly signed but non-JSON payload → 401, nothing processed', async () => {
    const encodedPayload = base64Url('definitely not json');
    const sig = createHmac('sha256', SYNTH_SECRET).update(encodedPayload, 'utf8').digest();
    const res = await deletionPOST(formRequest(DELETION_URL, `${base64Url(sig)}.${encodedPayload}`));
    expect(res.status).toBe(401);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('non-form (JSON) body → 400 on both routes', async () => {
    const jsonReq = (url: string) =>
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signed_request: sr('IG-1') }),
      });
    expect((await deletionPOST(jsonReq(DELETION_URL))).status).toBe(400);
    expect((await deauthorizePOST(jsonReq(DEAUTH_URL))).status).toBe(400);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('rejection bodies never echo the signed_request or any secret', async () => {
    const forged = sr('IG-1', 'attacker-controlled-secret');
    const res = await deletionPOST(formRequest(DELETION_URL, forged));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(forged);
    expect(text).not.toContain('attacker-controlled-secret');
    expect(text).not.toContain(SYNTH_SECRET);
  });
});

// ── Scoping with multiple tenants present ───────────────────────────────────

describe('lifecycle: scoped deletion semantics', () => {
  it('data-deletion for one owner leaves the other owner fully intact', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-a', user_id: 'op-a', instagram_user_id: 'IG-A', username: 'a' },
      { id: 'acct-b', user_id: 'op-b', instagram_user_id: 'IG-B', username: 'b' },
    ]);
    const res = await deletionPOST(formRequest(DELETION_URL, sr('IG-A')));
    expect(res.status).toBe(200);
    expect(fake.rows('instagram_accounts').map((r) => r['id'])).toEqual(['acct-b']);
  });

  it('deauthorize removes only the matching account', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-a', user_id: 'op-a', instagram_user_id: 'IG-A', username: 'a' },
      { id: 'acct-b', user_id: 'op-b', instagram_user_id: 'IG-B', username: 'b' },
    ]);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr('IG-A')))).status).toBe(200);
    expect(fake.rows('instagram_accounts').map((r) => r['id'])).toEqual(['acct-b']);
  });

  it('deauthorize does NOT sweep audience rows (deauthorize ≠ data deletion)', async () => {
    fake.seed('contacts', [{ id: 'c1', audience_ig_user_id: 'IG-FAN' }]);
    fake.seed('dm_jobs', [{ id: 'j1', trigger_user_id: 'IG-FAN' }]);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr('IG-FAN')))).status).toBe(200);
    expect(fake.rows('contacts')).toHaveLength(1);
    expect(fake.rows('dm_jobs')).toHaveLength(1);
  });
});

// ── Duplicate callbacks across the full lifecycle ───────────────────────────

describe('lifecycle: duplicates and re-runs', () => {
  it('duplicate data-deletion after the user RECONNECTED deletes the new data under the SAME code', async () => {
    const first = (await (await deletionPOST(formRequest(DELETION_URL, sr('IG-OWNER')))).json()) as {
      confirmation_code: string;
    };
    // User reconnects after the first request completed.
    fake.seed('instagram_accounts', [
      { id: 'acct-2', user_id: 'op-1', instagram_user_id: 'IG-OWNER', username: 'creator' },
    ]);
    const secondRes = await deletionPOST(formRequest(DELETION_URL, sr('IG-OWNER')));
    const second = (await secondRes.json()) as { confirmation_code: string };
    expect(second.confirmation_code).toBe(first.confirmation_code);
    expect(fake.rows('data_deletion_requests')).toHaveLength(1);
    expect(fake.rows('instagram_accounts')).toHaveLength(0); // re-run actually deleted again
    expect(fake.rows('data_deletion_requests')[0]!['status']).toBe('completed');
  });

  it('failure → record marked failed → duplicate callback regenerates a NEW code and completes', async () => {
    fake.seed('contacts', [{ id: 'c1', audience_ig_user_id: 'IG-FAN' }]);
    fake.failNextQuery('contacts', { message: 'synthetic contacts outage' });

    const firstRes = await deletionPOST(formRequest(DELETION_URL, sr('IG-FAN')));
    // Design choice (documented in the route): processing failure still
    // returns the contract response; the record honestly shows `failed`.
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as { confirmation_code: string };
    expect(fake.rows('data_deletion_requests')[0]!['status']).toBe('failed');
    expect(fake.rows('contacts')).toHaveLength(1); // not deleted yet

    const secondRes = await deletionPOST(formRequest(DELETION_URL, sr('IG-FAN')));
    const second = (await secondRes.json()) as { confirmation_code: string };
    // getOrCreate excludes failed records → safe regeneration, new code.
    expect(second.confirmation_code).not.toBe(first.confirmation_code);
    const completed = fake
      .rows('data_deletion_requests')
      .find((r) => r['confirmation_code'] === second.confirmation_code);
    expect(completed?.['status']).toBe('completed');
    expect(fake.rows('contacts')).toHaveLength(0);
  });
});

// ── Status endpoint honesty ─────────────────────────────────────────────────

describe('lifecycle: status endpoint', () => {
  it('reports a failed record as failed (never as completed) and leaks no internal fields', async () => {
    fake.seed('data_deletion_requests', [
      {
        id: 'req-f',
        meta_user_id: 'IG-SECRET-ID',
        confirmation_code: 'FailedCodeXYZ123',
        status: 'failed',
        account_id: null,
        operator_user_id: 'op-internal',
        error: 'synthetic internal error detail',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      },
    ]);
    const res = await statusGET(new Request(`${STATUS_URL}?code=FailedCodeXYZ123`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('failed');
    expect(body['completed_at']).toBeNull();
    const text = JSON.stringify(body);
    expect(text).not.toContain('IG-SECRET-ID');
    expect(text).not.toContain('op-internal');
    expect(text).not.toContain('synthetic internal error detail');
  });

  it('completed record exposes a non-null completed_at via the status endpoint', async () => {
    const created = (await (await deletionPOST(formRequest(DELETION_URL, sr('IG-GHOST')))).json()) as {
      confirmation_code: string;
    };
    // Ghost user resolves not_found but still stamps completed_at in the code.
    const res = await statusGET(new Request(`${STATUS_URL}?code=${created.confirmation_code}`));
    const body = (await res.json()) as { status: string; completed_at: string | null };
    expect(body.status).toBe('not_found');
    expect(body.completed_at).toBeTruthy();
  });
});

// ── Downstream DB failures: safe errors, no leakage ─────────────────────────

describe('lifecycle: downstream failure handling', () => {
  it('deauthorize: DB lookup failure → controlled 500, generic body, account intact', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-1', username: 'creator' },
    ]);
    fake.failNextQuery('instagram_accounts', { message: 'synthetic db down XYZ' });
    const res = await deauthorizePOST(formRequest(DEAUTH_URL, sr('IG-1')));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: 'Processing failed' }));
    expect(text).not.toContain('synthetic db down XYZ');
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
  });

  it('data-deletion: record persistence failure → 500, no record, no leakage', async () => {
    fake.failNextQuery('data_deletion_requests', { message: 'synthetic insert outage XYZ' });
    const res = await deletionPOST(formRequest(DELETION_URL, sr('IG-1')));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('synthetic insert outage XYZ');
    expect(text).not.toContain('Error:');
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('status: DB failure → controlled 500 with generic body', async () => {
    fake.failNextQuery('data_deletion_requests', { message: 'synthetic status outage XYZ' });
    const res = await statusGET(new Request(`${STATUS_URL}?code=AnyCode1234567`));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('synthetic status outage XYZ');
  });
});

// ── Regression: thrown (not returned) downstream failures — Phase 10.3 fixes ─

describe('lifecycle: settings/service construction throws (Phase 10.3 regressions)', () => {
  it('getMetaSettings throws → deauthorize returns controlled 500 JSON, deletes nothing', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-1', username: 'creator' },
    ]);
    mocks.getMetaSettings.mockRejectedValueOnce(new Error('SYNTHETIC settings boom'));
    const res = await deauthorizePOST(formRequest(DEAUTH_URL, sr('IG-1')));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('SYNTHETIC settings boom');
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
  });

  it('getMetaSettings throws → data-deletion returns controlled 500 JSON, creates no record', async () => {
    mocks.getMetaSettings.mockRejectedValueOnce(new Error('SYNTHETIC settings boom'));
    const res = await deletionPOST(formRequest(DELETION_URL, sr('IG-1')));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('SYNTHETIC settings boom');
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('app not configured (settings null) → 500 fail-closed on both routes', async () => {
    mocks.getMetaSettings.mockResolvedValue(null);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr('IG-1')))).status).toBe(500);
    expect((await deletionPOST(formRequest(DELETION_URL, sr('IG-1')))).status).toBe(500);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('createServiceClient throws → data-deletion returns controlled 500 (client now built inside try)', async () => {
    mocks.createServiceClient.mockImplementationOnce(() => {
      throw new Error('SYNTHETIC env boom');
    });
    const res = await deletionPOST(formRequest(DELETION_URL, sr('IG-1')));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('SYNTHETIC env boom');
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });

  it('createServiceClient throws → deauthorize returns controlled 500 (pre-existing guard, control)', async () => {
    mocks.createServiceClient.mockImplementationOnce(() => {
      throw new Error('SYNTHETIC env boom');
    });
    const res = await deauthorizePOST(formRequest(DEAUTH_URL, sr('IG-1')));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('SYNTHETIC env boom');
  });
});
