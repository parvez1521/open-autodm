/**
 * Programme 29 — save-outcome reconciliation (the Iteration-6
 * correction of the Programme 28 cleanup rule).
 *
 * ChatGPT's Iteration-6 review REJECTED the P28 rule as specified:
 * P28 treated EVERY `ApiError` (any HTTP error response from the
 * automation save) as a DEFINITE failure and deleted the attempt's
 * uploaded card images. An HTTP error — above all a 5xx — does not
 * prove the save did not commit: a commit can precede a gateway or
 * post-write 5xx, and a lost response hides the outcome entirely.
 * Deleting on an unproven non-commit can delete images a committed
 * record references.
 *
 * Programme 29 established the route truth from the handlers
 * (saas/PHASE_29_SAVE_OUTCOME_RECONCILIATION.md §1) and narrowed the
 * decision: cleanup runs ONLY on verified non-commit — pre-request
 * failures, the fail-closed WorkspaceAccessError, and ApiError
 * statuses in 400–499 (every 4xx return point in POST
 * /api/automations and PUT /api/automations/[id], both branches,
 * precedes persistence or reports a no-row read). ApiError 5xx and
 * transport failures are AMBIGUOUS: deletion is skipped and the
 * reconciliation read-back runs instead.
 *
 * PROGRAMME 31 CORRECTION (dated note, per ChatGPT's Iteration-7
 * P0): the 400–499 range claim above was REJECTED — the handlers
 * demonstrably emit only {400, 401, 403, 404} before persistence,
 * and the range also blessed statuses the routes never emit (409,
 * 422) and 499, an intermediary/client-close status that proves
 * nothing about origin commit. The predicate is now the explicit
 * allowlist {400, 401, 403, 404}; the pins that blessed 409/422/499
 * in this file are INVERTED below (ambiguous ⇒ skip + reconcile).
 * Evidence: saas/PHASE_31_PROVEN_RESPONSE_CLASSIFICATION_CORRECTION.md.
 *
 * These tests pin, at unit tier (no network, no real storage):
 *   1. The full decision matrix of shouldCleanUpAfterFailedSave,
 *      including the two named ambiguous scenarios (commit-then-500,
 *      lost response).
 *   2. reconcileAmbiguousSaveOutcome: referenced / not-referenced /
 *      inconclusive semantics over injected seams — and that the
 *      read-back can only ever VETO a deletion, never enable one
 *      (it returns an outcome record; it performs no deletion).
 *   3. Source pins: both mutation call sites route the ambiguous
 *      branch to the reconciliation, and the decision helper keys
 *      ApiError on the proven-status predicate.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn() }));
// The provider is a .tsx component module; the vitest config has no
// JSX transform (node env, no React plugin — codebase convention), so
// it is mocked out, mirroring tests/p28-classifier-and-cleanup.test.ts.
vi.mock('@/components/workspace/WorkspaceProvider', () => ({ useWorkspace: vi.fn() }));

import { ApiError } from '@/lib/api/client';
import {
  isProvenNonCommitApiStatus,
  reconcileAmbiguousSaveOutcome,
  shouldCleanUpAfterFailedSave,
} from '@/hooks/useAutomations';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

describe('isProvenNonCommitApiStatus — the route-proven allowlist (P29 §1, narrowed by P31)', () => {
  it('exactly the statuses the save routes demonstrably emit before persistence are proven non-commit', () => {
    // 400 invalid JSON / Zod / flow-graph / missing selector;
    // 401 auth; 403 ownership / membership / capability (pre-write);
    // 404 no-row reads (incl. updateById's null returns — see the
    // predicate doc for the concurrent-delete sub-path analysis).
    for (const status of [400, 401, 403, 404]) {
      expect(isProvenNonCommitApiStatus(status)).toBe(true);
    }
  });

  it('every other 4xx is NOT proven non-commit — the P29 range pins for 409/422/499 are inverted (P31, Iteration-7 P0)', () => {
    // P31 dated note: this test previously asserted 409, 422 and
    // 499 were proven non-commit "by construction" as 4xx-class
    // rejections. Iteration 7 rejected that: these routes never
    // emit 409/422, and 499 is an intermediary/client-close status
    // that cannot prove the origin did not commit. Unemitted or
    // unproven ⇒ ambiguous, never a deletion licence.
    for (const status of [402, 405, 409, 422, 428, 429, 499]) {
      expect(isProvenNonCommitApiStatus(status)).toBe(false);
    }
  });

  it('5xx is never proven non-commit, whatever its flavour', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(isProvenNonCommitApiStatus(status)).toBe(false);
    }
  });

  it('statuses outside the HTTP error range prove nothing', () => {
    for (const status of [0, 200, 301, 399]) {
      expect(isProvenNonCommitApiStatus(status)).toBe(false);
    }
  });
});

describe('shouldCleanUpAfterFailedSave — Programme 29 verified-non-commit rule', () => {
  it('pre-request failure (request phase not reached) ⇒ cleanup, whatever the error', () => {
    expect(shouldCleanUpAfterFailedSave(new Error('processCardImages failed'), false)).toBe(true);
    expect(shouldCleanUpAfterFailedSave(new TypeError('fetch failed'), false)).toBe(true);
    // Even a 5xx-shaped object proves nothing was sent when the
    // request phase was never reached — non-commit is definite.
    expect(shouldCleanUpAfterFailedSave(new ApiError(500, { error: 'x' }), false)).toBe(true);
  });

  it('the fail-closed WorkspaceAccessError (thrown before transport) ⇒ cleanup', () => {
    expect(
      shouldCleanUpAfterFailedSave(
        new WorkspaceAccessError('workspace-context-required', 'no workspace selected'),
        true,
      ),
    ).toBe(true);
  });

  it('proven-4xx ApiError (route rejected before persistence) ⇒ cleanup', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(shouldCleanUpAfterFailedSave(new ApiError(status, { error: 'rejected' }), true)).toBe(
        true,
      );
    }
  });

  it('non-allowlisted 4xx ApiError ⇒ NO cleanup (ambiguous ⇒ reconciliation runs) — P31, Iteration-7 P0', () => {
    // Statuses these handlers never emit (409/422/499 et al.) carry
    // no route-proven non-commit semantics; treating them as
    // definite was the breadth Iteration 7 rejected.
    for (const status of [402, 409, 422, 429, 499]) {
      expect(shouldCleanUpAfterFailedSave(new ApiError(status, { error: 'unproven' }), true)).toBe(
        false,
      );
    }
  });

  it('5xx ApiError ⇒ NO cleanup (ambiguous) — the pin P28 got wrong, inverted per Iteration 6', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldCleanUpAfterFailedSave(new ApiError(status, { error: 'server error' }), true)).toBe(
        false,
      );
    }
  });

  it('scenario — commit-then-500: the server committed, then a 500 reached the client ⇒ NO cleanup', () => {
    // Simulation at the only tier the client can observe: the save
    // committed server-side (e.g. workspace PUT's post-write re-read
    // failed, or a gateway timed out after a slow commit) and all
    // the client holds is ApiError(500) after the request phase.
    // The decision must be "do not delete": the committed record may
    // reference this attempt's images.
    const gatewayAfterCommit = new ApiError(500, { error: 'Failed to update automation' });
    expect(shouldCleanUpAfterFailedSave(gatewayAfterCommit, true)).toBe(false);
  });

  it('scenario — lost response: fetch rejects after the request phase ⇒ NO cleanup (pinned in P28, unchanged)', () => {
    expect(shouldCleanUpAfterFailedSave(new TypeError('fetch failed'), true)).toBe(false);
    expect(shouldCleanUpAfterFailedSave(new DOMException('aborted', 'AbortError'), true)).toBe(false);
  });

  it('an unclassified error after the request phase ⇒ NO cleanup', () => {
    expect(shouldCleanUpAfterFailedSave(new Error('something unexpected'), true)).toBe(false);
    expect(shouldCleanUpAfterFailedSave('a string throw', true)).toBe(false);
    expect(shouldCleanUpAfterFailedSave(undefined, true)).toBe(false);
  });
});

describe('reconcileAmbiguousSaveOutcome — read-back semantics (P29 §3)', () => {
  const publicUrlForPath = (p: string) => `https://cdn.example/card-images/${p}`;

  it('a saved record referencing an uploaded image ⇒ referenced (the save committed)', async () => {
    const result = await reconcileAmbiguousSaveOutcome({
      uploadedPaths: ['user-1/100-a.png', 'user-1/101-b.png'],
      publicUrlForPath,
      loadAutomations: async () => [
        { dm_responses: [{ cardImage: 'https://cdn.example/card-images/user-1/100-a.png' }] },
        { dm_responses: [{ cardImage: 'https://cdn.example/card-images/other/old.png' }] },
      ],
    });
    expect(result.outcome).toBe('referenced');
    expect(result.referencedPaths).toEqual(['user-1/100-a.png']);
  });

  it('a reference matched by storage-path suffix (different public origin) ⇒ referenced', async () => {
    const result = await reconcileAmbiguousSaveOutcome({
      uploadedPaths: ['ws-9/200-c.png'],
      publicUrlForPath,
      loadAutomations: async () => [
        { dm_responses: [{ cardImage: 'https://other-origin.storage/card-images/ws-9/200-c.png' }] },
      ],
    });
    expect(result.outcome).toBe('referenced');
    expect(result.referencedPaths).toEqual(['ws-9/200-c.png']);
  });

  it('no saved record references the uploads ⇒ not-referenced (still NOT a deletion licence)', async () => {
    const result = await reconcileAmbiguousSaveOutcome({
      uploadedPaths: ['user-1/100-a.png'],
      publicUrlForPath,
      loadAutomations: async () => [
        { dm_responses: [{ cardImage: 'https://cdn.example/card-images/other/old.png' }] },
        { dm_responses: [] },
        { dm_responses: null },
        {},
      ],
    });
    expect(result).toEqual({ outcome: 'not-referenced', referencedPaths: [] });
  });

  it('the read-back itself fails ⇒ inconclusive, and the helper never throws', async () => {
    const result = await reconcileAmbiguousSaveOutcome({
      uploadedPaths: ['user-1/100-a.png'],
      publicUrlForPath,
      loadAutomations: async () => {
        throw new ApiError(500, { error: 'list failed' });
      },
    });
    expect(result).toEqual({ outcome: 'inconclusive', referencedPaths: [] });
  });

  it('no uploads ⇒ not-referenced WITHOUT performing a read', async () => {
    const loadAutomations = vi.fn(async () => []);
    const result = await reconcileAmbiguousSaveOutcome({
      uploadedPaths: [],
      publicUrlForPath,
      loadAutomations,
    });
    expect(result).toEqual({ outcome: 'not-referenced', referencedPaths: [] });
    expect(loadAutomations).not.toHaveBeenCalled();
  });
});

describe('source pins — Programme 29 wiring', () => {
  const hookSrc = readFileSync(path.resolve(process.cwd(), 'src/hooks/useAutomations.ts'), 'utf8');

  it('the decision helper keys ApiError on the proven-status predicate (no blanket ApiError ⇒ cleanup)', () => {
    expect(hookSrc).toContain('if (error instanceof ApiError) return isProvenNonCommitApiStatus(error.status);');
    expect(hookSrc).not.toContain('if (error instanceof ApiError) return true;');
  });

  it('both mutations run the reconciliation on the ambiguous branch', () => {
    expect(hookSrc).toContain("await reconcileAndLogAmbiguousSave('create', requestScope, attempt);");
    expect(hookSrc).toContain("await reconcileAndLogAmbiguousSave('update', requestScope, attempt);");
  });

  it('the reconciliation read-back goes through the captured request scope list read', () => {
    expect(hookSrc).toContain("sendWorkspaceRequest<{ automations: AutomationFromDB[] }>");
    expect(hookSrc).toContain("'/automations',");
  });
});
