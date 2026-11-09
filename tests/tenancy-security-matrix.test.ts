/**
 * Phase E / Programme 16 — tenancy security matrix (REMAINING app-level
 * negative tests only).
 *
 * Coverage inventory — what was ALREADY proven before this file, and is
 * deliberately NOT duplicated here:
 *   - context resolution happy paths, role table, missing-workspace and
 *     non-member fail-closed, single-case DB-error and garbage-role
 *     rejection ............ tests/tenancy-context.test.ts (Phase B)
 *   - scopedDb tenant filter / stamp / cross-workspace-row guards
 *     ........................ tests/tenancy-scoped-db.test.ts (Phase C)
 *   - D1 wiring: job stamping from the account binding, processJob
 *     workspace-mismatch fail-closed (single-account fixtures), OAuth
 *     binding, settings fallback, debugLog column, posts cache per-user,
 *     AI attribution, webhook admission attribution
 *     ........................ tests/tenancy-integration.test.ts (Phase D1)
 *   - envelope encryption ... tests/crypto-envelope.test.ts (Phase D2)
 *   - storage policies ...... tests/card-images-storage.test.ts + the
 *                             disposable-PG rehearsals (Phases B/C/D)
 *   - platform/workspace role separation AND the audit-write-failure
 *     invariant (a failed audit write prevents the protected admin
 *     mutation: changePlan / bumpEntitlement / recordRefund)
 *     ........................ tests/billing-admin.test.ts (Phase 14) —
 *                             verified by running that file in Phase E,
 *                             NOT re-tested here (task §2.7).
 *   - inbound limiter: burst, duplicate, per-account shed isolation with
 *     distinct event ids, fail-open .... tests/inbound-rate-limit.test.ts
 *
 * What THIS file adds (genuinely missing guarantees):
 *   §1 Forged workspaceId fields ANYWHERE in a webhook body are ignored —
 *      processWebhook derives the stamp from the account row only, for
 *      both comment and DM paths, bound and unbound accounts.
 *   §2 Membership-resolution fail-closed EXTENSIONS: garbage-role value
 *      matrix, error+data simultaneously present, and a transport-level
 *      throw (the base cases live in tenancy-context.test.ts).
 *   §3 Platform-admin gate posture: env-shape variants (actor-only,
 *      inexact flag values) and independence from membership facts.
 *      (Service-level role separation lives in billing-admin.test.ts.)
 *   §4 IDOR at workspace granularity on real user routes: a workspace-B
 *      principal who is not the resource owner gets 404 / no data on
 *      workspace A's automation and Instagram account, with owner
 *      controls proving the routes work for the owner.
 *   §5 Self-escalation: NO app-layer code writes workspace_memberships —
 *      source-scan inventory in the style of signup-protection.test.ts.
 *      Membership writes exist only as the …000031 SECURITY DEFINER
 *      RPCs (database-side, rehearsed in Phase B).
 *   §6 Limiter scope integrity: the key is the verified IGSID only —
 *      identical event ids under two IGSIDs are independent, and a
 *      forged workspaceId field never becomes (or alters) the key.
 *   §7 Cross-tenant fault injection in processJob (STEP 3): automation↔
 *      account pair and session ownership. Two variants here are
 *      REGRESSION tests for holes found by Phase E probing and fixed
 *      minimally in src/lib/automation/processJob.ts (see §7 header).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt } from '@/lib/crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutoDmJobPayload, MetaWebhookBody } from '@/lib/types';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32); // 64 hex chars = 32-byte test key
const WS_A = 'workspace-A';
const WS_B = 'workspace-B';
const OWNER_A = 'user-owner-a';
const OWNER_B = 'user-owner-b';
const MEMBER_B = 'user-member-b'; // owner of workspace B, stranger to A

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
  subscribeToWebhookFields: vi.fn(async () => ({ ok: true })),
}));
vi.mock('next/server', () => ({
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

import { processWebhookPayload } from '@/lib/automation/processWebhook';
import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import {
  resolveWorkspaceContext,
  WorkspaceAccessError,
} from '@/lib/tenancy/context';
import { evaluatePlatformAdminGate } from '@/lib/admin/guard';
import {
  admitInboundWebhook,
  extractActionableEvents,
  type InboundEventStore,
} from '@/lib/automation/inboundRateLimit';
import { PUT as automationPUT, DELETE as automationDELETE } from '@/app/api/automations/[id]/route';
import { GET as postsGET } from '@/app/api/instagram/posts/[accountId]/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { sendInstagramDm, sendInstagramLinkButtonDm, sendInstagramCardDm, replyToComment } from '@/lib/instagram/api';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockSendDm = vi.mocked(sendInstagramDm);
const mockSendLink = vi.mocked(sendInstagramLinkButtonDm);
const mockSendCard = vi.mocked(sendInstagramCardDm);
const mockReply = vi.mocked(replyToComment);
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

/** Seed the full two-tenant world: A (acct-A/IG-A/WS_A) and B (acct-B/IG-B/WS_B). */
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
    automationRow({
      id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B',
      name: 'Automation B', dm_opening_message: 'Opening from B',
      dm_responses: [{ id: 'r1', type: 'text', content: 'Response from B' }],
    }),
  ]);
}

