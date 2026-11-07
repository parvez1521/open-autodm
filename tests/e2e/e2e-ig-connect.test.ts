/**
 * Phase 10.3 E2E (Area 2) — Instagram connect + token persistence.
 *
 * DEEPER than tests/oauth-callback.test.ts: that suite mocks the OAuth
 * module itself. Here the REAL callback route, REAL oauth.ts (code →
 * short-lived → long-lived exchange, profile fetch) and REAL api.ts
 * webhook-subscription call all run — only the network is replaced, at
 * the global-fetch boundary, by the harness OAuth router serving
 * synthetic tokens. The guard throws on any Meta URL the router does
 * not recognise, so the journey provably touches only mocked endpoints.
 *
 * Token persistence is verified through the REAL AES-256-GCM crypto
 * layer under a SYNTHETIC key: the stored value must be ciphertext
 * (iv:ciphertext:tag) that decrypts back to the synthetic long-lived
 * token, and must never contain the plaintext token.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT } from 'jose';
import { FakeSupabase } from '../helpers/fakeSupabase';
import { decrypt } from '@/lib/crypto';
import {
  createFetchGuard,
  createOAuthFetchRouter,
  stubFetchGuard,
  type FetchGuard,
} from './helpers/harness';
import { E2E_TOKEN_KEY } from './fixtures/payloads';

const fake = new FakeSupabase();
const CALLER_ID = 'user-e2e-caller';
const NEW_IG_ID = 'IG-E2E-NEW';

vi.mock('@/lib/settings', () => ({
  getMetaSettings: async () => ({
    metaAppId: '1586956306036999',
    metaAppSecret: 'synthetic-app-secret',
    metaFbAppSecret: null,
    webhookVerifyToken: 'synthetic-verify-token',
    setupCompleted: true,
  }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/env', () => ({
  getAppUrl: () => 'https://app.opendm.in',
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: E2E_TOKEN_KEY }),
  getDashboardLink: () => ({ href: '/', label: 'x' }),
}));

import { GET } from '@/app/api/instagram/callback/route';

let guard: FetchGuard;
let routerCalls: string[];
let restoreJitter: (() => void) | null = null;

async function signState(userId: string, secret = E2E_TOKEN_KEY): Promise<string> {
  const key = new TextEncoder().encode(`state:${secret}`);
  return new SignJWT({ userId, nonce: 'e2e-nonce' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
}

async function callbackRequest(userId: string): Promise<Request> {
  const state = await signState(userId);
  return new Request(
    `https://app.opendm.in/api/instagram/callback?code=synthetic-auth-code&state=${state}`
  );
}

function installRouter(options: { failTokenExchange?: boolean } = {}): void {
  const { router, calls } = createOAuthFetchRouter(options);
  routerCalls = calls;
  guard = createFetchGuard(router);
  stubFetchGuard(guard);
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', []);
  fake.replaceRows('profiles', []);
  installRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreJitter?.();
  restoreJitter = null;
});

describe('connect journey — real OAuth code over the mocked Meta boundary', () => {
  it('first-time connect: exchanges code → long-lived token, stores it ENCRYPTED, subscribes webhooks', async () => {
    const res = await GET(await callbackRequest(CALLER_ID));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('instagram_connected=true');

    // Exactly one account row, owned by the caller.
    expect(fake.callsFor('instagram_accounts', 'insert')).toHaveLength(1);
    const row = fake.rows('instagram_accounts')[0]!;
    expect(row['user_id']).toBe(CALLER_ID);
    expect(row['instagram_user_id']).toBe(NEW_IG_ID);
    expect(row['username']).toBe('e2e_new_creator');

    // Encrypted at rest: iv:ciphertext:tag format, no plaintext leakage,
    // and it round-trips through the real crypto layer with the synthetic key.
    const stored = row['access_token_encrypted'] as string;
    expect(stored.split(':')).toHaveLength(3);
    expect(stored).not.toContain('synthetic-long-lived-token');
    expect(decrypt(stored, E2E_TOKEN_KEY)).toBe('synthetic-long-lived-token');

    // The journey touched ONLY the four mocked Meta endpoints, in order:
    // token exchange, long-lived exchange, profile, webhook subscription.
    expect(routerCalls.some((u) => u.includes('api.instagram.com/oauth/access_token'))).toBe(true);
    expect(routerCalls.some((u) => u.includes('graph.instagram.com/access_token'))).toBe(true);
    expect(routerCalls.some((u) => u.includes('graph.instagram.com/me'))).toBe(true);
    const subscribeCalls = routerCalls.filter((u) => u.includes('/subscribed_apps'));
    expect(subscribeCalls).toHaveLength(1);
    expect(guard.metaAttempts.every((u) => routerCalls.includes(u))).toBe(true);
  });

  it('foreign-owned account: connect is refused with ZERO writes and NO webhook subscription', async () => {
    fake.seed('instagram_accounts', [
      { id: 'row-foreign', user_id: 'someone-else', instagram_user_id: NEW_IG_ID, username: 'e2e_new_creator' },
    ]);
    const res = await GET(await callbackRequest(CALLER_ID));
    expect(res.headers.get('location')).toContain('instagram_error=account_already_connected');
    expect(fake.callsFor('instagram_accounts', 'insert')).toHaveLength(0);
    expect(fake.callsFor('instagram_accounts', 'update')).toHaveLength(0);
    expect(fake.callsFor('profiles')).toHaveLength(0);
    expect(routerCalls.filter((u) => u.includes('/subscribed_apps'))).toHaveLength(0);
    expect(fake.rows('instagram_accounts')[0]!['user_id']).toBe('someone-else');
  });

  it('same-owner reconnect: token rotates in place — still one row, new ciphertext decrypts to the new token', async () => {
    fake.seed('instagram_accounts', [
      {
        id: 'row-own',
        user_id: CALLER_ID,
        instagram_user_id: NEW_IG_ID,
        username: 'old-name',
        access_token_encrypted: 'stale-value',
      },
    ]);
    const res = await GET(await callbackRequest(CALLER_ID));
    expect(res.headers.get('location')).toContain('instagram_connected=true');
    expect(fake.callsFor('instagram_accounts', 'insert')).toHaveLength(0);
    expect(fake.callsFor('instagram_accounts', 'update')).toHaveLength(1);
    expect(fake.rows('instagram_accounts')).toHaveLength(1);
    const row = fake.rows('instagram_accounts')[0]!;
    expect(decrypt(row['access_token_encrypted'] as string, E2E_TOKEN_KEY)).toBe(
      'synthetic-long-lived-token'
    );
  });

  it('token-exchange failure at Meta: redirect carries server_error and NOTHING is persisted', async () => {
    installRouter({ failTokenExchange: true });
    const res = await GET(await callbackRequest(CALLER_ID));
    expect(res.headers.get('location')).toContain('instagram_error=server_error');
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
    expect(fake.callsFor('instagram_accounts', 'insert')).toHaveLength(0);
    expect(fake.callsFor('instagram_accounts', 'update')).toHaveLength(0);
  });

  it('forged state JWT (wrong secret): rejected as state_mismatch BEFORE any token call or write', async () => {
    const forged = await signState(CALLER_ID, 'ff'.repeat(32));
    const res = await GET(
      new Request(`https://app.opendm.in/api/instagram/callback?code=synthetic-auth-code&state=${forged}`)
    );
    expect(res.headers.get('location')).toContain('instagram_error=state_mismatch');
    expect(routerCalls).toHaveLength(0);
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
  });
});
