/**
 * Area 10 (limiter surface) — the REAL, unmocked processJob module exports:
 * DM_LIMIT_PER_HOUR and the RateLimitDelay / AccountOnPause control-flow
 * error classes the engine branches on.
 *
 * PARTIAL COVERAGE, stated plainly: the limiter decision itself
 * (checkRateLimit → check_and_record_dm_rate_limit Postgres RPC) is not
 * exported and runs inside Postgres, so it cannot be unit-tested without a
 * database. What CAN be pinned here: the 180/hr constant the RPC is called
 * with, and the exact shape of the delay signal the engine consumes.
 */

import { describe, it, expect } from 'vitest';
import { DM_LIMIT_PER_HOUR, RateLimitDelay, AccountOnPause } from '@/lib/automation/processJob';

describe('DM rate limiter surface (real processJob module)', () => {
  it('caps DMs at 180/hour per account (Meta hard limit 200, 20-DM safety buffer)', () => {
    expect(DM_LIMIT_PER_HOUR).toBe(180);
  });

  it('RateLimitDelay carries the retry-after and the observed count', () => {
    const err = new RateLimitDelay(1_800_000, 180);
    expect(err).toBeInstanceOf(Error);
    expect(err.retryAfterMs).toBe(1_800_000);
    expect(err.currentCount).toBe(180);
    expect(err.message).toContain('180/180');
  });

  it('AccountOnPause carries the resume timestamp', () => {
    const resumeAt = Date.now() + 3_600_000;
    const err = new AccountOnPause(resumeAt);
    expect(err).toBeInstanceOf(Error);
    expect(err.resumeAtMs).toBe(resumeAt);
  });
});