function jobPayload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: 'auto-A',
    instagramAccountId: 'acct-A',
    igAccountIgsid: 'IG-A',
    triggerType: 'comment',
    triggerUserId: 'IG-FAN',
    triggerUsername: 'fan',
    triggerEventId: 'cmt-1',
    triggerTimestamp: Date.now(),
    postId: 'post-1',
    commentText: 'LINK',
    messageText: null,
    ...overrides,
  };
}

function commentBody(igsid = 'IG-A', commentId = 'cmt-1'): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: igsid,
        time: nowSec,
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: 'IG-FAN', username: 'fan' },
              media: { id: 'post-1' },
              id: commentId,
              text: 'LINK',
              timestamp: nowSec,
            },
          },
        ],
      },
    ],
  };
}

function dmBody(igsid = 'IG-B', mid = 'mid-1'): MetaWebhookBody {
  return {
    object: 'instagram',
    entry: [
      {
        id: igsid,
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: 'IG-FAN' },
            recipient: { id: igsid },
            timestamp: Date.now(),
            message: { mid, text: 'LINK' },
          },
        ],
      },
    ],
  };
}

/** Sprinkle an attacker-supplied workspaceId at every level of the body. */
function injectForgedWorkspaceId(body: MetaWebhookBody, forged: string): MetaWebhookBody {
  (body as unknown as Record<string, unknown>)['workspaceId'] = forged;
  const entry = body.entry[0] as unknown as Record<string, unknown>;
  entry['workspaceId'] = forged;
  const change = body.entry[0]?.changes?.[0] as unknown as Record<string, unknown> | undefined;
  if (change) {
    change['workspaceId'] = forged;
    (change['value'] as Record<string, unknown>)['workspaceId'] = forged;
  }
  const messaging = body.entry[0]?.messaging?.[0] as unknown as Record<string, unknown> | undefined;
  if (messaging) messaging['workspaceId'] = forged;
  return body;
}

