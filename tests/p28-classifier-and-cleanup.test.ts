/**
 * Programme 28 (§1 + §3) — classifier precision and cleanup hardening.
 *
 * Iteration-5 verified three classifier gaps in P27's
 * isCardImageStorageDenial (numeric-string `status` unparsed, the
 * documented hyphenated vocabulary unmatched by the space-separated
 * regex, and a bare 401 misclassified as an insufficient-role cause)
 * and three cleanup gaps (optional attempt ledger, cleanup running
 * even when the save outcome is ambiguous, and a Promise.all race
 * where a denial surfaced before sibling uploads landed in the
 * ledger). These tests pin the P28 end state, at unit tier (fake
 * browser client; no network, no real storage):
 *   1. classifyCardImageStorageError: symmetric status parsing,
 *      hyphen/space-normalized message matching, and the two
 *      classes ('authorization-denied' / 'session-expired');
 *      isCardImageStorageDenial is re-derived as classify() !== null
 *      (its boolean contract — "must abort a workspace-mode save" —
 *      is unchanged).
 *   2. processCardImages: the class selects the abort code in
 *      workspace mode (401-shaped ⇒ 'session-expired'; hyphenated
 *      denial ⇒ 'insufficient-role'), and settle-before-throw means
 *      the attempt ledger is complete at rejection time even when
 *      the failing upload settles first.
 *   3. shouldCleanUpAfterFailedSave: cleanup only on definite
 *      failure; a transport failure after the request phase was
 *      reached is ambiguous and skips cleanup.
 *   4. Source pin: the attempt argument of processCardImages is
 *      REQUIRED (no optional marker), mirroring the P27
 *      required-scope pin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn() }));
// The provider is a .tsx component module; the vitest config has no
// JSX transform (node env, no React plugin — codebase convention), so
// it is mocked out, mirroring tests/p27-workspace-builder-requests.test.ts.
// processCardImages never calls it.
vi.mock('@/components/workspace/WorkspaceProvider', () => ({ useWorkspace: vi.fn() }));

import { createBrowserClient } from '@/lib/supabase';
import { ApiError } from '@/lib/api/client';
import {
  processCardImages,
  shouldCleanUpAfterFailedSave,
  type CardImageUploadAttempt,
  type DMResponse,
} from '@/hooks/useAutomations';
import {
  classifyCardImageStorageError,
  isCardImageStorageDenial,
  type CardImageUploadScope,
} from '@/lib/storage/cardImages';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

const WS_A = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;
const JPG_DATA_URL = `data:image/jpeg;base64,${Buffer.from('fake-jpg-bytes').toString('base64')}`;

const card = (cardImage?: string, id = 'r-card'): DMResponse => ({
  id,
  type: 'card',
  content: '',
  ...(cardImage !== undefined ? { cardImage } : {}),
});

const wsMember = (workspaceId: string): CardImageUploadScope => ({
  kind: 'workspace',
  workspaceId,
  role: 'member',
});

describe('classifyCardImageStorageError — status symmetry (§1.1)', () => {
  it('{ status: "403" } (numeric-string status) ⇒ authorization-denied + isDenial true', () => {
    const err = { status: '403', message: 'Forbidden' };
    expect(classifyCardImageStorageError(err)).toBe('authorization-denied');
    expect(isCardImageStorageDenial(err)).toBe(true);
  });

  it('{ statusCode: "403" } ⇒ authorization-denied + isDenial true', () => {
    const err = { statusCode: '403', message: 'Forbidden' };
    expect(classifyCardImageStorageError(err)).toBe('authorization-denied');
    expect(isCardImageStorageDenial(err)).toBe(true);
  });

  it('{ status: 403 } ⇒ authorization-denied + isDenial true', () => {
    const err = { status: 403, message: 'Forbidden' };
    expect(classifyCardImageStorageError(err)).toBe('authorization-denied');
    expect(isCardImageStorageDenial(err)).toBe(true);
  });

  it('{ statusCode: "401" } (numeric-string statusCode) ⇒ session-expired + isDenial true', () => {
    const err = { statusCode: '401' };
    expect(classifyCardImageStorageError(err)).toBe('session-expired');
    expect(isCardImageStorageDenial(err)).toBe(true);
  });
});

describe('classifyCardImageStorageError — message normalization (§1.2)', () => {
  it('hyphenated denial vocabulary ⇒ authorization-denied', () => {
    for (const message of ['permission-denied', 'row-level-security policy violation', 'not-authorized']) {
      const err = { message };
      expect(classifyCardImageStorageError(err)).toBe('authorization-denied');
      expect(isCardImageStorageDenial(err)).toBe(true);
    }
  });

  it("message-only 'Unauthorized' ⇒ session-expired + isDenial true", () => {
    const err = { message: 'Unauthorized' };
    expect(classifyCardImageStorageError(err)).toBe('session-expired');
    expect(isCardImageStorageDenial(err)).toBe(true);
  });
});

describe('classifyCardImageStorageError — class precedence and non-denials (§1.3)', () => {
  it("bare 401 ({ status: 401, message: 'JWT expired' }) ⇒ session-expired + isDenial true", () => {
    const err = { status: 401, message: 'JWT expired' };
    expect(classifyCardImageStorageError(err)).toBe('session-expired');
    expect(isCardImageStorageDenial(err)).toBe(true);
  });

  it('401 WITH row-level-security vocabulary ⇒ authorization-denied (strong vocabulary wins)', () => {
    const err = { status: 401, message: 'new row violates row-level security policy for table "objects"' };
    expect(classifyCardImageStorageError(err)).toBe('authorization-denied');
    expect(isCardImageStorageDenial(err)).toBe(true);
  });

  it('500 / 409 / 413 / network / generic / null ⇒ null + isDenial false', () => {
    const nonDenials: unknown[] = [
      { statusCode: 500, message: 'Internal error' },
      { statusCode: '409', message: 'The resource already exists' },
      { status: 413, message: 'Payload too large' },
      { message: 'fetch failed' },
      { message: 'simulated storage failure' },
      null,
      undefined,
      'boom',
    ];
    for (const err of nonDenials) {
      expect(classifyCardImageStorageError(err)).toBeNull();
      expect(isCardImageStorageDenial(err)).toBe(false);
    }
  });
});

// ── processCardImages: abort codes + settle-before-throw ────────────

interface FakeStorage {
  uploads: string[];
}

function installFakeStorage(opts: {
  userId: string | null;
  /** Per-upload outcomes in call order: 'ok' or an error object. */
  outcomes: (object | 'ok')[];
  /** Upload call index that must wait for `slowGate` before returning. */
  slowIndex?: number;
  slowGate?: Promise<void>;
  /** Path the slow upload reports on success (defaults to its request path). */
  slowPath?: string;
}): FakeStorage {
  const state: FakeStorage = { uploads: [] };
  let uploadCalls = 0;
  const fake = {
    auth: {
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (p: string) => {
          const idx = uploadCalls++;
          state.uploads.push(p);
          if (idx === opts.slowIndex && opts.slowGate) await opts.slowGate;
          const outcome = opts.outcomes[idx] ?? 'ok';
          if (outcome !== 'ok') return { data: null, error: outcome };
          return { data: { path: idx === opts.slowIndex && opts.slowPath ? opts.slowPath : p }, error: null };
        },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.test/${bucket}/${p}` } }),
      }),
    },
  };
  vi.mocked(createBrowserClient).mockReturnValue(
    fake as unknown as ReturnType<typeof createBrowserClient>,
  );
  return state;
}

describe('processCardImages — Programme 28 abort codes (§1b)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("workspace scope + storage error { status: 401 } ⇒ rejects with code 'session-expired'", async () => {
    installFakeStorage({ userId: USER, outcomes: [{ status: 401, message: 'JWT expired' }] });
    const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
    await expect(processCardImages([card(PNG_DATA_URL)], wsMember(WS_A), attempt)).rejects.toMatchObject({
      name: 'WorkspaceAccessError',
      code: 'session-expired',
    });
    expect(attempt.uploadedPaths).toEqual([]);
  });

  it("workspace scope + hyphenated denial message ⇒ rejects with code 'insufficient-role'", async () => {
    installFakeStorage({ userId: USER, outcomes: [{ message: 'permission-denied by storage policy' }] });
    const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
    await expect(processCardImages([card(PNG_DATA_URL)], wsMember(WS_A), attempt)).rejects.toMatchObject({
      name: 'WorkspaceAccessError',
      code: 'insufficient-role',
    });
    expect(attempt.uploadedPaths).toEqual([]);
  });

  it('settle-before-throw (§3iii): a fast denial does not surface until a slow sibling upload has landed in the ledger', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowPath = `${WS_A}/slow-upload.png`;
    installFakeStorage({
      userId: USER,
      // Response order: first fails FAST with an RLS denial; second succeeds SLOWLY.
      outcomes: [{ message: 'new row violates row-level security policy for table "objects"', statusCode: '403' }, 'ok'],
      slowIndex: 1,
      slowGate,
      slowPath,
    });
    const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
    let ledgerAtRejection: string[] | null = null;
    const observed = processCardImages(
      [card(PNG_DATA_URL), card(JPG_DATA_URL, 'r-card-2')],
      wsMember(WS_A),
      attempt,
    ).catch((err: unknown) => {
      ledgerAtRejection = [...attempt.uploadedPaths];
      throw err;
    });
    // Let the fast denial settle, then release the slow upload. On the
    // old Promise.all code the rejection would already have surfaced
    // (with an empty ledger snapshot); under allSettled it can only
    // surface after the slow upload completes and pushes its path.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSlow();
    await expect(observed).rejects.toMatchObject({ code: 'insufficient-role' });
    expect(ledgerAtRejection).toEqual([slowPath]);
    expect(attempt.uploadedPaths).toEqual([slowPath]);
  });
});

describe('shouldCleanUpAfterFailedSave — ambiguous-outcome rule (§3ii)', () => {
  it('a pre-request error (request phase not reached) ⇒ true, whatever its type', () => {
    expect(shouldCleanUpAfterFailedSave(new Error('processCardImages failed'), false)).toBe(true);
    expect(shouldCleanUpAfterFailedSave(new TypeError('fetch failed'), false)).toBe(true);
  });

  it('a definite request-phase failure (WorkspaceAccessError) ⇒ true', () => {
    // Programme 29 dated note (2026-11-07, superseding the P28 pin
    // per ChatGPT Iteration 6): this test previously ALSO pinned
    // `ApiError(500) ⇒ true` ("an HTTP error response was received ⇒
    // definite"). Iteration 6 REJECTED that rule — a 5xx does not
    // prove non-commit (a commit can precede a gateway/post-write
    // 5xx). The ApiError(500) expectation now lives, INVERTED
    // (⇒ false), in tests/p29-save-outcome-reconciliation.test.ts,
    // with the full status matrix; the proven-4xx ⇒ true cases are
    // pinned there too. The WorkspaceAccessError pin is unchanged.
    expect(
      shouldCleanUpAfterFailedSave(
        new WorkspaceAccessError('workspace-context-required', 'no workspace selected'),
        true,
      ),
    ).toBe(true);
  });

  it("a transport failure after the request phase was reached (TypeError 'fetch failed') ⇒ false (ambiguous)", () => {
    expect(shouldCleanUpAfterFailedSave(new TypeError('fetch failed'), true)).toBe(false);
  });
});

describe('source pins — Programme 28 (§3i)', () => {
  const hookSrc = readFileSync(path.resolve(process.cwd(), 'src/hooks/useAutomations.ts'), 'utf8');

  it('processCardImages: the attempt argument is REQUIRED (no optional attempt remains)', () => {
    expect(hookSrc).toContain('attempt: CardImageUploadAttempt,');
    expect(hookSrc).not.toContain('attempt?: CardImageUploadAttempt');
    expect(hookSrc).not.toContain('attempt?.uploadedPaths');
  });
});
