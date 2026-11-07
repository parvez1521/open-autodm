/**
 * Programme 26 / PF-5 — workspace-prefixed card-image upload integration.
 *
 * The upload flow is CLIENT-SIDE direct-to-storage: processCardImages()
 * in src/hooks/useAutomations.ts runs in the browser during automation
 * create/update, uploads base64 card images to the `card-images`
 * bucket through the user's own Supabase session, and replaces the
 * image with the resulting public URL (that URL is what lands in
 * dm_responses and what Meta later fetches).
 *
 * These tests pin, at unit tier (fake browser client; no network, no
 * real storage):
 *   1. Flag OFF (default + explicit legacy scope): the path is the
 *      historic user-folder construction, byte-for-byte under frozen
 *      Date.now/Math.random.
 *   2. Flag ON + workspace scope: uploads land under the workspace
 *      prefix via cardImages.ts, and the stored public URL points at
 *      the workspace path.
 *   3. Flag ON + invalid context (no selection / viewer role / no
 *      session): fail closed with the tenancy layer's error codes and
 *      ZERO uploads — never a legacy-path fallback.
 *   4. Already-public card URLs and non-card responses pass through
 *      untouched in both modes (legacy read compatibility).
 *   5. A failed storage write keeps the flow's long-standing semantics
 *      (warn + that response returned unchanged — no partial record)
 *      in both modes.
 *
 * The database-level half of cross-workspace isolation (…000033
 * storage RLS re-checking LIVE membership on every write) is proven
 * separately by the disposable-PostgreSQL rehearsal in
 * saas/phase16-rehearsal/ — NOT re-claimed here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn() }));
// The provider is a .tsx component module; the vitest config has no
// JSX transform (node env, no React plugin — codebase convention), so
// it is mocked out. processCardImages never calls it: only the
// mutation hooks' one-line scope adapter does, and that adapter's
// decision logic is the pure cardImageUploadScopeFromSelection below.
vi.mock('@/components/workspace/WorkspaceProvider', () => ({ useWorkspace: vi.fn() }));

import { createBrowserClient } from '@/lib/supabase';
import { processCardImages, type DMResponse } from '@/hooks/useAutomations';
import {
  assertCardImageUploadScope,
  cardImagePathForScope,
  cardImageUploadScopeFromSelection,
  type CardImageUploadScope,
} from '@/lib/storage/cardImages';
import { WorkspaceAccessError } from '@/lib/tenancy/context';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const NOW = 1730000000000;
const RANDOM = 0.123456789;
const RAND = RANDOM.toString(36).slice(2);

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;
const JPG_DATA_URL = `data:image/jpeg;base64,${Buffer.from('fake-jpg-bytes').toString('base64')}`;

const card = (cardImage?: string): DMResponse => ({
  id: 'r-card',
  type: 'card',
  content: '',
  ...(cardImage !== undefined ? { cardImage } : {}),
});
const text = (): DMResponse => ({ id: 'r-text', type: 'text', content: 'hello' });

interface RecordedUpload {
  bucket: string;
  path: string;
  contentType?: string;
  upsert?: boolean;
}

function installFakeBrowserClient(opts: {
  userId: string | null;
  failFirstUpload?: boolean;
}): { uploads: RecordedUpload[] } {
  const uploads: RecordedUpload[] = [];
  let uploadCalls = 0;
  const fake = {
    auth: {
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (p: string, _blob: Blob, o?: { contentType?: string; upsert?: boolean }) => {
          uploadCalls += 1;
          uploads.push({ bucket, path: p, contentType: o?.contentType, upsert: o?.upsert });
          if (opts.failFirstUpload && uploadCalls === 1) {
            return { data: null, error: { message: 'simulated storage failure' } };
          }
          return { data: { path: p }, error: null };
        },
        getPublicUrl: (p: string) => ({
          data: { publicUrl: `https://storage.test/${bucket}/${p}` },
        }),
      }),
    },
  };
  vi.mocked(createBrowserClient).mockReturnValue(
    fake as unknown as ReturnType<typeof createBrowserClient>,
  );
  return { uploads };
}

const wsScope = (workspaceId: string, role: 'owner' | 'admin' | 'member' | 'viewer'): CardImageUploadScope => ({
  kind: 'workspace',
  workspaceId,
  role,
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(RANDOM);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('selection → scope mapping (pure, cardImages)', () => {
  it('flag OFF always yields the legacy scope — even with a selection present', () => {
    expect(
      cardImageUploadScopeFromSelection({ workspaceRuntimeEnabled: false, selectedWorkspace: null }),
    ).toEqual({ kind: 'legacy' });
    expect(
      cardImageUploadScopeFromSelection({
        workspaceRuntimeEnabled: false,
        selectedWorkspace: { workspaceId: WS_A, role: 'owner' },
      }),
    ).toEqual({ kind: 'legacy' });
  });

  it('flag ON + selection yields the workspace scope with that id and role', () => {
    expect(
      cardImageUploadScopeFromSelection({
        workspaceRuntimeEnabled: true,
        selectedWorkspace: { workspaceId: WS_A, role: 'member' },
      }),
    ).toEqual({ kind: 'workspace', workspaceId: WS_A, role: 'member' });
  });

  it('flag ON + no selection yields unavailable (fail closed, never a guessed workspace)', () => {
    expect(
      cardImageUploadScopeFromSelection({ workspaceRuntimeEnabled: true, selectedWorkspace: null }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      cardImageUploadScopeFromSelection({ workspaceRuntimeEnabled: true, selectedWorkspace: undefined }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('scope → path resolution (cardImages)', () => {
  it('legacy scope builds the historic user-folder path', () => {
    expect(cardImagePathForScope({ kind: 'legacy' }, USER, 'png', NOW, 'abc123')).toBe(
      `${USER}/${NOW}-abc123.png`,
    );
  });

  it('workspace scope builds the workspace-prefixed path', () => {
    expect(cardImagePathForScope(wsScope(WS_A, 'member'), USER, 'jpg', NOW, 'abc123')).toBe(
      `${WS_A}/${NOW}-abc123.jpg`,
    );
  });

  it('unavailable scope has no path: throws workspace-context-required', () => {
    expect(() => cardImagePathForScope({ kind: 'unavailable' }, USER, 'png', NOW, 'x')).toThrowError(
      expect.objectContaining({ code: 'workspace-context-required' }),
    );
    expect(() => assertCardImageUploadScope({ kind: 'unavailable' }, USER)).toThrowError(
      expect.objectContaining({ code: 'workspace-context-required' }),
    );
  });

  it('assert: legacy always passes; workspace write roles pass; viewer is insufficient-role', () => {
    expect(() => assertCardImageUploadScope({ kind: 'legacy' }, USER)).not.toThrow();
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(() => assertCardImageUploadScope(wsScope(WS_A, role), USER)).not.toThrow();
    }
    try {
      assertCardImageUploadScope(wsScope(WS_A, 'viewer'), USER);
      throw new Error('expected assert to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceAccessError);
      expect((err as WorkspaceAccessError).code).toBe('insufficient-role');
    }
  });
});

describe('processCardImages — flag OFF (legacy behaviour, byte-identical)', () => {
  // P27 note (Iteration-4 disposition): the scope argument is REQUIRED
  // since P27 — these calls pass { kind: 'legacy' } explicitly; the
  // legacy behaviour asserted is unchanged from P26.
  it('explicit legacy scope uploads under the user folder with the historic construction', async () => {
    const { uploads } = installFakeBrowserClient({ userId: USER });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    const out = await processCardImages([card(PNG_DATA_URL)], { kind: 'legacy' }, { uploadedPaths: [] });

    expect(uploads).toEqual([
      { bucket: 'card-images', path: `${USER}/${NOW}-${RAND}.png`, contentType: 'image/png', upsert: false },
    ]);
    expect(out[0]?.cardImage).toBe(`https://storage.test/card-images/${USER}/${NOW}-${RAND}.png`);
  });

  it('explicit legacy scope (jpeg → .jpg)', async () => {
    const { uploads } = installFakeBrowserClient({ userId: USER });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    const out = await processCardImages([card(JPG_DATA_URL)], { kind: 'legacy' }, { uploadedPaths: [] });

    expect(uploads.map((u) => u.path)).toEqual([`${USER}/${NOW}-${RAND}.jpg`]);
    expect(out[0]?.cardImage).toBe(`https://storage.test/card-images/${USER}/${NOW}-${RAND}.jpg`);
  });

  it('no session: pass-through unchanged (long-standing legacy semantics)', async () => {
    const { uploads } = installFakeBrowserClient({ userId: null });
    const input = [card(PNG_DATA_URL)];
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    const out = await processCardImages(input, { kind: 'legacy' }, { uploadedPaths: [] });
    expect(out).toEqual(input);
    expect(uploads).toEqual([]);
  });
});

describe('processCardImages — workspace mode', () => {
  it('member upload lands under the workspace prefix; the stored URL points at it', async () => {
    const { uploads } = installFakeBrowserClient({ userId: USER });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    const out = await processCardImages([card(PNG_DATA_URL)], wsScope(WS_A, 'member'), { uploadedPaths: [] });

    expect(uploads.map((u) => u.path)).toEqual([`${WS_A}/${NOW}-${RAND}.png`]);
    expect(out[0]?.cardImage).toBe(`https://storage.test/card-images/${WS_A}/${NOW}-${RAND}.png`);
  });

  it('the prefix follows the scope exactly: scope A never writes under B (and vice versa)', async () => {
    const a = installFakeBrowserClient({ userId: USER });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    await processCardImages([card(PNG_DATA_URL)], wsScope(WS_A, 'owner'), { uploadedPaths: [] });
    const b = installFakeBrowserClient({ userId: USER });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    await processCardImages([card(PNG_DATA_URL)], wsScope(WS_B, 'owner'), { uploadedPaths: [] });

    expect(a.uploads.map((u) => u.path)).toEqual([`${WS_A}/${NOW}-${RAND}.png`]);
    expect(b.uploads.map((u) => u.path)).toEqual([`${WS_B}/${NOW}-${RAND}.png`]);
  });

  it('only data: card images upload; text, URL cards and image-less cards pass through by reference', async () => {
    const { uploads } = installFakeBrowserClient({ userId: USER });
    const urlCard = card('https://storage.test/card-images/legacy/path.png');
    const bareCard = card();
    const t = text();
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    const out = await processCardImages([t, urlCard, bareCard, card(PNG_DATA_URL)], wsScope(WS_A, 'admin'), { uploadedPaths: [] });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.path).toBe(`${WS_A}/${NOW}-${RAND}.png`);
    expect(out[0]).toBe(t);
    expect(out[1]).toBe(urlCard);
    expect(out[2]).toBe(bareCard);
    expect(out[3]?.cardImage).toBe(`https://storage.test/card-images/${WS_A}/${NOW}-${RAND}.png`);
  });
});

describe('processCardImages — workspace mode fails closed (no legacy fallback)', () => {
  it('no selection (unavailable scope) + pending upload: workspace-context-required, zero uploads', async () => {
    const { uploads } = installFakeBrowserClient({ userId: USER });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    await expect(processCardImages([card(PNG_DATA_URL)], { kind: 'unavailable' }, { uploadedPaths: [] })).rejects.toMatchObject({
      code: 'workspace-context-required',
    });
    expect(uploads).toEqual([]);
  });

  it('viewer role: insufficient-role, zero uploads', async () => {
    const { uploads } = installFakeBrowserClient({ userId: USER });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    await expect(processCardImages([card(PNG_DATA_URL)], wsScope(WS_A, 'viewer'), { uploadedPaths: [] })).rejects.toMatchObject({
      code: 'insufficient-role',
    });
    expect(uploads).toEqual([]);
  });

  it('no session in workspace mode: not-a-member, zero uploads', async () => {
    const { uploads } = installFakeBrowserClient({ userId: null });
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    await expect(processCardImages([card(PNG_DATA_URL)], wsScope(WS_A, 'member'), { uploadedPaths: [] })).rejects.toMatchObject({
      code: 'not-a-member',
    });
    expect(uploads).toEqual([]);
  });

  it('unavailable scope with NOTHING to upload does not throw (no upload is gated)', async () => {
    installFakeBrowserClient({ userId: USER });
    const input = [text(), card('https://storage.test/card-images/legacy/path.png')];
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    await expect(processCardImages(input, { kind: 'unavailable' }, { uploadedPaths: [] })).resolves.toEqual(input);
  });
});

describe('processCardImages — storage failure semantics (existing contract, both modes)', () => {
  it('workspace mode: a failed write leaves that response unchanged; the other card still uploads', async () => {
    const { uploads } = installFakeBrowserClient({ userId: USER, failFirstUpload: true });
    const failing = card(PNG_DATA_URL);
    const succeeding = { ...card(JPG_DATA_URL), id: 'r-card-2' };
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    const out = await processCardImages([failing, succeeding], wsScope(WS_A, 'member'), { uploadedPaths: [] });

    expect(uploads).toHaveLength(2);
    expect(out[0]).toBe(failing);
    expect(out[0]?.cardImage).toBe(PNG_DATA_URL);
    expect(out[1]?.cardImage).toBe(`https://storage.test/card-images/${WS_A}/${NOW}-${RAND}.jpg`);
    expect(console.warn).toHaveBeenCalled();
  });

  it('legacy mode: a failed write leaves the response unchanged', async () => {
    installFakeBrowserClient({ userId: USER, failFirstUpload: true });
    const failing = card(PNG_DATA_URL);
    // Programme 28 note (2026-11-07): attempt ledger is now a required argument; explicit empty ledger, asserted behaviour unchanged.
    const out = await processCardImages([failing], { kind: 'legacy' }, { uploadedPaths: [] });
    expect(out[0]).toBe(failing);
    expect(out[0]?.cardImage).toBe(PNG_DATA_URL);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('PF-5 wiring (source pins)', () => {
  const hookSrc = readFileSync(path.resolve(process.cwd(), 'src/hooks/useAutomations.ts'), 'utf8');
  const cardImagesSrc = readFileSync(
    path.resolve(process.cwd(), 'src/lib/storage/cardImages.ts'),
    'utf8',
  );

  it('the upload flow routes path selection through cardImages.ts (no parallel implementation)', () => {
    expect(hookSrc).toContain("from '@/lib/storage/cardImages'");
    expect(hookSrc).toContain('cardImagePathForScope(scope, session.user.id, ext)');
    expect(hookSrc).not.toContain('${session.user.id}/${Date.now()}');
  });

  it('both mutations pass the resolved workspace scope', () => {
    // P27 note: the mutations now resolve ONE captured context
    // (useAutomationWorkspaceContext) and pass the attempt ledger as
    // the third argument; the scope still reaches processCardImages
    // from the same hook value in both mutations.
    expect(hookSrc).toContain('processCardImages(payload.dmResponses ?? [], uploadScope, attempt)');
    expect(hookSrc).toContain('processCardImages(payload.dm_responses, uploadScope, attempt)');
    expect(hookSrc).toContain('useAutomationWorkspaceContext()');
  });

  it('the scope abstraction lives in cardImages.ts with the tenancy error vocabulary', () => {
    expect(cardImagesSrc).toContain('export type CardImageUploadScope');
    expect(cardImagesSrc).toContain('export function assertCardImageUploadScope');
    expect(cardImagesSrc).toContain('export function cardImagePathForScope');
    expect(cardImagesSrc).toContain("'workspace-context-required'");
  });
});
