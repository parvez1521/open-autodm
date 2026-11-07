/**
 * Phase D1 / Programme 16 — tenancy integration (server paths).
 *
 * Wires the Phase B/C tenancy primitives through the real server paths
 * against the FakeSupabase harness:
 *   - job payloads carry the account's workspace binding (processWebhook,
 *     followUps, queue row column);
 *   - processJob fails closed on a payload/binding mismatch and adopts
 *     the server-resolved workspace when the payload carries none;
 *   - debugLog persists metadata.workspaceId into the workspace_id column;
 *   - settings prefer platform_config and fall back to app_settings on
 *     ANY platform read failure / absence;
 *   - OAuth state round-trips an optional workspaceId (legacy tokens
 *     unaffected); connect verifies owner/admin; callback re-verifies,
 *     binds + maps, and rejects foreign-workspace accounts;
 *   - the posts-route cache is separated per authenticated user;
 *   - AI drafting usage is attributed only on exactly-one membership;
 *   - the webhook route attributes admission rows to their workspace.
 *
 * The debug logger is the REAL one (service client = the fake), so
 * debug_events assertions cover the column extraction end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';
import { encrypt, decrypt, hmacSha256Hex } from '@/lib/crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutoDmJobPayload, MetaWebhookBody } from '@/lib/types';
import {
  createFetchGuard,
  createOAuthFetchRouter,
  stubFetchGuard,
  type FetchGuard,
} from './e2e/helpers/harness';

const fake = new FakeSupabase();
const TOKEN_KEY = 'ab'.repeat(32); // 64 hex chars = 32-byte test key
const WS1 = 'workspace-1';
const WS2 = 'workspace-2';
const OWNER_ID = 'user-owner';
const CALLER_ID = 'user-caller';

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
import { enqueueJob } from '@/lib/automation/queue';
import { scheduleFollowUpMessage } from '@/lib/automation/followUps';
import { processAutoDmJob, processFollowUpDmJob } from '@/lib/automation/processJob';
import { debugLog } from '@/lib/debugLog';
import { signOAuthState, verifyOAuthState } from '@/lib/instagram/oauth';
import { getMetaSettings, invalidateSettingsCache } from '@/lib/settings';
import { GET as connectGET } from '@/app/api/instagram/connect/route';
import { GET as callbackGET } from '@/app/api/instagram/callback/route';
import { GET as postsGET } from '@/app/api/instagram/posts/[accountId]/route';
import { POST as aiGeneratePOST } from '@/app/api/ai/generate/route';
import { POST as webhookPOST } from '@/app/api/webhook/route';
import { getAuthenticatedUser } from '@/lib/auth';
import { sendInstagramDm, subscribeToWebhookFields } from '@/lib/instagram/api';

const mockAuth = vi.mocked(getAuthenticatedUser);
const mockSendDm = vi.mocked(sendInstagramDm);
const mockSubscribe = vi.mocked(subscribeToWebhookFields);
const db = fake as unknown as SupabaseClient;

const realSetTimeout = globalThis.setTimeout;
let timeoutSpy: ReturnType<typeof vi.spyOn> | null = null;
let guard: FetchGuard | null = null;
let routerCalls: string[] = [];

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
    id: 'acct-1',
    user_id: OWNER_ID,
    instagram_user_id: 'IG-OWNER',
    username: 'creator',
    is_active: true,
    access_token_encrypted: encrypt('test-access-token', TOKEN_KEY),
    paused_until: null,
    pause_reason: null,
    traffic_guard_paused: false,
    workspace_id: WS1,
    ...overrides,
  };
}

function automationRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'auto-1',
    user_id: OWNER_ID,
    instagram_account_id: 'acct-1',
    name: 'Synthetic automation',
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
    dm_opening_message: 'Here is your guide',
    dm_opening_message_button_title: null,
    dm_opening_message_button_link: null,
    ask_to_follow_enabled: false,
    ask_to_follow_message: '',
    ask_to_follow_visit_profile_button: '',
    ask_to_follow_confirm_button: '',
    dm_responses: [],
    follow_up_enabled: false,
    follow_up_delay_minutes: 60,
    follow_up_message: '',
    is_traffic_guard_paused: false,
    total_dms_sent: 0,
    ...overrides,
  };
}

function payload(overrides: Partial<AutoDmJobPayload> = {}): AutoDmJobPayload {
  return {
    automationId: 'auto-1',
    instagramAccountId: 'acct-1',
    igAccountIgsid: 'IG-OWNER',
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

function commentBody(text = 'LINK'): MetaWebhookBody {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: 'IG-OWNER',
        time: nowSec,
        changes: [
          {
            field: 'comments',
            value: {
              from: { id: 'IG-FAN', username: 'fan' },
              media: { id: 'post-1' },
              id: 'cmt-1',
              text,
              timestamp: nowSec,
            },
          },
        ],
      },
    ],
  };
}

function seedAppSettings(appId = 'app-123', secret = 'app-secret-xyz'): void {
  fake.seed('app_settings', [
    {
      id: 1,
      meta_app_id: appId,
      meta_app_secret_encrypted: encrypt(secret, TOKEN_KEY),
      meta_fb_app_secret_encrypted: null,
      webhook_verify_token: 'verify-token',
      setup_completed: true,
    },
  ]);
}

function seedPlatformConfig(appId = 'platform-456', secret = 'platform-secret-xyz'): void {
  fake.seed('platform_config', [
    {
      id: 1,
      meta_app_id: appId,
      meta_app_secret_encrypted: encrypt(secret, TOKEN_KEY),
      meta_fb_app_secret_encrypted: null,
      webhook_verify_token: 'verify-token',
      setup_completed: true,
      secret_key_version: 1,
    },
  ]);
}

async function flushDebugLog(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  for (const t of TABLES) fake.replaceRows(t, []);
  afterCallbacks.length = 0;
  mockAuth.mockReset();
  mockSendDm.mockClear();
  mockSubscribe.mockClear();
  invalidateSettingsCache();
  delete process.env['OWNER_USER_ID'];
  delete process.env['OWNER_EMAIL'];
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
  guard = null;
  routerCalls = [];
});

// ── 1a. Queue row stamping ─────────────────────────────────────────────────

describe('enqueueJob workspace stamping', () => {
  it('stamps the job_queue row workspace_id column from the payload', async () => {
    const id = await enqueueJob('auto_dm', payload({ workspaceId: WS1 }), 'dedupe-ws');
    expect(id).toBeTruthy();
    const row = fake.rows('job_queue')[0]!;
    expect(row['workspace_id']).toBe(WS1);
    expect((row['payload'] as AutoDmJobPayload).workspaceId).toBe(WS1);
  });

  it('leaves the insert in the legacy shape when the payload has no workspace', async () => {
    await enqueueJob('auto_dm', payload(), 'dedupe-legacy');
    const row = fake.rows('job_queue')[0]!;
    expect('workspace_id' in row).toBe(false);
  });
});

// ── 1b. Webhook payload stamping ───────────────────────────────────────────

describe('processWebhookPayload workspace stamping', () => {
  it('stamps payload + queue row from a bound account', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow()]);
    const enqueued = await processWebhookPayload(commentBody());
    expect(enqueued).toBe(1);
    const row = fake.rows('job_queue')[0]!;
    expect(row['workspace_id']).toBe(WS1);
    expect((row['payload'] as AutoDmJobPayload).workspaceId).toBe(WS1);
  });

  it('unbound account: payload and queue row stay in the legacy shape', async () => {
    fake.replaceRows('instagram_accounts', [accountRow({ workspace_id: null })]);
    fake.replaceRows('automations', [automationRow()]);
    const enqueued = await processWebhookPayload(commentBody());
    expect(enqueued).toBe(1);
    const row = fake.rows('job_queue')[0]!;
    expect('workspace_id' in row).toBe(false);
    expect('workspaceId' in (row['payload'] as AutoDmJobPayload)).toBe(false);
  });
});

// ── 1c. Follow-up payload stamping ─────────────────────────────────────────

describe('scheduleFollowUpMessage workspace stamping', () => {
  it('derives the workspace from the parent account and stamps the job', async () => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    const ok = await scheduleFollowUpMessage(db, {
      automationId: 'auto-1',
      instagramAccountId: 'acct-1',
      igAccountIgsid: 'IG-OWNER',
      recipientId: 'IG-FAN',
      qualifiedEventId: 'evt-1',
      qualifiedTimestamp: Date.now(),
      delayMinutes: 60,
      message: 'Checking in!',
    });
    expect(ok).toBe(true);
    const row = fake.rows('job_queue')[0]!;
    expect(row['workspace_id']).toBe(WS1);
    expect((row['payload'] as AutoDmJobPayload).workspaceId).toBe(WS1);
  });

  it('unresolvable account: leaves the follow-up payload unstamped', async () => {
    const ok = await scheduleFollowUpMessage(db, {
      automationId: 'auto-1',
      instagramAccountId: 'acct-missing',
      igAccountIgsid: 'IG-OWNER',
      recipientId: 'IG-FAN',
      qualifiedEventId: 'evt-1',
      qualifiedTimestamp: Date.now(),
      delayMinutes: 60,
      message: 'Checking in!',
    });
    expect(ok).toBe(true);
    const row = fake.rows('job_queue')[0]!;
    expect('workspace_id' in row).toBe(false);
  });
});

// ── 1d. processJob validation ──────────────────────────────────────────────

describe('processJob tenant validation', () => {
  beforeEach(() => {
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow()]);
  });

  it('mismatch: fails closed — no send, job skipped, mismatch logged with workspace column', async () => {
    await processAutoDmJob(payload({ workspaceId: WS2 }), 1);
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('dm_sent_log')).toHaveLength(0);
    const jobRow = fake.rows('dm_jobs')[0]!;
    expect(jobRow['status']).toBe('skipped');
    await flushDebugLog();
    const mismatch = fake
      .rows('debug_events')
      .find((r) => r['event_type'] === 'tenant_context_mismatch');
    expect(mismatch).toBeTruthy();
    expect(mismatch!['workspace_id']).toBe(WS2);
  });

  it('adopts the server-resolved workspace when the payload carries none', async () => {
    const p = payload();
    await processAutoDmJob(p, 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(p.workspaceId).toBe(WS1);
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('sent');
  });

  it('a payload matching the binding processes normally', async () => {
    const p = payload({ workspaceId: WS1 });
    await processAutoDmJob(p, 1);
    expect(mockSendDm).toHaveBeenCalledTimes(1);
    expect(p.workspaceId).toBe(WS1);
  });

  it('follow-up mismatch: dropped before any session work or send', async () => {
    fake.seed('automation_sessions', [
      {
        id: 'sess-1',
        automation_id: 'auto-1',
        instagram_account_id: 'acct-1',
        audience_ig_user_id: 'IG-FAN',
        current_step: 1,
        completed: false,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ]);
    await processFollowUpDmJob(
      payload({
        triggerType: 'dm_reply_followup',
        isFollowUp: true,
        sessionId: 'sess-1',
        sessionStep: 1,
        workspaceId: WS2,
      })
    );
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('automation_sessions')[0]!['completed']).toBe(false);
    await flushDebugLog();
    expect(
      fake.rows('debug_events').some((r) => r['event_type'] === 'tenant_context_mismatch')
    ).toBe(true);
  });

  it('scheduled follow-up mismatch: row + job skipped, no send', async () => {
    fake.seed('automation_follow_ups', [
      {
        id: 'fu-1',
        automation_id: 'auto-1',
        instagram_account_id: 'acct-1',
        recipient_id: 'IG-FAN',
        qualified_event_id: 'evt-1',
        status: 'scheduled',
        message_snapshot: 'Checking in!',
      },
    ]);
    fake.replaceRows('automations', [
      automationRow({ follow_up_enabled: true, follow_up_message: 'Checking in!' }),
    ]);
    await processFollowUpDmJob(
      payload({
        triggerType: 'dm_reply_followup',
        isFollowUp: true,
        sessionStep: 99,
        isScheduledFollowUp: true,
        followUpText: 'Checking in!',
        triggerEventId: 'scheduled_evt-1',
        workspaceId: WS2,
      })
    );
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(fake.rows('automation_follow_ups')[0]!['status']).toBe('skipped');
    expect(fake.rows('dm_jobs')[0]!['status']).toBe('skipped');
  });
});

// ── 3. debugLog workspace column ───────────────────────────────────────────

describe('debugLog workspace_id extraction', () => {
  it('writes metadata.workspaceId into the workspace_id column', async () => {
    debugLog('worker', 'info', 'ws_scoped_event', 'ok', 'scoped', {
      userId: OWNER_ID,
      workspaceId: WS1,
    });
    await flushDebugLog();
    const row = fake.rows('debug_events')[0]!;
    expect(row['workspace_id']).toBe(WS1);
    expect(row['user_id']).toBe(OWNER_ID);
  });

  it('callers without a workspace insert no workspace_id key', async () => {
    debugLog('worker', 'info', 'plain_event', 'ok', 'plain', { userId: OWNER_ID });
    await flushDebugLog();
    const row = fake.rows('debug_events')[0]!;
    expect('workspace_id' in row).toBe(false);
  });
});

// ── 6. Settings platform split ─────────────────────────────────────────────

describe('getMetaSettings platform_config split', () => {
  it('platform_config row present → its value is used', async () => {
    seedAppSettings();
    seedPlatformConfig();
    const settings = await getMetaSettings();
    expect(settings?.metaAppId).toBe('platform-456');
    expect(settings?.metaAppSecret).toBe('platform-secret-xyz');
  });

  it('platform_config read error → app_settings value is used', async () => {
    seedAppSettings();
    seedPlatformConfig();
    fake.failNextQuery('platform_config', { message: 'boom', code: 'XX000' });
    const settings = await getMetaSettings();
    expect(settings?.metaAppId).toBe('app-123');
    expect(settings?.metaAppSecret).toBe('app-secret-xyz');
  });

  it('platform_config absent → app_settings value is used', async () => {
    seedAppSettings();
    const settings = await getMetaSettings();
    expect(settings?.metaAppId).toBe('app-123');
  });
});

// ── 5a. OAuth state round-trip ─────────────────────────────────────────────

describe('OAuth state workspace claim', () => {
  it('round-trips a workspaceId', async () => {
    const token = await signOAuthState(CALLER_ID, WS1);
    await expect(verifyOAuthState(token)).resolves.toEqual({
      userId: CALLER_ID,
      workspaceId: WS1,
    });
  });

  it('legacy tokens without a workspaceId still verify, with none returned', async () => {
    const token = await signOAuthState(CALLER_ID);
    const result = await verifyOAuthState(token);
    expect(result.userId).toBe(CALLER_ID);
    expect(result.workspaceId).toBeUndefined();
  });
});

// ── 5b. Connect route ──────────────────────────────────────────────────────

describe('GET /api/instagram/connect workspace gate', () => {
  beforeEach(() => {
    seedAppSettings();
    mockAuth.mockResolvedValue({ id: CALLER_ID, email: 'caller@example.com' });
  });

  it('owner of the workspace: issued state carries the workspaceId', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: CALLER_ID, role: 'owner' },
    ]);
    const res = await connectGET(
      new Request(`https://app.opendm.in/api/instagram/connect?workspace=${WS1}`)
    );
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    await expect(verifyOAuthState(state)).resolves.toEqual({
      userId: CALLER_ID,
      workspaceId: WS1,
    });
  });

  it('non-member: fails closed with an instagram_error redirect, no URL issued', async () => {
    const res = await connectGET(
      new Request(`https://app.opendm.in/api/instagram/connect?workspace=${WS1}`)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('instagram_error=workspace_not_authorized');
  });

  it('member (not owner/admin): fails closed the same way', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: CALLER_ID, role: 'member' },
    ]);
    const res = await connectGET(
      new Request(`https://app.opendm.in/api/instagram/connect?workspace=${WS1}`)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('instagram_error=workspace_not_authorized');
  });

  it('no workspace param: legacy flow, state carries no workspaceId', async () => {
    const res = await connectGET(new Request('https://app.opendm.in/api/instagram/connect'));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const verified = await verifyOAuthState(state);
    expect(verified.userId).toBe(CALLER_ID);
    expect(verified.workspaceId).toBeUndefined();
  });
});

// ── 5c. Callback route workspace binding ───────────────────────────────────

describe('GET /api/instagram/callback workspace binding', () => {
  beforeEach(() => {
    seedAppSettings();
    // State JWTs are signed/verified through the REAL oauth module (its
    // secret derives from this file's mocked getEnv key, 'ab'*32 — the
    // same key the seeded settings encrypt with and assertions decrypt
    // with). Only the Meta network boundary is stubbed, via the harness
    // OAuth router.
    const { router, calls } = createOAuthFetchRouter();
    routerCalls = calls;
    guard = createFetchGuard(router);
    stubFetchGuard(guard);
  });

  async function callbackRequest(workspaceId?: string): Promise<Request> {
    const state = await signOAuthState(CALLER_ID, workspaceId);
    return new Request(
      `https://app.opendm.in/api/instagram/callback?code=auth-code&state=${state}`
    );
  }

  it('workspace state: writes the binding + the mapping row', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: CALLER_ID, role: 'owner' },
    ]);
    const res = await callbackGET(await callbackRequest(WS1));
    expect(res.headers.get('location')).toContain('instagram_connected=true');
    const account = fake.rows('instagram_accounts')[0]!;
    expect(account['workspace_id']).toBe(WS1);
    expect(account['connected_by_user_id']).toBe(CALLER_ID);
    const mappings = fake.rows('workspace_instagram_accounts');
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!['workspace_id']).toBe(WS1);
    expect(mappings[0]!['instagram_account_id']).toBe(account['id']);
    expect(mappings[0]!['connected_by']).toBe(CALLER_ID);
  });

  it('account bound to a DIFFERENT workspace: rejected like a foreign owner, nothing written', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: CALLER_ID, role: 'owner' },
    ]);
    fake.seed('instagram_accounts', [
      {
        id: 'row-bound-elsewhere',
        user_id: CALLER_ID,
        instagram_user_id: 'IG-E2E-NEW',
        username: 'e2e_new_creator',
        workspace_id: WS2,
        access_token_encrypted: 'old-token-value',
      },
    ]);
    const res = await callbackGET(await callbackRequest(WS1));
    expect(res.headers.get('location')).toContain('instagram_error=account_already_connected');
    const account = fake.rows('instagram_accounts')[0]!;
    expect(account['workspace_id']).toBe(WS2);
    expect(account['access_token_encrypted']).toBe('old-token-value');
    expect(fake.rows('workspace_instagram_accounts')).toHaveLength(0);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('account bound to the SAME workspace: refreshes in place, mapping stays single', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: CALLER_ID, role: 'admin' },
    ]);
    fake.seed('instagram_accounts', [
      {
        id: 'row-bound-here',
        user_id: CALLER_ID,
        instagram_user_id: 'IG-E2E-NEW',
        username: 'old-name',
        workspace_id: WS1,
        access_token_encrypted: 'stale-value',
      },
    ]);
    fake.seed('workspace_instagram_accounts', [
      { workspace_id: WS1, instagram_account_id: 'row-bound-here', connected_by: CALLER_ID },
    ]);
    const res = await callbackGET(await callbackRequest(WS1));
    expect(res.headers.get('location')).toContain('instagram_connected=true');
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
    expect(fake.rows('workspace_instagram_accounts')).toHaveLength(1);
    const account = fake.rows('instagram_accounts')[0]!;
    expect(account['workspace_id']).toBe(WS1);
    // Token rotated by the real exchange (harness long-lived token). The
    // stored value is encrypted under the mocked env key.
    expect(decrypt(account['access_token_encrypted'] as string, TOKEN_KEY)).toBe(
      'synthetic-long-lived-token'
    );
  });

  it('membership re-verified at callback time: a mere member is rejected before any token exchange', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: CALLER_ID, role: 'member' },
    ]);
    const res = await callbackGET(await callbackRequest(WS1));
    expect(res.headers.get('location')).toContain('instagram_error=workspace_not_authorized');
    expect(routerCalls).toHaveLength(0);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
  });
});

// ── 4. Posts-route cache separation ────────────────────────────────────────

describe('posts route per-user cache', () => {
  it('two users asking for the same account id never share a cached page', async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCount += 1;
        const n = fetchCount;
        return new Response(
          JSON.stringify({
            data: [
              {
                id: `post-${n}`,
                media_type: 'IMAGE',
                permalink: `https://instagram.com/p/${n}`,
                timestamp: '2026-11-06T00:00:00Z',
                caption: `caption ${n}`,
              },
            ],
            paging: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );

    const accountFor = (userId: string): FakeRow => ({
      id: 'acct-posts',
      user_id: userId,
      instagram_user_id: 'IG-POSTS',
      access_token_encrypted: encrypt('posts-token', TOKEN_KEY),
      is_active: true,
    });
    const ctx = { params: Promise.resolve({ accountId: 'acct-posts' }) };

    fake.replaceRows('instagram_accounts', [accountFor('user-a')]);
    mockAuth.mockResolvedValue({ id: 'user-a', email: 'a@example.com' });
    const resA = await postsGET(
      new Request('https://app.opendm.in/api/instagram/posts/acct-posts'),
      ctx
    );
    const bodyA = (await resA.json()) as { posts: Array<{ id: string }> };
    expect(bodyA.posts[0]!.id).toBe('post-1');

    // The same account id now presented by a different authenticated user
    // (ownership row re-pointed): the cache must NOT serve user A's page.
    fake.replaceRows('instagram_accounts', [accountFor('user-b')]);
    mockAuth.mockResolvedValue({ id: 'user-b', email: 'b@example.com' });
    const resB = await postsGET(
      new Request('https://app.opendm.in/api/instagram/posts/acct-posts'),
      ctx
    );
    const bodyB = (await resB.json()) as { posts: Array<{ id: string }>; cached?: boolean };
    expect(bodyB.posts[0]!.id).toBe('post-2');
    expect(bodyB.cached).toBe(false);
    expect(fetchCount).toBe(2);
  });
});

// ── 8. AI drafting attribution ─────────────────────────────────────────────

describe('AI generate workspace attribution (B9)', () => {
  beforeEach(() => {
    process.env['OWNER_USER_ID'] = OWNER_ID;
    mockAuth.mockResolvedValue({ id: OWNER_ID, email: 'owner@example.com' });
  });

  function aiRequest(): Request {
    return new Request('http://localhost/api/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'opening_variations', prompt: 'Say hi', count: 3 }),
    });
  }

  it('exactly one membership → the usage row carries workspace_id', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: OWNER_ID, role: 'owner' },
    ]);
    const res = await aiGeneratePOST(aiRequest());
    expect(res.status).toBe(200);
    const rows = fake.rows('ai_usage_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['workspace_id']).toBe(WS1);
  });

  it('multiple memberships → attribution left off the row', async () => {
    fake.seed('workspace_memberships', [
      { workspace_id: WS1, user_id: OWNER_ID, role: 'owner' },
      { workspace_id: WS2, user_id: OWNER_ID, role: 'admin' },
    ]);
    const res = await aiGeneratePOST(aiRequest());
    expect(res.status).toBe(200);
    const rows = fake.rows('ai_usage_log');
    expect(rows).toHaveLength(1);
    expect('workspace_id' in rows[0]!).toBe(false);
  });

  it('zero memberships → attribution left off, request unaffected', async () => {
    const res = await aiGeneratePOST(aiRequest());
    expect(res.status).toBe(200);
    const rows = fake.rows('ai_usage_log');
    expect(rows).toHaveLength(1);
    expect('workspace_id' in rows[0]!).toBe(false);
  });
});

// ── 2. Webhook route admission attribution ─────────────────────────────────

describe('POST /api/webhook admission workspace attribution', () => {
  it('attributes the admission rows of a bound account to its workspace', async () => {
    seedAppSettings('app-123', 'app-secret-xyz');
    invalidateSettingsCache();
    fake.replaceRows('instagram_accounts', [accountRow()]);
    fake.replaceRows('automations', [automationRow()]);
    fake.seed('inbound_webhook_events', [
      { ig_account_id: 'IG-OWNER', event_key: 'comment:cmt-1', decision: 'admitted' },
    ]);

    const body = JSON.stringify(commentBody());
    const signature = `sha256=${hmacSha256Hex('app-secret-xyz', Buffer.from(body, 'utf8'))}`;
    const res = await webhookPOST(
      new Request('https://app.opendm.in/api/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body,
      })
    );
    expect(res.status).toBe(200);
    for (const fn of afterCallbacks.splice(0)) await fn();

    const admissionRow = fake.rows('inbound_webhook_events')[0]!;
    expect(admissionRow['workspace_id']).toBe(WS1);
    // And the downstream job is stamped end-to-end.
    const jobRow = fake.rows('job_queue')[0]!;
    expect(jobRow['workspace_id']).toBe(WS1);
    await flushDebugLog();
    expect(
      fake
        .rows('debug_events')
        .some((r) => r['event_type'] === 'webhook_workspace_attribution' && r['workspace_id'] === WS1)
    ).toBe(true);
  });
});
