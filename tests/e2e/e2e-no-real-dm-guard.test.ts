/**
 * Phase 10.3 E2E — the no-real-DM guarantee (harness self-test).
 *
 * Imports the REAL Meta layer (src/lib/instagram/api.ts + oauth.ts, NO
 * module mock) with global fetch replaced by the harness guard. Every
 * outbound function must be intercepted: a send can never resolve with
 * a message_id, and every attempt must be visible in guard.metaAttempts.
 * If a future code path adds a new Meta call that bypasses the guard,
 * this file fails instead of the harness silently leaking a real DM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFetchGuard,
  stubFetchGuard,
  jsonResponse,
  MetaBlockedError,
  type FetchGuard,
} from './helpers/harness';

import {
  sendInstagramDm,
  sendInstagramLinkButtonDm,
  replyToComment,
  getAudienceProfile,
} from '@/lib/instagram/api';
import { exchangeCodeForToken, getInstagramProfile } from '@/lib/instagram/oauth';

let guard: FetchGuard;

beforeEach(() => {
  guard = createFetchGuard();
  stubFetchGuard(guard);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetch guard intercepts 100% of the real Meta layer', () => {
  it('sendInstagramDm is blocked before any network: rejects, no message_id, attempt recorded', async () => {
    await expect(
      sendInstagramDm('IG-E2E-OWNER', { commentId: 'cmt-e2e-1' }, 'hello', 'synthetic-token')
    ).rejects.toBeInstanceOf(MetaBlockedError);
    expect(guard.metaAttempts).toHaveLength(1);
    expect(guard.metaAttempts[0]).toContain('graph.instagram.com');
    expect(guard.metaAttempts[0]).toContain('/messages');
  });

  it('sendInstagramLinkButtonDm is blocked the same way', async () => {
    await expect(
      sendInstagramLinkButtonDm(
        'IG-E2E-OWNER',
        { id: 'IG-E2E-FAN' },
        'hello',
        'Open link',
        'https://example.invalid/x',
        'synthetic-token'
      )
    ).rejects.toBeInstanceOf(MetaBlockedError);
    expect(guard.metaAttempts).toHaveLength(1);
  });

  it('replyToComment (public reply) is blocked — a real public reply is equally impossible', async () => {
    await expect(replyToComment('cmt-e2e-1', 'public hello', 'synthetic-token')).rejects.toBeInstanceOf(
      MetaBlockedError
    );
    expect(guard.metaAttempts[0]).toContain('/replies');
  });

  it('getAudienceProfile fails safe (null) but the attempt is still intercepted and recorded', async () => {
    // The profile helper deliberately fails OPEN (returns null on error)
    // in production code. The guard proves even this quiet path cannot
    // reach Meta unmocked: the attempt is recorded before the null.
    const profile = await getAudienceProfile('IG-E2E-FAN', 'synthetic-token');
    expect(profile).toBeNull();
    expect(guard.metaAttempts).toHaveLength(1);
    expect(guard.metaAttempts[0]).toContain('IG-E2E-FAN');
  });

  it('OAuth token exchange (api.instagram.com) is blocked', async () => {
    await expect(
      exchangeCodeForToken('synthetic-code', 'app-id', 'app-secret', 'https://app.opendm.in/api/instagram/callback')
    ).rejects.toBeInstanceOf(MetaBlockedError);
    expect(guard.metaAttempts[0]).toContain('api.instagram.com/oauth/access_token');
  });

  it('profile fetch (graph.instagram.com/me) is blocked', async () => {
    await expect(getInstagramProfile('synthetic-token')).rejects.toBeInstanceOf(MetaBlockedError);
    expect(guard.metaAttempts[0]).toContain('graph.instagram.com/me');
  });

  it('graph.facebook.com is blocked too (a future FB-graph path cannot slip past)', async () => {
    await expect(
      (globalThis.fetch as (u: string) => Promise<Response>)('https://graph.facebook.com/v23.0/me')
    ).rejects.toBeInstanceOf(MetaBlockedError);
    expect(guard.metaAttempts).toHaveLength(1);
  });

  it('repeated send attempts are ALL blocked — the counter equals the attempts, deliveries stay zero', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        sendInstagramDm('IG-E2E-OWNER', { id: 'IG-E2E-FAN' }, `attempt ${i}`, 'synthetic-token')
      ).rejects.toBeInstanceOf(MetaBlockedError);
    }
    expect(guard.metaAttempts).toHaveLength(3);
  });
});

describe('the guard is host-scoped, not a blanket fetch ban', () => {
  it('a routed Meta URL returns the router synthetic response (still no network)', async () => {
    const routed = createFetchGuard((url) =>
      url.includes('/messages') ? jsonResponse({ recipient_id: 'IG-E2E-FAN', message_id: 'mock-msg-1' }) : null
    );
    stubFetchGuard(routed);
    const res = await (globalThis.fetch as (u: string, i?: unknown) => Promise<Response>)(
      'https://graph.instagram.com/v23.0/IG-E2E-OWNER/messages',
      { method: 'POST' }
    );
    expect(res.ok).toBe(true);
    expect(((await res.json()) as { message_id: string }).message_id).toBe('mock-msg-1');
    expect(routed.metaAttempts).toHaveLength(1);
  });

  it('a non-Meta URL with an explicit fallback handler is served by the fallback', async () => {
    const withFallback = createFetchGuard(undefined, async () => jsonResponse({ ok: true }));
    stubFetchGuard(withFallback);
    const res = await (globalThis.fetch as (u: string) => Promise<Response>)('https://example.invalid/health');
    expect(res.ok).toBe(true);
    expect(withFallback.metaAttempts).toHaveLength(0);
  });

  it('a non-Meta URL with NO fallback is blocked as unmocked (nothing leaves the harness by default)', async () => {
    await expect(
      (globalThis.fetch as (u: string) => Promise<Response>)('https://example.invalid/health')
    ).rejects.toThrow('unmocked non-Meta fetch');
  });
});
