/**
 * Phase 10.3 E2E (Area 12) — deauthorize / data-deletion as ONE
 * lifecycle, with the deletion-status endpoint as the closing check.
 *
 * tests/meta-callbacks.test.ts proves each route's contract separately.
 * This file EXTENDS it into the sequence Meta actually drives over an
 * account's life: connect-state exists → deauthorize removes it
 * (idempotently) → an audience member's data-deletion removes ONLY
 * that member's rows → the status endpoint reports the true state for
 * the issued code and answers honestly for an unknown one → forged
 * signatures at any step delete nothing and record nothing.
 * Signatures are REAL (locally generated with synthetic secrets via
 * tests/helpers/signedRequest); payloads are mocked Meta shapes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';
import { buildSignedRequest, metaPayload, IG_SECRET, FB_SECRET } from '../helpers/signedRequest';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/settings', () => ({
  getMetaSettings: async () => ({
    metaAppId: '1586956306036999',
    metaAppSecret: IG_SECRET,
    metaFbAppSecret: FB_SECRET,
    webhookVerifyToken: 'synthetic-verify-token',
    setupCompleted: true,
  }),
}));

import { POST as deauthorizePOST } from '@/app/api/meta/deauthorize/route';
import { POST as deletionPOST } from '@/app/api/meta/data-deletion/route';
import { GET as statusGET } from '@/app/api/meta/data-deletion/status/route';

const DEAUTH_URL = 'https://app.opendm.in/api/meta/deauthorize';
const DELETION_URL = 'https://app.opendm.in/api/meta/data-deletion';
const originalAppUrl = process.env['NEXT_PUBLIC_APP_URL'];

function formRequest(url: string, signedRequest: string | null): Request {
  const body = new URLSearchParams();
  if (signedRequest !== null) body.set('signed_request', signedRequest);
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

function seedWorld(): void {
  fake.replaceRows('instagram_accounts', [
    { id: 'acct-life', user_id: 'op-1', instagram_user_id: 'IG-LIFE-OWNER', username: 'creator' },
  ]);
  fake.replaceRows('contacts', [
    { id: 'c-fan', audience_ig_user_id: 'IG-LIFE-FAN' },
    { id: 'c-other', audience_ig_user_id: 'IG-LIFE-OTHER' },
  ]);
  fake.replaceRows('dm_jobs', [
    { id: 'j-fan', trigger_user_id: 'IG-LIFE-FAN' },
    { id: 'j-other', trigger_user_id: 'IG-LIFE-OTHER' },
  ]);
  fake.replaceRows('automation_sessions', []);
  fake.replaceRows('dm_sent_log', []);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('data_deletion_requests', []);
}

beforeEach(() => {
  fake.calls.length = 0;
  seedWorld();
  process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.opendm.in';
});

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env['NEXT_PUBLIC_APP_URL'];
  else process.env['NEXT_PUBLIC_APP_URL'] = originalAppUrl;
});

describe('the full lifecycle in one world', () => {
  it('deauthorize (IG secret) removes the account; a duplicate callback is a harmless 200', async () => {
    const sr = buildSignedRequest(metaPayload('IG-LIFE-OWNER'), IG_SECRET);
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr))).status).toBe(200);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);

    // Meta retry after the account is already gone: still 200, no error.
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr))).status).toBe(200);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
    // Audience data is untouched by a deauthorize — deletion is its own flow.
    expect(fake.rows('contacts')).toHaveLength(2);
  });

  it('audience data-deletion (FB secret fallback) removes ONLY that member, then status reports the truth', async () => {
    const sr = buildSignedRequest(metaPayload('IG-LIFE-FAN'), FB_SECRET);
    const res = await deletionPOST(formRequest(DELETION_URL, sr));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toHaveLength(16);
    expect(body.url).toBe(`https://app.opendm.in/data-deletion/status?code=${body.confirmation_code}`);

    // Only the fan's rows are gone; the other member and the owner account remain.
    expect(fake.rows('contacts').map((r) => r['id'])).toEqual(['c-other']);
    expect(fake.rows('dm_jobs').map((r) => r['id'])).toEqual(['j-other']);
    expect(fake.rows('instagram_accounts')).toHaveLength(1);

    // Status endpoint closes the loop with the true state…
    const statusRes = await statusGET(
      new Request(`https://app.opendm.in/api/meta/data-deletion/status?code=${body.confirmation_code}`)
    );
    expect(statusRes.status).toBe(200);
    expect(((await statusRes.json()) as { status: string }).status).toBe('completed');

    // …and answers honestly for codes it never issued.
    const unknown = await statusGET(
      new Request('https://app.opendm.in/api/meta/data-deletion/status?code=NoSuchCode12345')
    );
    expect(unknown.status).toBe(404);
    const missing = await statusGET(new Request('https://app.opendm.in/api/meta/data-deletion/status'));
    expect(missing.status).toBe(400);

    // A Meta retry of the same deletion reuses the SAME confirmation code.
    const retry = (await (await deletionPOST(formRequest(DELETION_URL, sr))).json()) as {
      confirmation_code: string;
    };
    expect(retry.confirmation_code).toBe(body.confirmation_code);
    expect(fake.rows('data_deletion_requests')).toHaveLength(1);
  });

  it('owner data-deletion removes the account itself and completes the record', async () => {
    const sr = buildSignedRequest(metaPayload('IG-LIFE-OWNER'), IG_SECRET);
    const res = await deletionPOST(formRequest(DELETION_URL, sr));
    expect(res.status).toBe(200);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
    expect(fake.rows('data_deletion_requests')[0]!['status']).toBe('completed');
  });
});

describe('forgery at any step changes nothing', () => {
  it('invalid-signature deauthorize → 401, account intact', async () => {
    const sr = buildSignedRequest(metaPayload('IG-LIFE-OWNER'), 'wrong-secret');
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, sr))).status).toBe(401);
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
    expect(fake.callsFor('instagram_accounts', 'delete')).toHaveLength(0);
  });

  it('invalid-signature data-deletion → 401, no record created, no rows deleted', async () => {
    const sr = buildSignedRequest(metaPayload('IG-LIFE-FAN'), 'wrong-secret');
    expect((await deletionPOST(formRequest(DELETION_URL, sr))).status).toBe(401);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
    expect(fake.rows('contacts')).toHaveLength(2);
  });

  it('missing signed_request → 400 on both callbacks', async () => {
    expect((await deauthorizePOST(formRequest(DEAUTH_URL, null))).status).toBe(400);
    expect((await deletionPOST(formRequest(DELETION_URL, null))).status).toBe(400);
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
    expect(fake.rows('data_deletion_requests')).toHaveLength(0);
  });
});