async function flushDebugLog(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

function expectNoSends(): void {
  expect(mockSendDm).not.toHaveBeenCalled();
  expect(mockSendLink).not.toHaveBeenCalled();
  expect(mockSendCard).not.toHaveBeenCalled();
  expect(mockReply).not.toHaveBeenCalled();
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
  afterCallbacks.length = 0;
  mockAuth.mockReset();
  mockSendDm.mockClear();
  mockSendLink.mockClear();
  mockSendCard.mockClear();
  mockReply.mockClear();
  // Collapse the human-like send jitter (timing only).
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

// ── §1. Forged workspace claims in webhook ingestion ───────────────────────

describe('§1 forged workspaceId in a webhook payload is ignored (account binding is the only source)', () => {
  it('comment event: forged WS_B at body/entry/change/value level still stamps the bound WS_A', async () => {
    seedTwoTenants();
    const enqueued = await processWebhookPayload(injectForgedWorkspaceId(commentBody('IG-A'), WS_B));
    expect(enqueued).toBe(1);
    const row = fake.rows('job_queue')[0]!;
    expect(row['workspace_id']).toBe(WS_A);
    expect((row['payload'] as AutoDmJobPayload).workspaceId).toBe(WS_A);
  });

  it('unbound account: a forged workspaceId does NOT create a stamp (payload stays legacy)', async () => {
    fake.replaceRows('instagram_accounts', [
      accountRow({ id: 'acct-U', instagram_user_id: 'IG-U', workspace_id: null }),
    ]);
    fake.replaceRows('automations', [automationRow({ id: 'auto-U', instagram_account_id: 'acct-U' })]);
    const enqueued = await processWebhookPayload(injectForgedWorkspaceId(commentBody('IG-U'), WS_A));
    expect(enqueued).toBe(1);
    const row = fake.rows('job_queue')[0]!;
    expect('workspace_id' in row).toBe(false);
    expect('workspaceId' in (row['payload'] as AutoDmJobPayload)).toBe(false);
  });

  it('DM event: forged WS_A on an IG-B delivery still stamps the bound WS_B', async () => {
    seedTwoTenants();
    fake.replaceRows('automations', [
      automationRow(),
      automationRow({
        id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B',
        name: 'Automation B', type: 'dm_reply',
      }),
    ]);
    const enqueued = await processWebhookPayload(injectForgedWorkspaceId(dmBody('IG-B'), WS_A));
    expect(enqueued).toBe(1);
    const row = fake.rows('job_queue')[0]!;
    expect(row['workspace_id']).toBe(WS_B);
    expect((row['payload'] as AutoDmJobPayload).workspaceId).toBe(WS_B);
  });
});

// ── §2. Membership-resolution fail-closed extensions ───────────────────────
// Base cases (single DB error, single 'superuser' role) are pinned in
// tenancy-context.test.ts; these are the variants it does not construct.

describe('§2 resolveWorkspaceContext fail-closed extensions', () => {
  const WS = 'ws-matrix';
  const USER = 'user-matrix';

  it('garbage-role matrix: null, empty, wrong-case, unknown and non-string roles all throw not-a-member', async () => {
    for (const role of [null, '', 'OWNER', 'super-admin', 42, { role: 'owner' }]) {
      fake.replaceRows('workspace_memberships', [{ workspace_id: WS, user_id: USER, role }]);
      await expect(resolveWorkspaceContext(db, USER, WS)).rejects.toMatchObject({
        name: 'WorkspaceAccessError',
        code: 'not-a-member',
      });
    }
  });

  it('error AND data returned together still throws (error wins over a well-formed row)', async () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({
        data: { workspace_id: WS, user_id: USER, role: 'owner' },
        error: { message: 'boom', code: 'XX000' },
      }),
    };
    const stub = { from: () => builder } as unknown as SupabaseClient;
    await expect(resolveWorkspaceContext(stub, USER, WS)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(resolveWorkspaceContext(stub, USER, WS)).rejects.toMatchObject({ code: 'not-a-member' });
  });

  it('a transport-level throw from the membership query never resolves a context', async () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => {
        throw new Error('connection reset');
      },
    };
    const stub = { from: () => builder } as unknown as SupabaseClient;
    await expect(resolveWorkspaceContext(stub, USER, WS)).rejects.toThrow('connection reset');
  });

  it('control: the same stub harness resolves a valid membership (harness is sound)', async () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({
        data: { workspace_id: WS, user_id: USER, role: 'admin' },
        error: null,
      }),
    };
    const stub = { from: () => builder } as unknown as SupabaseClient;
    await expect(resolveWorkspaceContext(stub, USER, WS)).resolves.toEqual({
      workspaceId: WS,
      userId: USER,
      role: 'admin',
    });
  });
});

