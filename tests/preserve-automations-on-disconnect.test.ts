/**
 * Preserve-on-disconnect (owner decision 2026-11-15): disconnecting an
 * Instagram account must NOT delete its automations.
 *
 * Covers:
 *  (a) legacy DELETE /api/instagram/disconnect/:accountId soft-disconnects
 *      the account row (kept, is_active=false, disconnected_at set) and
 *      auto-pauses its ACTIVE automations with paused_by_disconnect=true;
 *      a manually-paused automation keeps its own state, another
 *      account's automations are untouched, and a second DELETE is a
 *      no-op (idempotent);
 *  (b) GET /api/instagram/callback reconnecting the SAME IG account
 *      reactivates exactly the disconnect-paused automations, clears
 *      disconnected_at, and leaves a manually-paused automation paused;
 *      reconnecting a DIFFERENT IG account leaves them paused;
 *  (c) the webhook engine skips a disconnect-paused automation (no job
 *      enqueued) while an active one still fires;
 *  (d) manually resuming a disconnect-paused automation via PUT clears
 *      the flag, so a later reconnect leaves it alone.
 *
 * Route handlers are invoked directly with the in-memory FakeSupabase;
 * only auth, the service client, Meta settings, the Instagram OAuth/API
 * modules, the debug logger and env are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import type { MetaWebhookBody } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32); // 64 hex chars = 32-byte test key
const CALLER_ID = 'caller-user-id';
const IG_ID = 'IG-100';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/settings', () => ({
  getMetaSettings: async () => ({
    metaAppId: '1586956306036999',
    instagramAppId: '1121249884134177',
    metaAppSecret: 'app-secret',
    metaFbAppSecret: null,
    webhookVerifyToken: 'token',
    setupCompleted: true,
  }),
}));
vi.mock('@/lib/instagram/oauth', () => ({
  verifyOAuthState: vi.fn(),
  exchangeCodeForToken: vi.fn(async () => ({ access_token: 'short-lived-token' })),
  exchangeForLongLivedToken: vi.fn(async () => ({ access_token: 'long-lived-token', expires_in: 5184000 })),
  getInstagramProfile: vi.fn(async () => ({
    user_id: 'IG-100',
    username: 'creator',
    name: 'Creator',
    profile_picture_url: null,
  })),
}));
vi.mock('@/lib/instagram/api', () => ({ subscribeToWebhookFields: vi.fn(async () => {}) }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getAppUrl: () => 'https://app.opendm.in',
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
}));

import { DELETE as disconnectDELETE } from '@/app/api/instagram/disconnect/[accountId]/route';
import { GET as callbackGET } from '@/app/api/instagram/callback/route';
import { PUT as automationPUT } from '@/app/api/automations/[id]/route';
import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { getAuthenticatedUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyOAuthState, getInstagramProfile } from '@/lib/instagram/oauth';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockVerifyState = vi.mocked(verifyOAuthState);
const mockProfile = vi.mocked(getInstagramProfile);

const ACCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function accountRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: ACCT_A,
    user_id: CALLER_ID,
    instagram_user_id: IG_ID,
    username: 'creator',
    is_active: true,
    disconnected_at: null,
    access_token_encrypted: 'enc-old',
    token_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    ...overrides,
  };
}

function automationRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-1',
    user_id: CALLER_ID,
    instagram_account_id: ACCT_A,
    name: 'Funnel 1',
    type: 'comment_dm',
    is_active: true,
    paused_by_disconnect: false,
    // The webhook matcher filters .eq('is_traffic_guard_paused', false) —
    // the field must be present (undefined does not match).
    is_traffic_guard_paused: false,
    post_id: null,
    keywords: ['LINK'],
    trigger_config: null,
    flow_graph: null,
    dm_opening_message: 'Opening',
    ...overrides,
  };
}

function commentBody(text: string, commentId = 'cmt-1', fromId = 'IG-FAN'): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: nowSec,
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: fromId, username: 'fan' },
              media: { id: 'post-1' },
              id: commentId,
              text,
              timestamp: nowSec,
            },
          },
        ],
      },
    ],
  };
}

function callbackRequest(): Request {
  return new Request('https://app.opendm.in/api/instagram/callback?code=auth-code&state=state-jwt');
}

function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

let savedWorkspaceFlag: string | undefined;

beforeEach(() => {
  // Legacy single-owner mode for the disconnect route: the workspace
  // flag OFF means the P18 branch is never taken here.
  savedWorkspaceFlag = process.env['WORKSPACE_RUNTIME_ENABLED'];
  delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  delete process.env['ENTITLEMENTS_ENFORCED'];
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', []);
  fake.replaceRows('automations', []);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('profiles', []);
  vi.mocked(createServiceClient).mockImplementation(() => fake as unknown as SupabaseClient);
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ id: CALLER_ID, email: 'owner@example.com' });
  mockVerifyState.mockReset();
  mockVerifyState.mockResolvedValue({ userId: CALLER_ID });
  mockProfile.mockReset();
  mockProfile.mockResolvedValue({
    user_id: IG_ID,
    username: 'creator',
    name: 'Creator',
    profile_picture_url: undefined,
  });
});

afterEach(() => {
  if (savedWorkspaceFlag === undefined) delete process.env['WORKSPACE_RUNTIME_ENABLED'];
  else process.env['WORKSPACE_RUNTIME_ENABLED'] = savedWorkspaceFlag;
  vi.unstubAllGlobals();
});

describe('DELETE /api/instagram/disconnect (preserve-on-disconnect)', () => {
  it('keeps the account row and auto-pauses its ACTIVE automations; manual pauses and other accounts are untouched', async () => {
    fake.replaceRows('instagram_accounts', [
      accountRow(),
      accountRow({ id: ACCT_B, instagram_user_id: 'IG-200', username: 'other' }),
    ]);
    fake.replaceRows('automations', [
      automationRow({ id: 'auto-1' }),
      automationRow({ id: 'auto-2', name: 'Funnel 2' }),
      // Manually paused before the disconnect — must keep its own state.
      automationRow({ id: 'auto-3', name: 'Manual pause', is_active: false, paused_by_disconnect: false }),
      automationRow({ id: 'auto-b', user_id: 'someone-else', instagram_account_id: ACCT_B, name: 'Other account' }),
    ]);

    const res = await disconnectDELETE(
      new Request(`https://app.opendm.in/api/instagram/disconnect/${ACCT_A}`, { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: ACCT_A }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pausedAutomations?: number };
    expect(body.pausedAutomations).toBe(2);

    // The account row survives, only soft-disconnected.
    const account = fake.rows('instagram_accounts').find((r) => r['id'] === ACCT_A)!;
    expect(account['is_active']).toBe(false);
    expect(typeof account['disconnected_at']).toBe('string');
    // No automation row was deleted.
    expect(fake.rows('automations')).toHaveLength(4);
    const auto1 = fake.rows('automations').find((r) => r['id'] === 'auto-1')!;
    const auto2 = fake.rows('automations').find((r) => r['id'] === 'auto-2')!;
    expect(auto1['is_active']).toBe(false);
    expect(auto1['paused_by_disconnect']).toBe(true);
    expect(auto2['is_active']).toBe(false);
    expect(auto2['paused_by_disconnect']).toBe(true);
    // Manual pause: flag stays false.
    const auto3 = fake.rows('automations').find((r) => r['id'] === 'auto-3')!;
    expect(auto3['is_active']).toBe(false);
    expect(auto3['paused_by_disconnect']).toBe(false);
    // Other account: untouched.
    const autoB = fake.rows('automations').find((r) => r['id'] === 'auto-b')!;
    expect(autoB['is_active']).toBe(true);
    expect(autoB['paused_by_disconnect']).toBe(false);
    const accountB = fake.rows('instagram_accounts').find((r) => r['id'] === ACCT_B)!;
    expect(accountB['is_active']).toBe(true);
  });

  it('is idempotent: a second disconnect is a no-op success', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow({ id: 'auto-1' })]);
    const ctx = { params: Promise.resolve({ accountId: ACCT_A }) };
    const first = await disconnectDELETE(
      new Request(`https://app.opendm.in/api/instagram/disconnect/${ACCT_A}`, { method: 'DELETE' }),
      ctx,
    );
    expect(first.status).toBe(200);
    const second = await disconnectDELETE(
      new Request(`https://app.opendm.in/api/instagram/disconnect/${ACCT_A}`, { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: ACCT_A }) },
    );
    expect(second.status).toBe(200);
    const account = fake.rows('instagram_accounts').find((r) => r['id'] === ACCT_A)!;
    expect(account['is_active']).toBe(false);
    expect(fake.rows('automations')).toHaveLength(1);
    expect(fake.rows('automations')[0]!['paused_by_disconnect']).toBe(true);
  });

  it('404s for an unknown account and for another user’s account, with zero mutation', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow({ id: 'auto-1' })]);
    const unknown = await disconnectDELETE(
      new Request('https://app.opendm.in/api/instagram/disconnect/00000000-0000-4000-8000-000000000099', { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: '00000000-0000-4000-8000-000000000099' }) },
    );
    expect(unknown.status).toBe(404);

    mockAuth.mockResolvedValue({ id: 'someone-else', email: 'other@example.com' });
    const foreign = await disconnectDELETE(
      new Request(`https://app.opendm.in/api/instagram/disconnect/${ACCT_A}`, { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: ACCT_A }) },
    );
    expect(foreign.status).toBe(404);
    expect(fake.rows('instagram_accounts').find((r) => r['id'] === ACCT_A)!['is_active']).toBe(true);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-1')!['is_active']).toBe(true);
  });
});

describe('GET /api/instagram/callback reactivates disconnect-paused automations', () => {
  it('same IG account reconnect: account active again, flagged automations resume, manual pause stays paused', async () => {
    fake.replaceRows('instagram_accounts', [
      accountRow({ is_active: false, disconnected_at: '2026-11-15T18:00:00.000Z' }),
    ]);
    fake.replaceRows('automations', [
      automationRow({ id: 'auto-1', is_active: false, paused_by_disconnect: true }),
      automationRow({ id: 'auto-2', name: 'Funnel 2', is_active: false, paused_by_disconnect: true }),
      automationRow({ id: 'auto-3', name: 'Manual pause', is_active: false, paused_by_disconnect: false }),
    ]);

    const res = await callbackGET(callbackRequest());
    expect(res.status).toBe(302);
    expect(location(res)).toContain('instagram_connected=true');

    const account = fake.rows('instagram_accounts').find((r) => r['id'] === ACCT_A)!;
    expect(account['is_active']).toBe(true);
    expect(account['disconnected_at']).toBeNull();
    const auto1 = fake.rows('automations').find((r) => r['id'] === 'auto-1')!;
    const auto2 = fake.rows('automations').find((r) => r['id'] === 'auto-2')!;
    expect(auto1['is_active']).toBe(true);
    expect(auto1['paused_by_disconnect']).toBe(false);
    expect(auto2['is_active']).toBe(true);
    expect(auto2['paused_by_disconnect']).toBe(false);
    // The manually-paused automation is NOT resurrected by the reconnect.
    const auto3 = fake.rows('automations').find((r) => r['id'] === 'auto-3')!;
    expect(auto3['is_active']).toBe(false);
    expect(auto3['paused_by_disconnect']).toBe(false);
  });

  it('a DIFFERENT IG account reconnecting leaves the paused automations paused', async () => {
    fake.replaceRows('instagram_accounts', [
      accountRow({ is_active: false, disconnected_at: '2026-11-15T18:00:00.000Z' }),
    ]);
    fake.replaceRows('automations', [
      automationRow({ id: 'auto-1', is_active: false, paused_by_disconnect: true }),
    ]);
    mockProfile.mockResolvedValue({
      user_id: 'IG-200',
      username: 'other',
      name: 'Other',
      profile_picture_url: undefined,
    });

    const res = await callbackGET(callbackRequest());
    expect(res.status).toBe(302);
    expect(location(res)).toContain('instagram_connected=true');

    // A new row was created for the other IG account…
    expect(fake.rows('instagram_accounts')).toHaveLength(2);
    // …but the disconnected account's automation is still paused.
    const auto1 = fake.rows('automations').find((r) => r['id'] === 'auto-1')!;
    expect(auto1['is_active']).toBe(false);
    expect(auto1['paused_by_disconnect']).toBe(true);
  });
});

describe('webhook engine skips disconnect-paused automations', () => {
  it('a matching comment enqueues nothing while the automation is disconnect-paused', async () => {
    fake.replaceRows('instagram_accounts', [accountRow({ id: 'acct-1', instagram_user_id: IG_ID })]);
    fake.replaceRows('automations', [
      automationRow({ id: 'auto-1', instagram_account_id: 'acct-1', is_active: false, paused_by_disconnect: true }),
    ]);
    expect(await processWebhookPayload(commentBody('LINK'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('control: the same comment fires once the automation is active again', async () => {
    fake.replaceRows('instagram_accounts', [accountRow({ id: 'acct-1', instagram_user_id: IG_ID })]);
    fake.replaceRows('automations', [
      automationRow({ id: 'auto-1', instagram_account_id: 'acct-1', is_active: true, paused_by_disconnect: false }),
    ]);
    expect(await processWebhookPayload(commentBody('LINK'))).toBe(1);
    expect(fake.rows('job_queue')).toHaveLength(1);
  });
});

describe('PUT /api/automations/[id] manual resume clears the disconnect flag', () => {
  it('resuming a disconnect-paused automation clears paused_by_disconnect', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [
      automationRow({ id: 'auto-1', is_active: false, paused_by_disconnect: true, flow_graph: null }),
    ]);
    const res = await automationPUT(
      new Request('https://app.opendm.in/api/automations/auto-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true }),
      }),
      { params: Promise.resolve({ id: 'auto-1' }) },
    );
    expect(res.status).toBe(200);
    const row = fake.rows('automations').find((r) => r['id'] === 'auto-1')!;
    expect(row['is_active']).toBe(true);
    expect(row['paused_by_disconnect']).toBe(false);
  });
});
