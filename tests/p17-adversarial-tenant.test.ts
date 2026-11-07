/**
 * Programme 17 / Workstream A — CLAIM 2 RE-VERIFICATION + ADVERSARIAL MATRIX.
 *
 * Claim 2: src/lib/tenancy/context.ts fail-closed workspace resolution.
 * Adversarial additions beyond tests/tenancy-context.test.ts (17) and
 * tests/tenancy-security-matrix.test.ts §2–§6:
 *   §A garbage-role / malformed-input extensions, error+data, and the
 *      EXACT transport-throw behaviour of both resolvers;
 *   §B per-request resolution semantics: membership revocation and role
 *      change mid-session take effect on the NEXT resolve (no caching),
 *      a previously issued context is an immutable snapshot;
 *      multi-workspace users resolve each workspace independently;
 *   §C request-data tampering: role / user_id / workspace_id /
 *      instagram_account_id fields smuggled in API request bodies are
 *      ignored (zod-stripped) and never change ownership;
 *   §D IDOR sweep on the [accountId] routes the Phase E matrix did not
 *      execute (disconnect, refresh, resubscribe) + the posts cache
 *      collision behaviour for multi-user / multi-workspace callers;
 *   §E workspace-context handling on the connect route: non-member and
 *      member-with-insufficient-role fail closed; empty param falls back
 *      to the legacy flow (pinned as observed behaviour);
 *   §F forged workspace claims at deeper webhook nesting levels;
 *   §G source pins: posts cache key composition; no tenant user route
 *      other than connect/callback consults workspace role (legacy
 *      user_id scoping is the transitional boundary — documented, not
 *      silently assumed).
 *
 * All evidence is local mocked-harness only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutoDmJobPayload, MetaWebhookBody } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32);
const WS_A = 'workspace-A';
const WS_B = 'workspace-B';
const OWNER_A = 'user-owner-a';
const OWNER_B = 'user-owner-b';
const MEMBER_B = 'user-member-b'; // owns workspace B; stranger to A's resources
const MULTI = 'user-multi'; // member of both workspaces, different roles

const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  getAppUrl: () => 'https://app.opendm.in',
}));
vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/instagram/api', () => ({
  META_API_VERSION: 'v23.0',
  sendInstagramDm: vi.fn(async () => 'msg-1'),
  sendInstagramLinkButtonDm: vi.fn(async () => 'msg-2'),
  sendInstagramCardDm: vi.fn(async () => 'msg-3'),
  sendAskToFollowDm: vi.fn(async () => 'msg-4'),
  replyToComment: vi.fn(async () => {}),
  getAudienceProfile: vi.fn(async () => null),
  subscribeToWebhookFields: vi.fn(async () => ({ ok: true, body: 'subscribed' })),
  WEBHOOK_SUBSCRIBED_FIELDS: ['comments', 'messages'],
  getSubscribedFields: vi.fn(async () => ({ ok: true, fields: ['comments'], raw: '{}' })),
}));
vi.mock('@/lib/instagram/oauth', () => ({
  refreshLongLivedToken: vi.fn(async () => ({ access_token: 'new-token', expires_in: 5_184_000 })),
  signOAuthState: vi.fn(async (userId: string, workspaceId?: string) =>
    workspaceId ? `state:${userId}:${workspaceId}` : `state:${userId}`),
  buildOAuthUrl: vi.fn(() => 'https://meta.example/oauth'),
  verifyOAuthState: vi.fn(async () => ({ userId: 'x' })),
}));
vi.mock('@/lib/settings', () => ({
  getMetaSettings: vi.fn(async () => ({ metaAppId: 'app-1', metaAppSecret: 's' })),
  invalidateSettingsCache: vi.fn(),
}));
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

import {
  resolveWorkspaceContext,
  resolveWorkspaceForAccount,
  requireWorkspaceRole,
  canWrite,
  WorkspaceAccessError,
} from '@/lib/tenancy/context';
import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { PUT as automationPUT } from '@/app/api/automations/[id]/route';
import { POST as automationsCreate } from '@/app/api/automations/route';
import { DELETE as disconnectDELETE } from '@/app/api/instagram/disconnect/[accountId]/route';
import { POST as refreshPOST } from '@/app/api/instagram/refresh/[accountId]/route';
import { POST as resubscribePOST } from '@/app/api/instagram/resubscribe/[accountId]/route';
import { GET as postsGET } from '@/app/api/instagram/posts/[accountId]/route';
import { GET as connectGET } from '@/app/api/instagram/connect/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { subscribeToWebhookFields } from '@/lib/instagram/api';
import { refreshLongLivedToken } from '@/lib/instagram/oauth';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockSubscribe = vi.mocked(subscribeToWebhookFields);
const mockRefresh = vi.mocked(refreshLongLivedToken);
const db = fake as unknown as SupabaseClient;

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

const TABLES = [
  'instagram_accounts', 'automations', 'job_queue', 'dm_sent_log', 'dm_jobs',
  'dm_logs', 'automation_sessions', 'automation_follow_ups', 'recipient_opt_outs',
  'comment_private_reply_reservations', 'comment_public_reply_reservations',
  'workspace_memberships', 'workspace_instagram_accounts', 'profiles',
  'debug_events', 'ai_usage_log', 'app_settings', 'platform_config',
  'inbound_webhook_events',
] as const;

function accountRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'acct-A',
    user_id: OWNER_A,
    instagram_user_id: 'IG-A',
    username: 'creator-a',
    is_active: true,
    access_token_encrypted: encrypt('token-acct-A', TOKEN_KEY),
    token_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    paused_until: null,
    pause_reason: null,
    traffic_guard_paused: false,
    workspace_id: WS_A,
    ...overrides,
  };
}

function automationRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-A',
    user_id: OWNER_A,
    instagram_account_id: 'acct-A',
    name: 'Automation A',
    type: 'comment_dm',
    is_active: true,
    post_id: null,
    keywords: ['LINK'],
    comment_reply_options: [],
    public_reply_enabled: false,
    public_reply_options: [],
    trigger_config: null,
    flow_graph: null,
    dm_opening_message_enabled: true,
    dm_opening_message: 'Opening from A',
    dm_opening_message_button_title: null,
    dm_opening_message_button_link: null,
    ask_to_follow_enabled: false,
    ask_to_follow_message: '',
    ask_to_follow_visit_profile_button: '',
    ask_to_follow_confirm_button: '',
    dm_responses: [{ id: 'r1', type: 'text', content: 'Response from A' }],
    follow_up_enabled: false,
    follow_up_delay_minutes: 60,
    follow_up_message: '',
    is_traffic_guard_paused: false,
    total_dms_sent: 0,
    ...overrides,
  };
}

function seedTwoTenants(): void {
  fake.replaceRows('instagram_accounts', [
    accountRow(),
    accountRow({
      id: 'acct-B', user_id: OWNER_B, instagram_user_id: 'IG-B',
      username: 'creator-b', workspace_id: WS_B,
      access_token_encrypted: encrypt('token-acct-B', TOKEN_KEY),
    }),
  ]);
  fake.replaceRows('automations', [
    automationRow(),
    automationRow({ id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B', name: 'Automation B' }),
  ]);
  fake.replaceRows('workspace_memberships', [
    { workspace_id: WS_A, user_id: OWNER_A, role: 'owner' },
    { workspace_id: WS_B, user_id: OWNER_B, role: 'owner' },
    { workspace_id: WS_B, user_id: MEMBER_B, role: 'owner' },
    { workspace_id: WS_A, user_id: MULTI, role: 'owner' },
    { workspace_id: WS_B, user_id: MULTI, role: 'viewer' },
  ]);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
  afterCallbacks.length = 0;
  mockAuth.mockReset();
  mockSubscribe.mockClear();
  mockRefresh.mockClear();
  timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = null;
  vi.unstubAllGlobals();
});

// ── §A. Claim 2: fail-closed extensions + exact transport behaviour ────────

describe('§A resolveWorkspaceContext fail-closed (Claim 2 extensions)', () => {
  const WS = 'ws-claim2';
  const USER = 'user-claim2';

  it('client-supplied workspace_id alone is never sufficient: a valid workspace id + non-member user throws not-a-member', async () => {
    fake.replaceRows('workspace_memberships', [{ workspace_id: WS, user_id: 'someone-else', role: 'owner' }]);
    await expect(resolveWorkspaceContext(db, USER, WS)).rejects.toMatchObject({
      name: 'WorkspaceAccessError', code: 'not-a-member',
    });
  });

  it('garbage-role extensions: undefined, padded/case variants, zero, false, array all throw not-a-member', async () => {
    for (const role of [undefined, ' viewer', 'viewer ', 'Admin', 'OWNER ', 0, false, ['owner']]) {
      fake.replaceRows('workspace_memberships', [{ workspace_id: WS, user_id: USER, role }]);
      await expect(
        resolveWorkspaceContext(db, USER, WS),
        `role=${JSON.stringify(role)}`
      ).rejects.toMatchObject({ name: 'WorkspaceAccessError', code: 'not-a-member' });
    }
  });

  it('whitespace-only userId throws not-a-member without issuing a context', async () => {
    fake.replaceRows('workspace_memberships', [{ workspace_id: WS, user_id: USER, role: 'owner' }]);
    await expect(resolveWorkspaceContext(db, '   ', WS)).rejects.toMatchObject({ code: 'not-a-member' });
  });

  it('TRANSPORT THROW (resolveWorkspaceContext): propagates the RAW error — NOT wrapped in WorkspaceAccessError, no context issued', async () => {
    const raw = new Error('connection reset');
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => { throw raw; },
    };
    const stub = { from: () => builder } as unknown as SupabaseClient;
    let caught: unknown = null;
    try {
      await resolveWorkspaceContext(stub, USER, WS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(raw); // identity: the exact thrown error escapes
    expect(caught).not.toBeInstanceOf(WorkspaceAccessError);
    expect((caught as Error).message).toBe('connection reset');
  });

  it('TRANSPORT THROW (resolveWorkspaceForAccount): also propagates RAW — its "returns null on failure" contract covers only the {error} result, not a throw', async () => {
    const raw = new Error('socket hangup');
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => { throw raw; },
    };
    const stub = { from: () => builder } as unknown as SupabaseClient;
    let caught: unknown = null;
    try {
      await resolveWorkspaceForAccount(stub, 'acct-A');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(raw);
    // Control: the {error} result form DOES resolve null (no throw).
    const errBuilder = {
      select: () => errBuilder,
      eq: () => errBuilder,
      maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
    };
    const errStub = { from: () => errBuilder } as unknown as SupabaseClient;
    await expect(resolveWorkspaceForAccount(errStub, 'acct-A')).resolves.toBeNull();
  });

  it('membership row whose workspace_id field disagrees in type (non-string) still resolves with the REQUESTED workspace id (row role is the evidence)', async () => {
    // Source: the returned workspaceId falls back to the requested id when
    // data.workspace_id is not a string. The role check is what gates.
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: { workspace_id: 42, user_id: USER, role: 'member' }, error: null }),
    };
    const stub = { from: () => builder } as unknown as SupabaseClient;
    await expect(resolveWorkspaceContext(stub, USER, WS)).resolves.toEqual({
      workspaceId: WS, userId: USER, role: 'member',
    });
  });
});

// ── §B. Per-request resolution: revocation / role change / multi-WS ────────

describe('§B membership is looked up per resolve call (no caching in context.ts)', () => {
  it('revocation mid-session: first resolve succeeds, after the membership row is removed the NEXT resolve throws not-a-member', async () => {
    seedTwoTenants();
    await expect(resolveWorkspaceContext(db, OWNER_A, WS_A)).resolves.toMatchObject({ role: 'owner' });
    fake.replaceRows(
      'workspace_memberships',
      fake.rows('workspace_memberships').filter((r) => !(r['workspace_id'] === WS_A && r['user_id'] === OWNER_A))
    );
    await expect(resolveWorkspaceContext(db, OWNER_A, WS_A)).rejects.toMatchObject({ code: 'not-a-member' });
  });

  it('role change mid-flight (member→viewer): re-resolve sees viewer and the write gate closes; the previously issued snapshot is unchanged (callers must re-resolve per request)', async () => {
    fake.replaceRows('workspace_memberships', [{ workspace_id: WS_A, user_id: MULTI, role: 'member' }]);
    const before = await resolveWorkspaceContext(db, MULTI, WS_A);
    expect(before.role).toBe('member');
    expect(canWrite(before.role)).toBe(true);

    fake.replaceRows('workspace_memberships', [{ workspace_id: WS_A, user_id: MULTI, role: 'viewer' }]);
    const after = await resolveWorkspaceContext(db, MULTI, WS_A);
    expect(after.role).toBe('viewer');
    expect(canWrite(after.role)).toBe(false);
    expect(() => requireWorkspaceRole(after, ['owner', 'admin', 'member'])).toThrowError(WorkspaceAccessError);
    // Snapshot semantics pinned: the OLD context object still says member —
    // protection comes from per-request re-resolution, not from mutation.
    expect(before.role).toBe('member');
  });

  it('multi-workspace user: each workspace resolves its OWN role (owner in A, viewer in B)', async () => {
    seedTwoTenants();
    await expect(resolveWorkspaceContext(db, MULTI, WS_A)).resolves.toMatchObject({ role: 'owner' });
    await expect(resolveWorkspaceContext(db, MULTI, WS_B)).resolves.toMatchObject({ role: 'viewer' });
    const ctxB = await resolveWorkspaceContext(db, MULTI, WS_B);
    expect(canWrite(ctxB.role)).toBe(false);
  });
});

// ── §C. Request-data tampering toward privileged roles/ownership ───────────

describe('§C request bodies cannot smuggle role/ownership fields', () => {
  beforeEach(() => seedTwoTenants());

  it('PUT /api/automations/[id] with smuggled user_id/workspace_id/role/instagram_account_id: 200 for the owner, but ownership and binding are byte-identical', async () => {
    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const res = await automationPUT(
      new Request('https://app.opendm.in/api/automations/auto-A', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Renamed legitimately',
          user_id: OWNER_B,
          workspace_id: WS_B,
          role: 'owner',
          instagram_account_id: 'acct-B',
        }),
      }),
      { params: Promise.resolve({ id: 'auto-A' }) }
    );
    // automationPUT is imported from the [id] route (PUT lives there);
    // POST on that module does not exist — this call is PUT by construction.
    expect(res.status).toBe(200);
    const row = fake.rows('automations').find((r) => r['id'] === 'auto-A')!;
    expect(row['name']).toBe('Renamed legitimately');
    expect(row['user_id']).toBe(OWNER_A);
    expect(row['instagram_account_id']).toBe('acct-A');
    expect('workspace_id' in row).toBe(false);
    expect('role' in row).toBe(false);
  });

  it('POST /api/automations with smuggled user_id/workspace_id: created row is owned by the AUTHENTICATED user, workspace field absent', async () => {
    // The create schema requires a UUID account id; seed one owned by A.
    const UUID_ACCT = '00000000-0000-4000-8000-0000000000a1';
    fake.seed('instagram_accounts', [accountRow({ id: UUID_ACCT })]);
    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const res = await automationsCreate(
      new Request('https://app.opendm.in/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instagramAccountId: UUID_ACCT,
          name: 'Created by A',
          type: 'comment_dm',
          user_id: OWNER_B,
          workspace_id: WS_B,
          role: 'owner',
        }),
      })
    );
    expect(res.status).toBe(201);
    const created = fake.rows('automations').find((r) => r['name'] === 'Created by A')!;
    expect(created['user_id']).toBe(OWNER_A);
    expect('workspace_id' in created).toBe(false);
    expect('role' in created).toBe(false);
  });

  it('POST /api/automations by a workspace-B principal against A\u2019s account id: 403, nothing created (workspace standing confers nothing on the legacy route)', async () => {
    const UUID_ACCT = '00000000-0000-4000-8000-0000000000a1';
    fake.seed('instagram_accounts', [accountRow({ id: UUID_ACCT })]);
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const countBefore = fake.rows('automations').length;
    const res = await automationsCreate(
      new Request('https://app.opendm.in/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instagramAccountId: UUID_ACCT, name: 'Hijack attempt', type: 'comment_dm' }),
      })
    );
    expect(res.status).toBe(403);
    expect(fake.rows('automations')).toHaveLength(countBefore);
  });
});

// ── §D. IDOR sweep: [accountId] routes + posts cache ───────────────────────

describe('§D IDOR on instagram [accountId] routes (B principal vs A account)', () => {
  beforeEach(() => seedTwoTenants());

  it('DELETE /api/instagram/disconnect/[accountId]: B → 404, A\u2019s account row intact; owner control → 200 and row deleted', async () => {
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const denied = await disconnectDELETE(
      new Request('https://app.opendm.in/api/instagram/disconnect/acct-A', { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: 'acct-A' }) }
    );
    expect(denied.status).toBe(404);
    expect(fake.rows('instagram_accounts').some((r) => r['id'] === 'acct-A')).toBe(true);

    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const ok = await disconnectDELETE(
      new Request('https://app.opendm.in/api/instagram/disconnect/acct-A', { method: 'DELETE' }),
      { params: Promise.resolve({ accountId: 'acct-A' }) }
    );
    expect(ok.status).toBe(200);
    expect(fake.rows('instagram_accounts').some((r) => r['id'] === 'acct-A')).toBe(false);
  });

  it('POST /api/instagram/refresh/[accountId]: B → 404, token-refresh never invoked, A\u2019s stored token byte-identical', async () => {
    const tokenBefore = fake.rows('instagram_accounts').find((r) => r['id'] === 'acct-A')!['access_token_encrypted'];
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const res = await refreshPOST(
      new Request('https://app.opendm.in/api/instagram/refresh/acct-A', { method: 'POST' }),
      { params: Promise.resolve({ accountId: 'acct-A' }) }
    );
    expect(res.status).toBe(404);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(fake.rows('instagram_accounts').find((r) => r['id'] === 'acct-A')!['access_token_encrypted']).toBe(tokenBefore);
  });

  it('POST /api/instagram/resubscribe/[accountId]: B → 404, Meta subscribe never invoked; owner control → 200', async () => {
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const denied = await resubscribePOST(
      new Request('https://app.opendm.in/api/instagram/resubscribe/acct-A', { method: 'POST' }),
      { params: Promise.resolve({ accountId: 'acct-A' }) }
    );
    expect(denied.status).toBe(404);
    expect(mockSubscribe).not.toHaveBeenCalled();

    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const ok = await resubscribePOST(
      new Request('https://app.opendm.in/api/instagram/resubscribe/acct-A', { method: 'POST' }),
      { params: Promise.resolve({ accountId: 'acct-A' }) }
    );
    expect(ok.status).toBe(200);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it('posts cache collision: A\u2019s cached page is never served to B — B gets 404 even with a warm cache for the same accountId', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'post-A1', media_type: 'IMAGE', permalink: 'https://instagram.com/p/A1', timestamp: '2026-11-06T00:00:00Z', caption: 'A post' }],
          paging: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchSpy);

    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const first = await postsGET(new Request('https://app.opendm.in/api/instagram/posts/acct-A'), {
      params: Promise.resolve({ accountId: 'acct-A' }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { cached: boolean }).cached).toBe(false);

    // Warm-cache hit for the SAME user proves the cache is live…
    const second = await postsGET(new Request('https://app.opendm.in/api/instagram/posts/acct-A'), {
      params: Promise.resolve({ accountId: 'acct-A' }),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // …but a different authenticated user asking for the same accountId
    // hits the ownership query first and gets 404 — never the cached page.
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const foreign = await postsGET(new Request('https://app.opendm.in/api/instagram/posts/acct-A'), {
      params: Promise.resolve({ accountId: 'acct-A' }),
    });
    expect(foreign.status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── §E. Connect route workspace-context handling ───────────────────────────

describe('§E GET /api/instagram/connect workspace gate', () => {
  beforeEach(() => seedTwoTenants());

  it('non-member asking for WS_B: 302 to settings with workspace_not_authorized, no OAuth URL issued', async () => {
    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const res = await connectGET(new Request(`https://app.opendm.in/api/instagram/connect?workspace=${WS_B}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('instagram_error=workspace_not_authorized');
  });

  it('member with insufficient role (viewer of WS_B) asking for WS_B: also 302 fail-closed', async () => {
    mockAuth.mockResolvedValue({ id: MULTI, email: 'm@example.com' });
    const res = await connectGET(new Request(`https://app.opendm.in/api/instagram/connect?workspace=${WS_B}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('instagram_error=workspace_not_authorized');
  });

  it('owner of WS_B: 200 with an OAuth URL (control)', async () => {
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const res = await connectGET(new Request(`https://app.opendm.in/api/instagram/connect?workspace=${WS_B}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain('meta.example');
  });

  it('no workspace param: legacy flow issues a URL without any membership (transitional behaviour, pinned)', async () => {
    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const res = await connectGET(new Request('https://app.opendm.in/api/instagram/connect'));
    expect(res.status).toBe(200);
  });

  it('empty workspace param (?workspace=): treated as ABSENT — legacy flow, not fail-closed (pinned as observed)', async () => {
    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const res = await connectGET(new Request('https://app.opendm.in/api/instagram/connect?workspace='));
    expect(res.status).toBe(200);
  });
});

// ── §F. Forged workspace claims at deeper webhook nesting ──────────────────

describe('§F forged workspaceId at deeper nesting levels is ignored', () => {
  it('comment body with workspaceId inside value.from / value.media / entry.changes[].field-level: stamp is still the bound WS_A', async () => {
    seedTwoTenants();
    const nowSec = Math.floor(Date.now() / 1000);
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'IG-A',
          time: nowSec,
          changes: [
            {
              field: 'comments',
              workspaceId: WS_B,
              value: {
                from: { id: 'IG-FAN', username: 'fan', workspaceId: WS_B },
                media: { id: 'post-1', workspaceId: WS_B },
                id: 'cmt-deep',
                text: 'LINK',
                timestamp: nowSec,
                workspaceId: WS_B,
              },
            },
          ],
        },
      ],
    } as unknown as MetaWebhookBody;
    const enqueued = await processWebhookPayload(body);
    expect(enqueued).toBe(1);
    const row = fake.rows('job_queue')[0]!;
    expect(row['workspace_id']).toBe(WS_A);
    expect((row['payload'] as AutoDmJobPayload).workspaceId).toBe(WS_A);
  });
});

// ── §G. Source pins (cache key + route/workspace inventory) ────────────────

describe('§G source pins', () => {
  const SRC_ROOT = path.resolve(__dirname, '..', 'src');
  const read = (rel: string): string => fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');

  it('posts cache key is exactly `${user.id}:${accountId}:${limit}:${after}` (per-user, per-account, per-page)', () => {
    const src = read('app/api/instagram/posts/[accountId]/route.ts');
    expect(src).toContain('const cacheKey = `${user.id}:${accountId}:${limit}:${after ?? \'first\'}`;');
    // …and the ownership query precedes any cache read in the handler.
    expect(src.indexOf(".eq('user_id', user.id)")).toBeLessThan(src.indexOf('cache.get(cacheKey)'));
  });

  it('every [id]/[accountId] user route filters by user_id in source (IDOR inventory pin)', () => {
    const routes = [
      'app/api/automations/[id]/route.ts',
      'app/api/instagram/disconnect/[accountId]/route.ts',
      'app/api/instagram/posts/[accountId]/route.ts',
      'app/api/instagram/refresh/[accountId]/route.ts',
      'app/api/instagram/resubscribe/[accountId]/route.ts',
      'app/api/instagram/subscription-status/[accountId]/route.ts',
    ];
    for (const rel of routes) {
      expect(read(rel), rel).toContain(".eq('user_id', user.id)");
    }
  });

  it('resolveWorkspaceContext is consulted ONLY by the connect + callback routes among user-facing API routes (legacy routes use user_id scoping — transitional boundary)', () => {
    const apiRoot = path.join(SRC_ROOT, 'app', 'api');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'route.ts' && fs.readFileSync(full, 'utf8').includes('resolveWorkspaceContext')) {
          hits.push(path.relative(SRC_ROOT, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(apiRoot);
    expect(hits.sort()).toEqual([
      'app/api/instagram/callback/route.ts',
      'app/api/instagram/connect/route.ts',
    ]);
  });
});