// ── §3. Platform-admin gate posture ────────────────────────────────────────
// Service-level workspace/platform role separation is pinned in
// billing-admin.test.ts (Phase 14, invariant (a)); the gate's basic
// default-deny is pinned there too. These pin the env-shape variants and
// the gate's independence from membership facts.

describe('§3 evaluatePlatformAdminGate denies by default, for every near-miss env shape', () => {
  it('empty env and actor-id-only env both deny (no prototype env set = nobody passes)', () => {
    expect(evaluatePlatformAdminGate({})).toMatchObject({ allowed: false, actor: null });
    expect(evaluatePlatformAdminGate({ ADMIN_PROTOTYPE_ACTOR_ID: OWNER_A })).toMatchObject({
      allowed: false,
      actor: null,
    });
  });

  it("inexact flag values deny: 'TRUE', '1', 'yes' and ' true' are not the exact 'true' the stub requires", () => {
    for (const flag of ['TRUE', '1', 'yes', ' true']) {
      expect(
        evaluatePlatformAdminGate({ ADMIN_PROTOTYPE_PLATFORM_ADMIN: flag, ADMIN_PROTOTYPE_ACTOR_ID: 'staff-1' })
          .allowed,
        `flag=${JSON.stringify(flag)}`
      ).toBe(false);
    }
  });

  it('workspace-shaped env keys confer nothing, and a seeded workspace-owner membership does not leak into the gate', () => {
    fake.seed('workspace_memberships', [{ workspace_id: WS_B, user_id: MEMBER_B, role: 'owner' }]);
    // MEMBER_B is a workspace OWNER (of B) in the database. The gate reads
    // only its env argument — membership facts are never consulted.
    expect(
      evaluatePlatformAdminGate({
        ADMIN_PROTOTYPE_ACTOR_ID: MEMBER_B,
        WORKSPACE_ID: WS_B,
        WORKSPACE_ROLE: 'owner',
      })
    ).toMatchObject({ allowed: false, actor: null });
  });
});

// ── §4. IDOR on user routes at workspace granularity ───────────────────────
// The legacy routes scope by user_id (the workspace-era binding is the
// account's owner). MEMBER_B even OWNS workspace B — that standing must
// grant nothing on workspace A's resources.

describe('§4 IDOR: a workspace-B principal gets no data and no mutation on workspace A resources', () => {
  beforeEach(() => {
    seedTwoTenants();
    fake.seed('workspace_memberships', [
      { workspace_id: WS_A, user_id: OWNER_A, role: 'owner' },
      { workspace_id: WS_B, user_id: MEMBER_B, role: 'owner' },
    ]);
  });

  it('PUT /api/automations/[id]: B principal → 404 and A\u2019s automation is byte-identical afterwards', async () => {
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const before = { ...fake.rows('automations').find((r) => r['id'] === 'auto-A')! };
    const res = await automationPUT(
      new Request('https://app.opendm.in/api/automations/auto-A', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Hijacked by B', is_active: false }),
      }),
      { params: Promise.resolve({ id: 'auto-A' }) }
    );
    expect(res.status).toBe(404);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-A')).toEqual(before);
  });

  it('DELETE /api/automations/[id]: B principal → 404 and A\u2019s automation still exists', async () => {
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const res = await automationDELETE(new Request('https://app.opendm.in/api/automations/auto-A', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'auto-A' }),
    });
    expect(res.status).toBe(404);
    expect(fake.rows('automations').some((r) => r['id'] === 'auto-A')).toBe(true);
  });

  it('GET /api/instagram/posts/[accountId]: B principal → 404 and Meta is never called', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    mockAuth.mockResolvedValue({ id: MEMBER_B, email: 'b@example.com' });
    const res = await postsGET(new Request('https://app.opendm.in/api/instagram/posts/acct-A'), {
      params: Promise.resolve({ accountId: 'acct-A' }),
    });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('control — PUT as the owner succeeds, so the 404 above is tenancy, not a broken route', async () => {
    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const res = await automationPUT(
      new Request('https://app.opendm.in/api/automations/auto-A', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed by owner' }),
      }),
      { params: Promise.resolve({ id: 'auto-A' }) }
    );
    expect(res.status).toBe(200);
    expect(fake.rows('automations').find((r) => r['id'] === 'auto-A')!['name']).toBe('Renamed by owner');
  });

  it('control — GET posts as the owner succeeds and serves the account\u2019s media', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'post-A1', media_type: 'IMAGE',
                permalink: 'https://instagram.com/p/A1',
                timestamp: '2026-11-06T00:00:00Z', caption: 'A post',
              },
            ],
            paging: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    mockAuth.mockResolvedValue({ id: OWNER_A, email: 'a@example.com' });
    const res = await postsGET(new Request('https://app.opendm.in/api/instagram/posts/acct-A'), {
      params: Promise.resolve({ accountId: 'acct-A' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posts: Array<{ id: string }> };
    expect(body.posts[0]!.id).toBe('post-A1');
  });
});

