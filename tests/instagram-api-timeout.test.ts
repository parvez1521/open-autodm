/**
 * Instagram Graph API timeouts (2026-11-28).
 *
 * Live incident: IG comment-DM jobs hung silently on the Cloudflare
 * Worker after job_started — a plain fetch with no timeout never
 * settles, so the invocation is eventually reaped with the job stranded
 * in 'processing' and no error event anywhere. Every Meta fetch in
 * src/lib/instagram/api.ts now runs under META_API_TIMEOUT_MS via
 * metaFetch; a wedged call must reject with MetaApiTimeoutError (a
 * plain Error, so the engine retries it as transient before any send
 * and fails it closed after one) instead of hanging.
 *
 * The fetch stubs below are faithful to real fetch (undici/workerd):
 * they reject with an AbortError when the passed signal aborts. A stub
 * that ignored the signal would never settle at all — that is the bug,
 * not the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import {
  META_API_TIMEOUT_MS,
  sendInstagramDm,
  sendInstagramLinkButtonDm,
  sendInstagramCardDm,
  sendAskToFollowDm,
  replyToComment,
  getAudienceProfile,
} from '@/lib/instagram/api';
import { MetaApiError, MetaApiTimeoutError } from '@/lib/instagram/errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fetch that never resolves on its own but rejects with AbortError
 * the moment its signal aborts — exactly what undici/workerd do.
 */
function neverResolvingFetch(_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // No signal: never settles (defensive; metaFetch always passes one).
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted.', 'AbortError')),
      { once: true }
    );
  });
}

/** Resolves successfully, but only after `delayMs` (fake-timer time) — unless aborted first, like real fetch. */
function slowFetch(delayMs: number): (input: unknown, init?: { signal?: AbortSignal }) => Promise<Response> {
  return async (_input: unknown, init?: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true }
      );
    });
    return jsonResponse({ recipient_id: 'USER', message_id: 'mid_late' });
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function expectTimeout<T>(promise: Promise<T>, context: string): Promise<void> {
  // Capture the settlement directly: Vitest's `.rejects` assertion
  // resolves to the assertion object, not the thrown error.
  let caught: unknown = 'NO_SETTLEMENT';
  const done = promise.then(
    () => {
      caught = 'RESOLVED';
    },
    (err: unknown) => {
      caught = err;
    }
  );
  // Drive the META_API_TIMEOUT_MS timer to completion; the abort fires,
  // the stub rejects, and metaFetch translates it to MetaApiTimeoutError.
  await vi.advanceTimersByTimeAsync(META_API_TIMEOUT_MS);
  await done;
  expect(caught).toBeInstanceOf(MetaApiTimeoutError);
  expect((caught as MetaApiTimeoutError).timeoutMs).toBe(META_API_TIMEOUT_MS);
  expect((caught as MetaApiTimeoutError).context).toBe(context);
  // NOT a MetaApiError: the engine must treat it as a transient retry,
  // not a Meta-side refusal.
  expect(caught).not.toBeInstanceOf(MetaApiError);
}

describe('Meta Graph API timeout (META_API_TIMEOUT_MS)', () => {
  it('sendInstagramDm rejects with MetaApiTimeoutError when the call never settles', async () => {
    vi.stubGlobal('fetch', neverResolvingFetch);
    await expectTimeout(
      sendInstagramDm('IGSID', { id: 'USER' }, 'hello', 'TOKEN'),
      'sendInstagramDm'
    );
  });

  it('sendInstagramLinkButtonDm rejects with MetaApiTimeoutError when the call never settles', async () => {
    vi.stubGlobal('fetch', neverResolvingFetch);
    await expectTimeout(
      sendInstagramLinkButtonDm('IGSID', { id: 'USER' }, 'hello', 'Open', 'https://example.com', 'TOKEN'),
      'sendInstagramLinkButtonDm'
    );
  });

  it('sendInstagramCardDm rejects with MetaApiTimeoutError when the call never settles', async () => {
    vi.stubGlobal('fetch', neverResolvingFetch);
    await expectTimeout(
      sendInstagramCardDm('IGSID', 'USER', 'TOKEN', { title: 'Card' }),
      'sendInstagramCardDm'
    );
  });

  it('sendAskToFollowDm rejects with MetaApiTimeoutError when the call never settles', async () => {
    vi.stubGlobal('fetch', neverResolvingFetch);
    await expectTimeout(
      sendAskToFollowDm('IGSID', 'USER', 'TOKEN', {
        message: 'Follow us',
        creatorUsername: 'creator',
        visitProfileButtonTitle: 'Visit',
        confirmButtonTitle: 'Done',
        confirmPayload: 'SESSION_x_STEP_2',
      }),
      'sendAskToFollowDm'
    );
  });

  it('replyToComment rejects with MetaApiTimeoutError when the call never settles (timeouts are NOT swallowed)', async () => {
    // replyToComment swallows HTTP errors internally, but a thrown
    // network-level failure must propagate (see processJob step 7) —
    // a timeout is a thrown failure, not an HTTP error.
    vi.stubGlobal('fetch', neverResolvingFetch);
    await expectTimeout(replyToComment('COMMENT', 'thanks!', 'TOKEN'), 'replyToComment');
  });

  it('getAudienceProfile resolves null (fail-open) when the call never settles', async () => {
    vi.stubGlobal('fetch', neverResolvingFetch);
    const promise = getAudienceProfile('USER', 'TOKEN');
    await vi.advanceTimersByTimeAsync(META_API_TIMEOUT_MS);
    await expect(promise).resolves.toBeNull();
  });

  it('a call that answers after the timeout still rejects (the late response must not win)', async () => {
    vi.stubGlobal('fetch', slowFetch(META_API_TIMEOUT_MS + 5_000));
    await expectTimeout(
      sendInstagramDm('IGSID', { id: 'USER' }, 'hello', 'TOKEN'),
      'sendInstagramDm'
    );
  });

  it('a healthy call still succeeds (the timeout does not fire early)', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ recipient_id: 'USER', message_id: 'mid_1' })
    );
    const messageId = await sendInstagramDm('IGSID', { id: 'USER' }, 'hello', 'TOKEN');
    expect(messageId).toBe('mid_1');
  });
});
