/**
 * Phase 10.3 E2E (Area 1) — auth / owner gating as ONE cross-route journey.
 *
 * Route-level pieces already exist separately — tests/ai-generate-route
 * .test.ts (F-4 gate per status) and tests/setup-route.test.ts (setup
 * guard + redaction). This file EXTENDS them into the staging Area 13
 * shape: the SAME three actors (owner / non-owner / anonymous, plus the
 * unconfigured-owner world) are driven across BOTH owner-gated surfaces
 * (/api/ai/generate and /api/setup GET+POST) with one shared owner
 * configuration, proving the gate is consistent everywhere it applies —
 * a route that disagreed with the others would fail here even if its
 * own unit file passed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeSupabase } from '../helpers/fakeSupabase';

const fake = new FakeSupabase();

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/settings', () => ({
  getMetaSettings: vi.fn(async () => ({
    metaAppId: '123456789012',
    metaAppSecret: 'synthetic-secret',
    metaFbAppSecret: null,
    webhookVerifyToken: 'live-verify-token-synthetic',
    setupCompleted: true,
  })),
  saveMetaSettings: vi.fn(async () => {}),
}));
vi.mock('@/lib/env', () => ({
  getAppUrl: () => 'https://app.opendm.in',
  getEnv: () => ({}),
  getDashboardLink: () => ({ href: '/', label: 'x' }),
}));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import { POST as aiGeneratePOST } from '@/app/api/ai/generate/route';
import { GET as setupGET, POST as setupPOST } from '@/app/api/setup/route';
import { saveMetaSettings } from '@/lib/settings';

const OWNER = { id: 'owner-user-id', email: 'owner@example.com' };
const OTHER = { id: 'other-user-id', email: 'other@example.com' };
const ENV_KEYS = ['OWNER_USER_ID', 'OWNER_EMAIL'] as const;
let savedEnv: Record<string, string | undefined> = {};

const mockSaveSettings = vi.mocked(saveMetaSettings);

function aiRequest(): Request {
  return new Request('http://localhost/api/ai/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'response_draft', prompt: 'Explain the program' }),
  });
}
function setupPostRequest(): Request {
  return new Request('https://app.opendm.in/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metaAppId: '123456789012', metaAppSecret: 'a'.repeat(32) }),
  });
}
function setupGetRequest(): Request {
  return new Request('https://app.opendm.in/api/setup');
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env['OWNER_USER_ID'] = OWNER.id;
  mockGetAuthenticatedUser.mockReset();
  mockSaveSettings.mockClear();
  fake.calls.length = 0;
  fake.replaceRows('app_settings', [
    { id: 1, meta_app_id: '123456789012', webhook_verify_token: 'live-verify-token-synthetic', setup_completed: true },
  ]);
  fake.replaceRows('ai_usage_log', []);
  delete (globalThis as any).__WORKERS_AI_BINDING;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete (globalThis as any).__WORKERS_AI_BINDING;
});

describe('one owner configuration, consistent across both gated surfaces', () => {
  it('OWNER: 200 on /api/ai/generate, full token on GET /api/setup, 200 on POST /api/setup', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    expect((await aiGeneratePOST(aiRequest())).status).toBe(200);

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const getRes = await setupGET(setupGetRequest());
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { webhookVerifyToken: string | null }).webhookVerifyToken).toBe(
      'live-verify-token-synthetic'
    );

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    expect((await setupPOST(setupPostRequest())).status).toBe(200);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it('NON-OWNER: 403 on /api/ai/generate, token REDACTED on GET /api/setup, 403 + no write on POST /api/setup', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(OTHER);
    expect((await aiGeneratePOST(aiRequest())).status).toBe(403);

    mockGetAuthenticatedUser.mockResolvedValue(OTHER);
    const getRes = await setupGET(setupGetRequest());
    const body = (await getRes.json()) as { webhookVerifyToken: string | null; metaAppId: string | null };
    expect(body.webhookVerifyToken).toBeNull();
    expect(body.metaAppId).toBe('123456789012'); // non-secret fields stay visible

    mockGetAuthenticatedUser.mockResolvedValue(OTHER);
    expect((await setupPOST(setupPostRequest())).status).toBe(403);
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(fake.rows('ai_usage_log')).toHaveLength(0); // a refused drafting call logs nothing
  });

  it('ANONYMOUS: 401 on every gated surface', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    expect((await aiGeneratePOST(aiRequest())).status).toBe(401);
    mockGetAuthenticatedUser.mockResolvedValue(null);
    expect((await setupGET(setupGetRequest())).status).toBe(401);
    mockGetAuthenticatedUser.mockResolvedValue(null);
    expect((await setupPOST(setupPostRequest())).status).toBe(401);
  });

  it('UNCONFIGURED owner (no OWNER_* env): fail-closed 403 for EVERYONE on both write surfaces, owner included', async () => {
    delete process.env['OWNER_USER_ID'];
    delete process.env['OWNER_EMAIL'];

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    expect((await aiGeneratePOST(aiRequest())).status).toBe(403);

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    expect((await setupPOST(setupPostRequest())).status).toBe(403);
    expect(mockSaveSettings).not.toHaveBeenCalled();

    // …and the verify token is redacted even for the would-be owner,
    // because with no owner configured nobody may see it post-setup.
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    const getRes = await setupGET(setupGetRequest());
    expect(((await getRes.json()) as { webhookVerifyToken: string | null }).webhookVerifyToken).toBeNull();
  });

  it('OWNER_EMAIL fallback grants the same cross-surface access (case-insensitive) when no ID is set', async () => {
    delete process.env['OWNER_USER_ID'];
    process.env['OWNER_EMAIL'] = 'Owner@Example.COM';

    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    expect((await aiGeneratePOST(aiRequest())).status).toBe(200);
    mockGetAuthenticatedUser.mockResolvedValue(OWNER);
    expect((await setupPOST(setupPostRequest())).status).toBe(200);
  });
});
