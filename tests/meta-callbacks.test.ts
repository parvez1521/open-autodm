/**
 * Areas 2 & 3 (route level) — Meta deauthorize + data-deletion callbacks and
 * the public deletion-status endpoint. Supabase service client and Meta
 * settings are mocked; signatures are REAL (generated locally with the test
 * secrets). No network, no real DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from './helpers/fakeSupabase';
import { buildSignedRequest, metaPayload, IG_SECRET, FB_SECRET } from './helpers/signedRequest';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => fake,
}));

vi.mock('@/lib/settings', () => ({
  getMetaSettings: async () => ({
    metaAppId: '1586956306036999',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'verify-token',
    setupCompleted: true,
  }),
}));

import { POST as deauthorizePOST } from '@/app/api/meta/deauthorize/route';
import { POST as deletionPOST } from '@/app/api/meta/data-deletion/route';
import { GET as statusGET } from '@/app/api/meta/data-deletion/status/route';

function formRequest(url: string, signedRequest: string | null): Request {
  const body = new URLSearchParams();
  if (signedRequest !== null) body.set('signed_request', signedRequest);
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

const DEAUTH_URL = 'https://app.opendm.in/api/meta/deauthorize';
const DELETION_URL = 'https://app.opendm.in/api/meta/data-deletion';

const originalAppUrl = process.env['NEXT_PUBLIC_APP_URL'];

beforeEach(() => {
  fake.calls.length = 0;
  fake.replaceRows('instagram_accounts', []);
  fake.replaceRows('data_deletion_requests', []);
  fake.replaceRows('contacts', []);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('dm_jobs', []);
  fake.replaceRows('job_queue', []);
  process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.opendm.in';
});

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env['NEXT_PUBLIC_APP_URL'];
  else process.env['NEXT_PUBLIC_APP_URL'] = originalAppUrl;
});

describe('POST /api/meta/deauthorize', () => {
  it('removes the connected account for a validly signed request (200)', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-1', username: 'creator' },
    ]);
    const res = await deauthorizePOST(
      formRequest(DEAUTH_URL, buildSignedRequest(metaPayload('IG-1'), IG_SECRET))
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
  });

  it('accepts a request signed with the Facebook app secret (fallback)', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-1', username: 'creator' },
    ]);
    const res = await deauthorizePOST(
      formRequest(DEAUTH_URL, buildSignedRequest(metaPayload('IG-1'), FB_SECRET))
    );
    expect(res.status).toBe(200);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
  });

  it('is a no-op success for an unknown user', async () => {
    const res = await deauthorizePOST(
      formRequest(DEAUTH_URL, buildSignedRequest(metaPayload('IG-GHOST'), IG_SECRET))
    );
    expect(res.status).toBe(200);
    expect(fake.callsFor('instagram_accounts', 'delete')).toHaveLength(0);
  });

  it('is idempotent: a duplicate callback after removal still returns 200', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-1', username: 'creator' },
    ]);
    const sr = buildSignedRequest(metaPayload('IG-1'), IG_SECRET);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr))).status).toBe(200);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr))).status).toBe(200);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
  });

  it('rejects an invalid signature with 401 and deletes nothing', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-1', username: 'creator' },
    ]);
    const res = await deauthorizePOST(
      formRequest(DEAUTH_URL, buildSignedRequest(metaPayload('IG-1'), 'wrong-secret'))
    );
    expect(res.status).toBe(401);
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
    expect(fake.callsFor('instagram_accounts', 'delete')).toHaveLength(0);
  });

  it('rejects a missing signed_request with 400', async () => {
    const res = await deauthorizePOST(formRequest(DEAUTH_URL, null));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/meta/data-deletion', () => {
  it('owner-account path: 200 contract response, account deleted, record completed', async () => {
    fake.seed('instagram_accounts', [
      { id: 'acct-1', user_id: 'op-1', instagram_user_id: 'IG-OWNER', username: 'creator' },
    ]);
    const res = await deletionPOST(
      formRequest(DELETION_URL, buildSignedRequest(metaPayload('IG-OWNER'), IG_SECRET))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toHaveLength(16);
    expect(body.url).toBe(`https://app.opendm.in/data-deletion/status?code=${body.confirmation_code}`);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
    const record = fake.rows('data_deletion_requests')[0]!;
    expect(record['status']).toBe('completed');
    expect(record['confirmation_code']).toBe(body.confirmation_code);
  });

  it("audience path: deletes only that IGSID's audience rows", async () => {
    fake.seed('contacts', [
      { id: 'c1', audience_ig_user_id: 'IG-FAN' },
      { id: 'c2', audience_ig_user_id: 'IG-OTHER' },
    ]);
    fake.seed('dm_jobs', [{ id: 'j1', trigger_user_id: 'IG-FAN' }]);
    const res = await deletionPOST(
      formRequest(DELETION_URL, buildSignedRequest(metaPayload('IG-FAN'), IG_SECRET))
    );
    expect(res.status).toBe(200);
    expect(fake.rows('contacts').map((r) => r['id'])).toEqual(['c2']);
    expect(fake.rows('dm_jobs')).toHaveLength(0);
    expect(fake.rows('data_deletion_requests')[0]!['status']).toBe('completed');
  });

  it('unknown user: still returns the contract response; record resolves to not_found', async () => {
    const res = await deletionPOST(
      formRequest(DELETION_URL, buildSignedRequest(metaPayload('IG-GHOST'), IG_SECRET))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmation_code: string };
    expect(body.confirmation_code).toHaveLength(16);
    expect(fake.rows('data_deletion_requests')[0]!['status']).toBe('not_found');
  });

  it('duplicate request (Meta retry) reuses the SAME confirmation code', async () => {
    const sr = buildSignedRequest(metaPayload('IG-GHOST'), IG_SECRET);
    const first = (await (await deletionPOST(formRequest(DELETION_URL, sr))).json()) as {
      confirmation_code: string;
    };
    const second = (await (await deletionPOST(formRequest(DELETION_URL, sr))).json()) as {
      confirmation_code: string;
    };
    expect(second.confirmation_code).toBe(first.confirmation_code);
    expect(fake.rows('data_deletion_requests')).toHaveLength(1);
  });

  it('invalid signature: 401 and NO record is created', async () => {
    const res = await deletionPOST(
      formRequest(DELETION_URL, buildSignedRequest(metaPayload('IG-1'), 'wrong-secret'))
    );
    expect(res.status).toBe(401);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });
});

describe('GET /api/meta/data-deletion/status', () => {
  it('returns the real status for a known code', async () => {
    const sr = buildSignedRequest(metaPayload('IG-GHOST'), IG_SECRET);
    const created = (await (await deletionPOST(formRequest(DELETION_URL, sr))).json()) as {
      confirmation_code: string;
    };
    const res = await statusGET(
      new Request(`https://app.opendm.in/api/meta/data-deletion/status?code=${created.confirmation_code}`)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; confirmation_code: string };
    expect(body.status).toBe('not_found');
    expect(body.confirmation_code).toBe(created.confirmation_code);
  });

  it('returns 404 for an unknown code', async () => {
    const res = await statusGET(
      new Request('https://app.opendm.in/api/meta/data-deletion/status?code=NoSuchCode12345')
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when the code parameter is missing', async () => {
    const res = await statusGET(new Request('https://app.opendm.in/api/meta/data-deletion/status'));
    expect(res.status).toBe(400);
  });
});