// ── §5. Self-escalation: no app route writes workspace_memberships ─────────
// Legitimate membership writers, enumerated: ONLY the four SECURITY
// DEFINER RPCs of migration …000031 (create_workspace,
// accept_workspace_invitation, change_member_role, remove_member),
// which live database-side and were rehearsed against disposable
// PostgreSQL in Phase B. The app layer must contain no direct writer,
// and (Programme 18 Phase G reconciliation) no RPC caller outside the
// briefed src/app/api/workspaces/** routes.

describe('§5 no app-layer path writes workspace_memberships (self-escalation scan)', () => {
  const SRC_ROOT = path.resolve(__dirname, '..', 'src');
  const MIGRATION_31 = path.resolve(
    __dirname, '..', 'supabase', 'migrations', '20260730000031_workspace_membership_rpcs.sql'
  );
  const MEMBERSHIP_RPCS = ['create_workspace', 'accept_workspace_invitation', 'change_member_role', 'remove_member'];

  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectSourceFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const rel = (f: string): string => path.relative(SRC_ROOT, f).replace(/\\/g, '/');

  it('the complete .from(workspace_memberships) inventory is exactly the known SELECT readers', () => {
    const readers: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (/\.from\(\s*['"]workspace_memberships['"]\s*\)/.test(fs.readFileSync(file, 'utf8'))) {
        readers.push(rel(file));
      }
    }
    // Reconciliation (2026-11-09): lib/admin/panel.ts is a fourth
    // reader — the owner admin panel resolves each workspace's OWNER
    // membership to show the customer email. It is SELECT-only,
    // service-role, and runs only behind the panel's server-side
    // ADMIN_EMAILS gate (404 for everyone else; see
    // tests/admin-panel.test.ts). The self-escalation concern of §5
    // is writes; the no-mutation scan below still covers this file.
    // Reconciliation (2026-11-09, customer fixes A): two more
    // SELECT-only readers, both for the trial/workspace farming fix —
    // lib/entitlements/guard.ts (listOwnedWorkspaceIds /
    // countWorkspaceMembers feed the ENTITLEMENTS_ENFORCED gates)
    // and app/api/billing/trial/route.ts (the one-trial-per-user
    // check lists the caller's OWN owned workspaces). Neither writes;
    // the no-mutation scan below covers both.
    expect(readers.sort()).toEqual([
      'app/api/ai/generate/route.ts',
      'app/api/billing/trial/route.ts',
      'app/api/workspaces/[workspaceId]/members/route.ts',
      'lib/admin/panel.ts',
      'lib/entitlements/guard.ts',
      'lib/tenancy/context.ts',
    ]);
  });

  it('no source file chains a mutation (insert/update/upsert/delete) off the memberships table', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/\.from\(\s*['"]workspace_memberships['"]\s*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/.test(src)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file carries raw SQL that writes the memberships table', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?workspace_memberships/i.test(src)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('membership RPC call sites are confined to the briefed Phase G workspaces routes (none in src/lib/tenancy)', () => {
    const callers: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const rpc of MEMBERSHIP_RPCS) {
        if (new RegExp(`\\.rpc\\(\\s*['"]${rpc}['"]`).test(src)) callers.push(`${rel(file)} → ${rpc}`);
      }
    }
    // Phase G (Programme 18) legitimately added the four …000031 RPC
    // call sites under src/app/api/workspaces/** — the briefed routes.
    // Any other caller outside that tree (or src/lib/tenancy) fails.
    expect(
      callers.filter((c) => !c.startsWith('lib/tenancy/') && !c.startsWith('app/api/workspaces/'))
    ).toEqual([]);
    expect(callers.sort()).toEqual([
      'app/api/workspaces/[workspaceId]/members/[userId]/route.ts → change_member_role',
      'app/api/workspaces/[workspaceId]/members/[userId]/route.ts → remove_member',
      'app/api/workspaces/accept/route.ts → accept_workspace_invitation',
      'app/api/workspaces/route.ts → create_workspace',
    ]);
  });

  it('the ONLY membership writers are the …000031 SECURITY DEFINER RPCs (the enumerated service path exists)', () => {
    const sql = fs.readFileSync(MIGRATION_31, 'utf8');
    for (const rpc of MEMBERSHIP_RPCS) {
      expect(sql, rpc).toContain(`FUNCTION public.${rpc}`);
    }
    expect(sql).toContain('SECURITY DEFINER');
  });
});

