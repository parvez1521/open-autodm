/**
 * Cron drain cap (2026-11-28).
 *
 * Cloudflare Workers free plan allows 50 subrequests per invocation.
 * A full-featured IG comment job costs ~27 subrequests, so the old
 * `processDueJobs(25)` in the cron route could burst past the limit
 * (an FB job logged 'Too many subrequests' from a 5-job drain,
 * 2026-11-27) and strand jobs mid-flight. The route now drains at
 * most CRON_DRAIN_MAX_JOBS (= 1) per drain call — the same cap as the
 * webhook inline drain (WEBHOOK_INLINE_DRAIN_MAX_JOBS, commit
 * 16dd06d).
 *
 * These tests drive the REAL route code with the downstream drain
 * mocked and assert the limit passed to processDueJobs for both the
 * main drain and the follow-up drain.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const SECRET = 'test-cron-secret-0123456789abcdef';

const envState = vi.hoisted(() => ({ secret: null as string | null }));
const sweepState = vi.hoisted(() => ({ requeued: 0 }));

vi.mock('@/lib/env', () => ({
  getEnv: () => {
    if (envState.secret === null) {
      throw new Error(
        '[open-autoDM] Invalid or missing environment variables:\n' +
          '  - CRON_SECRET: CRON_SECRET must be at least 16 characters'
      );
    }
    return { CRON_SECRET: envState.secret, TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) };
  },
}));

vi.mock('@/lib/automation/engine', () => ({
  processDueJobs: vi.fn(async () => ({ claimed: 0, done: 0, rescheduled: 0, failed: 0, held: 0 })),
}));
vi.mock('@/lib/trafficGuard/tracker', () => ({ evaluateOpenIncidents: vi.fn(async () => 0) }));
vi.mock('@/lib/automation/followUps', () => ({
  sweepDueFollowUps: vi.fn(async () => sweepState.requeued),
}));
vi.mock('@/lib/instagram/oauth', () => ({ refreshLongLivedToken: vi.fn() }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

const dbStub = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'lt']) chain[m] = () => chain;
  chain['then'] = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
    resolve({ data: [], error: null });
  return {
    from: () => chain,
    rpc: async () => ({ data: null, error: null }),
  };
});
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => dbStub }));

import { GET } from '@/app/api/cron/process-jobs/route';
import { processDueJobs } from '@/lib/automation/engine';

const mockDrain = vi.mocked(processDueJobs);
const BASE = 'https://app.opendm.in/api/cron/process-jobs';

function req(): Request {
  return new Request(BASE, {
    method: 'GET',
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

beforeEach(() => {
  envState.secret = SECRET;
  sweepState.requeued = 0;
  mockDrain.mockClear();
});

describe('GET /api/cron/process-jobs drain cap', () => {
  // The cap lives as a module-private constant in the route (route
  // modules cannot export extra values), so tests assert the literal.
  const CAP = 1;

  it('main drain is capped at 1 when no follow-ups were requeued', async () => {
    sweepState.requeued = 0;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockDrain).toHaveBeenCalledTimes(1);
    expect(mockDrain).toHaveBeenCalledWith(CAP);
  });

  it('both drains are capped at 1 when follow-ups were requeued', async () => {
    sweepState.requeued = 3;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockDrain).toHaveBeenCalledTimes(2);
    expect(mockDrain).toHaveBeenNthCalledWith(1, CAP);
    expect(mockDrain).toHaveBeenNthCalledWith(2, CAP);
  });

  it('the follow-up drain does not run when nothing was requeued', async () => {
    sweepState.requeued = 0;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockDrain).toHaveBeenCalledTimes(1);
  });

  it('the follow-up drain does not run when the main drain already claimed a job', async () => {
    // At most 1 job per cron invocation: a second drain on the same
    // tick would land at ~50-57 subrequests (1 auto_dm ≈ 27 + 1
    // follow-up ≈ 15-20 + overhead ≈ 8-10), right at or over the 50
    // limit. The requeued follow-ups wait for the next tick.
    sweepState.requeued = 3;
    mockDrain.mockResolvedValueOnce({ claimed: 1, done: 1, rescheduled: 0, failed: 0, held: 0 });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockDrain).toHaveBeenCalledTimes(1);
    expect(mockDrain).toHaveBeenCalledWith(CAP);
  });

  it('the cap is 1: a single invocation must stay under the 50-subrequest free-plan limit', () => {
    // One full-featured IG comment job costs ~27 subrequests; the
    // cron invocation itself adds overhead (token refresh, Traffic
    // Guard, follow-up sweep, cleanup). 1 job ≈ 35-37 (under 50);
    // 2 jobs ≈ 62-64 (over).
    expect(CAP).toBe(1);
  });
});
