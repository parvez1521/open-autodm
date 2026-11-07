/**
 * Creator Studio — Openverse per-instance daily cap (Programme S3;
 * renamed by Programme 34, the Iteration-10 terminology correction).
 *
 * Provider-side fact: the Openverse anonymous tier allows 200
 * requests/day against ONE shared account pool (not per user). The
 * route guards that pool with this counter — cap 180 leaves headroom
 * under the provider's 200 — but the counter itself is IN-MEMORY
 * STATE IN ONE SERVER PROCESS: it is a PER-INSTANCE guard, not a
 * deployment-wide cap. On a multi-instance deployment each instance
 * counts separately, so the effective ceiling multiplies by the
 * instance count; nothing here enforces the provider pool globally.
 * (The helper previously carried a "global" name, which invited
 * exactly that misreading; Programme 34 renamed it.) Counters
 * reset on process restart and at the UTC-day boundary, exactly
 * like the per-user
 * limiter in groq.ts. The factory takes an injected clock so the
 * UTC-day reset is testable. A shared store is the hosted-tier fix —
 * noted, not built.
 */

export function createPerInstanceDailyCap(deps: { cap: number; now?: () => number }) {
  const cap = Math.max(1, Math.floor(deps.cap));
  const now = deps.now ?? Date.now;
  let dayKey = "";
  let count = 0;

  function currentDayKey(at: number): string {
    return new Date(at).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  }

  function roll(at: number): void {
    const key = currentDayKey(at);
    if (key !== dayKey) {
      dayKey = key;
      count = 0;
    }
  }

  return {
    /** True when a request is still allowed today (this instance); false at the cap. */
    check(): boolean {
      roll(now());
      return count < cap;
    },
    /** Count one attempt against today's per-instance total. */
    record(): void {
      const at = now();
      roll(at);
      count += 1;
    },
  };
}