// ── §6. Inbound limiter scope integrity ────────────────────────────────────
// The existing suite proves per-account shed isolation with DISTINCT
// event ids per account. These pin the key itself: composite
// (verified IGSID, eventKey), identical ids across accounts stay
// independent, and no payload field — workspaceId included — can
// become or alter the key.

describe('§6 inbound limiter key is the verified IGSID only', () => {
  interface StoreCall { igAccountId: string; eventKey: string }
  function makeStore(limitPerAccount: number): { store: InboundEventStore; calls: StoreCall[] } {
    const calls: StoreCall[] = [];
    const admitted = new Set<string>();
    const counts = new Map<string, number>();
    const store: InboundEventStore = {
      async checkAndRecord(input) {
        calls.push({ igAccountId: input.igAccountId, eventKey: input.eventKey });
        const composite = `${input.igAccountId}|${input.eventKey}`;
        if (admitted.has(composite)) {
          return { decision: 'duplicate' as const, windowCount: counts.get(input.igAccountId) ?? 0 };
        }
        const count = counts.get(input.igAccountId) ?? 0;
        if (count >= limitPerAccount) return { decision: 'shed' as const, windowCount: count };
        admitted.add(composite);
        counts.set(input.igAccountId, count + 1);
        return { decision: 'admitted' as const, windowCount: count + 1 };
      },
    };
    return { store, calls };
  }

  it('the SAME comment id under two IGSIDs is admitted independently (key is composite, not the event id alone)', async () => {
    const { store, calls } = makeStore(10);
    const a1 = await admitInboundWebhook(commentBody('IG-A', 'cmt-shared'), { store });
    const b1 = await admitInboundWebhook(commentBody('IG-B', 'cmt-shared'), { store });
    expect(a1.stats.admitted).toBe(1);
    expect(b1.stats.admitted).toBe(1); // NOT a duplicate of A's event
    expect(calls).toEqual([
      { igAccountId: 'IG-A', eventKey: 'comment:cmt-shared' },
      { igAccountId: 'IG-B', eventKey: 'comment:cmt-shared' },
    ]);
    // …while a genuine redelivery under the SAME IGSID still dedupes.
    const a2 = await admitInboundWebhook(commentBody('IG-A', 'cmt-shared'), { store });
    expect(a2.stats.duplicates).toBe(1);
    expect(a2.body).toBeNull();
  });

  it('a forged workspaceId in the body never becomes — or alters — the limiter key', async () => {
    const { store, calls } = makeStore(10);
    const forged = injectForgedWorkspaceId(commentBody('IG-B', 'cmt-forged'), WS_A);
    // Extraction keys solely off the verified entry id…
    expect(extractActionableEvents(forged).map((e) => e.igAccountId)).toEqual(['IG-B']);
    // …and admission consults the store under IG-B only.
    const result = await admitInboundWebhook(forged, { store });
    expect(result.stats.admitted).toBe(1);
    expect(calls).toEqual([{ igAccountId: 'IG-B', eventKey: 'comment:cmt-forged' }]);
    expect(JSON.stringify(calls)).not.toContain(WS_A);
    expect(JSON.stringify(calls)).not.toContain(WS_B);
  });

  it("account A at its limit with shared event ids does not shed account B's first event", async () => {
    const { store } = makeStore(2);
    const flood = await admitInboundWebhook(
      {
        object: 'instagram',
        entry: [
          {
            id: 'IG-A',
            time: Math.floor(Date.now() / 1000),
            changes: ['c1', 'c2', 'c3'].map((id) => ({
              field: 'comments',
              value: {
                from: { id: 'IG-FAN', username: 'fan' },
                media: { id: 'post-1' },
                id,
                text: 'LINK',
                timestamp: Math.floor(Date.now() / 1000),
              },
            })),
          },
        ],
      } as MetaWebhookBody,
      { store }
    );
    expect(flood.stats.admitted).toBe(2);
    expect(flood.stats.shed).toBe(1);
    // B's quota is untouched — even for 'c1', which A already admitted.
    const b = await admitInboundWebhook(commentBody('IG-B', 'c1'), { store });
    expect(b.stats.admitted).toBe(1);
    expect(b.stats.shed).toBe(0);
  });
});

// ── §7. Cross-tenant fault injection in processJob (STEP 3) ────────────────
// Phase E probing found two REAL holes here; both were fixed minimally
// in src/lib/automation/processJob.ts and the first three tests are
// their regressions:
//   HOLE 1 (processAutoDmJob): the payload's automationId and
//     instagramAccountId were never checked against each other. A job
//     naming A's account but B's automation SENT B's opening + responses
//     under A's token (DM triggers; comment triggers were backstopped
//     by the reservation RPC's pair check). Fix: fail-closed pair check
//     after the automation load → job 'skipped', tenant_context_mismatch.
//   HOLE 2 (processFollowUpDmJob): the session row was never checked
//     against the payload. A job for A carrying B's session SENT A's
//     content and marked B's session completed. Fix: fail-closed pair
//     check on (session.automation_id, session.instagram_account_id)
//     before any session mutation → foreign session dropped untouched.
//   The scheduled follow-up processor had the same missing pair check;
//   it is pinned by the fourth fault test (fix: instagram_account_id
//   added to its automation select + identical pair check; the foreign
//   follow-up row is deliberately NOT mutated).
// D1 already covered payload-workspace-vs-account-binding mismatch on
// single-account fixtures; the forged-claim test below is the
// two-workspace variant (B's own job + B's own session, claiming A).

describe('§7 processJob cross-tenant fault injection', () => {
  function sessionRow(overrides: FakeRow = {}): FakeRow {
    return {
      id: 'sess-B',
      automation_id: 'auto-B',
      instagram_account_id: 'acct-B',
      audience_ig_user_id: 'IG-FAN',
      current_step: 1,
      completed: false,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    };
  }

  it('REGRESSION hole 1: auto_dm job naming acct-A but auto-B (workspace omitted) sends nothing and is skipped', async () => {
    seedTwoTenants();
    await processAutoDmJob(jobPayload({ automationId: 'auto-B', triggerType: 'dm', messageText: 'LINK', commentText: null }), 1);
    expectNoSends();
    const job = fake.rows('dm_jobs')[0]!;
    expect(job['status']).toBe('skipped');
    expect(job['error_message']).toContain('automation does not belong to payload account');
    await flushDebugLog();
    expect(fake.rows('debug_events').some((r) => r['event_type'] === 'tenant_context_mismatch')).toBe(true);
  });

  it('REGRESSION hole 1 (comment path): pair check fires even when the workspace claim MATCHES the payload account', async () => {
    seedTwoTenants();
    await processAutoDmJob(jobPayload({ automationId: 'auto-B', workspaceId: WS_A }), 1);
    expectNoSends();
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
    // The pair check precedes the reservation: no reservation was taken
    // against B's automation / A's account pair either.
    expect(fake.rows('comment_private_reply_reservations')).toHaveLength(0);
  });

  it("REGRESSION hole 2: follow-up job for A carrying B's session sends nothing and leaves B's session byte-identical", async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({ triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1 })
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
    expect(fake.rows('dm_logs')).toHaveLength(0);
    await flushDebugLog();
    expect(fake.rows('debug_events').some((r) => r['event_type'] === 'tenant_context_mismatch')).toBe(true);
  });

  it('scheduled follow-up: payload account A + automation B is skipped, sends nothing, and B\u2019s follow-up row stays scheduled', async () => {
    seedTwoTenants();
    fake.replaceRows('automations', [
      automationRow(),
      automationRow({
        id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B', name: 'Automation B',
        follow_up_enabled: true, follow_up_message: 'B follow-up text',
      }),
    ]);
    fake.seed('automation_follow_ups', [
      {
        id: 'fu-B', automation_id: 'auto-B', instagram_account_id: 'acct-B',
        recipient_id: 'IG-FAN', qualified_event_id: 'evt-1', status: 'scheduled',
        message_snapshot: 'B follow-up text',
      },
    ]);
    await processFollowUpDmJob(
      jobPayload({
        automationId: 'auto-B',
        triggerType: 'dm_reply_followup', isFollowUp: true, isScheduledFollowUp: true,
        sessionStep: 99, followUpText: 'B follow-up text', triggerEventId: 'scheduled_evt-1',
      })
    );
    expectNoSends();
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('scheduled');
  });

  it("forged workspace claim on B's OWN follow-up job (two-workspace variant): no send, B's session untouched", async () => {
    seedTwoTenants();
    fake.seed('automation_sessions', [sessionRow()]);
    const before = { ...fake.rows('automation_sessions')[0]! };
    await processFollowUpDmJob(
      jobPayload({
        automationId: 'auto-B', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B',
        triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1,
        workspaceId: WS_A, // forged: B's account is bound to WS_B
      })
    );
    expectNoSends();
    expect(fake.rows('automation_sessions')[0]).toEqual(before);
  });

  it("control: B's own follow-up job with B's true workspace still delivers and completes B's session", async () => {
    seedTwoTenants();
    fake.replaceRows('automations', [
      automationRow(),
      automationRow({
        id: 'auto-B', user_id: OWNER_B, instagram_account_id: 'acct-B', name: 'Automation B',
        dm_responses: [{ id: 'r1', type: 'text', content: 'Response from B' }],
      }),
    ]);
    fake.seed('automation_sessions', [sessionRow()]);
    await processFollowUpDmJob(
      jobPayload({
        automationId: 'auto-B', instagramAccountId: 'acct-B', igAccountIgsid: 'IG-B',
        triggerType: 'dm_reply_followup', isFollowUp: true, sessionId: 'sess-B', sessionStep: 1,
        workspaceId: WS_B,
      })
    );
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(true);
  });
});
