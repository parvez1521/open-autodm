/**
 * Programme 27 (A) — workspace-mode builder completion (register PF-7)
 * + the Iteration-4 dispositions folded into this run.
 *
 * Programme 26 §6.1 recorded the gap: the automations mutations called
 * plain `apiClient` WITHOUT the `x-workspace-id` header, so with
 * WORKSPACE_RUNTIME_ENABLED on, the /automations save itself met the
 * routes' missing-selector 400 ('workspace-context-required') — card
 * uploads were workspace-scoped but the record save was not. The
 * builder's reads (account picker, post picker) shared the gap.
 *
 * These tests pin, at unit tier (fake transports; no network — the
 * hook-wiring assertions are SOURCE PINS, not runtime integration
 * tests, per the Iteration-4 wording correction):
 *   1. Request-scope mapping: flag OFF ⇒ legacy (even with a
 *      selection); flag ON + selection ⇒ workspace; flag ON + none ⇒
 *      unavailable.
 *   2. Legacy ⇒ the transport receives the EXACT pre-P27 call (same
 *      path, same options object by reference, no header added).
 *   3. Workspace ⇒ the `x-workspace-id` header for the scope's
 *      workspace is merged over caller headers; the scope's id wins
 *      over any caller-supplied selector.
 *   4. Unavailable ⇒ WorkspaceAccessError('workspace-context-required')
 *      BEFORE the transport is invoked — zero requests, no fallback.
 *   5. Snapshot semantics: a scope resolved under selection A keeps
 *      sending A after selection B is resolved — one operation can
 *      never be split across two workspaces.
 *   6. Iteration-4: `processCardImages`' scope argument is REQUIRED
 *      (source pin — omission is now a compile error, not a silent
 *      legacy default).
 *   7. Iteration-4: an authorization-DENIED storage write in workspace
 *      mode ABORTS the mutation with a typed error (the `data:` image
 *      is never submitted under a workspace save); a recoverable
 *      failure keeps warn-and-unchanged; legacy mode never aborts on
 *      an upload error, denial-shaped or not.
 *   8. Iteration-4 §2E: the attempt ledger records exactly the objects
 *      an attempt uploaded, and removeUploadedCardImages deletes
 *      exactly those, best-effort (never throws, never masks).
 *   9. Source pins: every builder mutation + the builder's account /
 *      post reads route through sendWorkspaceRequest; create/update
 *      resolve ONE captured context (useAutomationWorkspaceContext);
 *      the workspace cache keys name the workspace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/api/client', () => ({ apiClient: vi.fn(), ApiError: class extends Error {} }));
vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn() }));
// The provider is a .tsx component module; the vitest config has no
// JSX transform (codebase convention), so it is mocked out. The hook
// adapters are verified by source pins; the runtime behaviour tested
// here lives in the pure scope functions and processCardImages.
vi.mock('@/components/workspace/WorkspaceProvider', () => ({ useWorkspace: vi.fn() }));

import { apiClient } from '@/lib/api/client';
import { createBrowserClient } from '@/lib/supabase';
import {
  assertWorkspaceRequestScope,
  sendWorkspaceRequest,
  workspaceRequestScopeFromSelection,
  type WorkspaceRequestClient,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';
import {
  isCardImageStorageDenial,
  type CardImageUploadScope,
} from '@/lib/storage/cardImages';
import { WorkspaceAccessError } from '@/lib/tenancy/context';
import {
  processCardImages,
  removeUploadedCardImages,
  type CardImageUploadAttempt,
  type DMResponse,
} from '@/hooks/useAutomations';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';

function fakeClient() {
  const calls: { path: string; options?: RequestInit }[] = [];
  const client: WorkspaceRequestClient = async <T,>(p: string, options?: RequestInit) => {
    calls.push({ path: p, options });
    return { ok: true } as T;
  };
  return { calls, client };
}

const legacy: WorkspaceRequestScope = { kind: 'legacy' };
const wsA: WorkspaceRequestScope = { kind: 'workspace', workspaceId: WS_A };
const unavailable: WorkspaceRequestScope = { kind: 'unavailable' };

describe('request scope mapping (pure)', () => {
  it('flag OFF ⇒ legacy, even with a selection present', () => {
    expect(
      workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled: false, selectedWorkspaceId: WS_A }),
    ).toEqual({ kind: 'legacy' });
    expect(
      workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled: false, selectedWorkspaceId: null }),
    ).toEqual({ kind: 'legacy' });
  });

  it('flag ON + selection ⇒ workspace scope carrying that id', () => {
    expect(
      workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled: true, selectedWorkspaceId: WS_A }),
    ).toEqual({ kind: 'workspace', workspaceId: WS_A });
  });

  it('flag ON + no selection (null / undefined / empty) ⇒ unavailable', () => {
    for (const selectedWorkspaceId of [null, undefined, '']) {
      expect(
        workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled: true, selectedWorkspaceId }),
      ).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('assertWorkspaceRequestScope', () => {
  it('legacy and workspace scopes pass', () => {
    expect(() => assertWorkspaceRequestScope(legacy)).not.toThrow();
    expect(() => assertWorkspaceRequestScope(wsA)).not.toThrow();
  });

  it("unavailable throws the tenancy layer's typed error", () => {
    try {
      assertWorkspaceRequestScope(unavailable);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceAccessError);
      expect((err as WorkspaceAccessError).code).toBe('workspace-context-required');
    }
  });
});

describe('sendWorkspaceRequest — flag OFF (legacy)', () => {
  it('passes path and options through untouched (same options object, no header)', async () => {
    const { calls, client } = fakeClient();
    const options: RequestInit = { method: 'POST', body: JSON.stringify({ name: 'x' }) };
    const result = await sendWorkspaceRequest<{ ok: boolean }>(legacy, '/automations', options, client);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/automations');
    expect(calls[0]!.options).toBe(options);
    expect((calls[0]!.options?.headers as Record<string, string> | undefined)?.['x-workspace-id']).toBeUndefined();
  });

  it('a bodyless legacy call passes options as undefined, exactly like the pre-P27 call', async () => {
    const { calls, client } = fakeClient();
    await sendWorkspaceRequest(legacy, '/automations', undefined, client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toBeUndefined();
  });
});

describe('sendWorkspaceRequest — workspace mode', () => {
  // Programme 28 note (2026-11-07): the merged headers are now a
  // `Headers` instance (Iteration-5 §2 fix — the P27 Record spread
  // corrupted Headers-instance and tuple-array HeadersInit). The four
  // tests below read the selector via `new Headers(...).get(...)`
  // instead of Record indexing; the asserted behaviour (selector
  // attached, scope wins, no crossing, snapshot semantics) is
  // unchanged.
  it('attaches the x-workspace-id header for the scope workspace, preserving method/body', async () => {
    const { calls, client } = fakeClient();
    await sendWorkspaceRequest(wsA, '/automations', { method: 'POST', body: '{}' }, client);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.options?.headers);
    expect(headers.get('x-workspace-id')).toBe(WS_A);
    expect(calls[0]!.options?.method).toBe('POST');
    expect(calls[0]!.options?.body).toBe('{}');
  });

  it("the scope's selector wins over a caller-supplied x-workspace-id", async () => {
    const { calls, client } = fakeClient();
    await sendWorkspaceRequest(
      wsA,
      '/automations',
      { method: 'PUT', headers: { 'x-workspace-id': WS_B, 'x-other': 'kept' } },
      client,
    );
    const headers = new Headers(calls[0]!.options?.headers);
    expect(headers.get('x-workspace-id')).toBe(WS_A);
    expect(headers.get('x-other')).toBe('kept');
  });

  it('two scopes never cross: A sends A, B sends B', async () => {
    const { calls, client } = fakeClient();
    await sendWorkspaceRequest(wsA, '/automations/1', { method: 'DELETE' }, client);
    await sendWorkspaceRequest({ kind: 'workspace', workspaceId: WS_B }, '/automations/2', { method: 'DELETE' }, client);
    expect(new Headers(calls[0]!.options?.headers).get('x-workspace-id')).toBe(WS_A);
    expect(new Headers(calls[1]!.options?.headers).get('x-workspace-id')).toBe(WS_B);
  });

  it('snapshot semantics: a scope resolved under A still sends A after B is resolved', async () => {
    const { calls, client } = fakeClient();
    const scopeAtSaveStart = workspaceRequestScopeFromSelection({
      workspaceRuntimeEnabled: true,
      selectedWorkspaceId: WS_A,
    });
    // The user switches to workspace B while the save is in flight.
    workspaceRequestScopeFromSelection({ workspaceRuntimeEnabled: true, selectedWorkspaceId: WS_B });
    await sendWorkspaceRequest(scopeAtSaveStart, '/automations', { method: 'POST', body: '{}' }, client);
    expect(new Headers(calls[0]!.options?.headers).get('x-workspace-id')).toBe(WS_A);
  });
});

describe('sendWorkspaceRequest — fail closed', () => {
  it('unavailable ⇒ typed error BEFORE any request; the transport is never invoked', async () => {
    const { calls, client } = fakeClient();
    await expect(
      sendWorkspaceRequest(unavailable, '/automations', { method: 'POST', body: '{}' }, client),
    ).rejects.toMatchObject({ name: 'WorkspaceAccessError', code: 'workspace-context-required' });
    expect(calls).toHaveLength(0);
  });

  it('the default transport is apiClient (production wiring)', async () => {
    const mocked = vi.mocked(apiClient);
    mocked.mockReset();
    mocked.mockResolvedValue({ automations: [] });
    await sendWorkspaceRequest(legacy, '/automations');
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith('/automations', undefined);
  });
});

// ── Iteration-4: denial classification, abort, attempt ledger ───────

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;
const JPG_DATA_URL = `data:image/jpeg;base64,${Buffer.from('fake-jpg-bytes').toString('base64')}`;
const card = (cardImage?: string): DMResponse => ({
  id: 'r-card',
  type: 'card',
  content: '',
  ...(cardImage !== undefined ? { cardImage } : {}),
});

const DENIAL_RLS = { message: 'new row violates row-level security policy for table "objects"', statusCode: '403' };
const RECOVERABLE = { message: 'simulated storage failure' };

interface FakeStorage {
  uploads: string[];
  removed: string[][];
  fromCalls: number;
}

function installFakeStorage(opts: {
  userId: string | null;
  /** Per-upload outcomes in call order: 'ok' or an error object. */
  outcomes: (object | 'ok')[];
  removeError?: object | null;
  removeThrows?: boolean;
}): FakeStorage {
  const state: FakeStorage = { uploads: [], removed: [], fromCalls: 0 };
  let uploadCalls = 0;
  const fake = {
    auth: {
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    storage: {
      from: (bucket: string) => {
        state.fromCalls += 1;
        return {
          upload: async (p: string) => {
            state.uploads.push(p);
            const outcome = opts.outcomes[uploadCalls++] ?? 'ok';
            if (outcome !== 'ok') return { data: null, error: outcome };
            return { data: { path: p }, error: null };
          },
          getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.test/${bucket}/${p}` } }),
          remove: async (paths: string[]) => {
            state.removed.push(paths);
            if (opts.removeThrows) throw new Error('simulated remove transport failure');
            return { data: [], error: opts.removeError ?? null };
          },
        };
      },
    },
  };
  vi.mocked(createBrowserClient).mockReturnValue(
    fake as unknown as ReturnType<typeof createBrowserClient>,
  );
  return state;
}

const wsMember = (workspaceId: string): CardImageUploadScope => ({
  kind: 'workspace',
  workspaceId,
  role: 'member',
});

describe('isCardImageStorageDenial (classifier)', () => {
  it('HTTP 401/403 (number or numeric string) is a denial', () => {
    expect(isCardImageStorageDenial({ statusCode: 403, message: 'Forbidden' })).toBe(true);
    expect(isCardImageStorageDenial({ statusCode: '403', message: 'Forbidden' })).toBe(true);
    expect(isCardImageStorageDenial({ status: 401, message: 'JWT expired' })).toBe(true);
  });

  it('RLS / permission vocabulary in the message is a denial', () => {
    expect(isCardImageStorageDenial(DENIAL_RLS)).toBe(true);
    expect(isCardImageStorageDenial({ message: 'permission denied for table objects' })).toBe(true);
    expect(isCardImageStorageDenial({ message: 'Unauthorized' })).toBe(true);
  });

  it('recoverable failures are NOT denials', () => {
    expect(isCardImageStorageDenial(RECOVERABLE)).toBe(false);
    expect(isCardImageStorageDenial({ statusCode: 500, message: 'Internal error' })).toBe(false);
    expect(isCardImageStorageDenial({ statusCode: '409', message: 'The resource already exists' })).toBe(false);
    expect(isCardImageStorageDenial(null)).toBe(false);
    expect(isCardImageStorageDenial('boom')).toBe(false);
    expect(isCardImageStorageDenial(undefined)).toBe(false);
  });
});

describe('processCardImages — P27 workspace denial abort + attempt ledger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('workspace mode + RLS-denied write ⇒ typed abort; nothing is returned for submission', async () => {
    installFakeStorage({ userId: USER, outcomes: [DENIAL_RLS] });
    const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
    await expect(processCardImages([card(PNG_DATA_URL)], wsMember(WS_A), attempt)).rejects.toMatchObject({
      name: 'WorkspaceAccessError',
      code: 'insufficient-role',
    });
    expect(attempt.uploadedPaths).toEqual([]);
  });

  it('workspace mode + recoverable failure ⇒ warn-and-unchanged (no abort)', async () => {
    installFakeStorage({ userId: USER, outcomes: [RECOVERABLE] });
    const failing = card(PNG_DATA_URL);
    // Programme 28 note (2026-11-07): attempt ledger is now a
    // required argument; explicit empty ledger, asserted behaviour
    // unchanged.
    const out = await processCardImages([failing], wsMember(WS_A), { uploadedPaths: [] });
    expect(out[0]).toBe(failing);
    expect(out[0]?.cardImage).toBe(PNG_DATA_URL);
    expect(console.warn).toHaveBeenCalled();
  });

  it('legacy mode + denial-SHAPED error ⇒ still warn-and-unchanged (legacy never aborts)', async () => {
    installFakeStorage({ userId: USER, outcomes: [DENIAL_RLS] });
    const failing = card(PNG_DATA_URL);
    // Programme 28 note (2026-11-07): attempt ledger is now a
    // required argument; explicit empty ledger, asserted behaviour
    // unchanged.
    const out = await processCardImages([failing], { kind: 'legacy' }, { uploadedPaths: [] });
    expect(out[0]).toBe(failing);
    expect(console.warn).toHaveBeenCalled();
  });

  it('the ledger records exactly the successful uploads of the attempt', async () => {
    const storage = installFakeStorage({ userId: USER, outcomes: ['ok', RECOVERABLE, 'ok'] });
    const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
    const second = { ...card(JPG_DATA_URL), id: 'r-card-2' };
    const third = { ...card(PNG_DATA_URL), id: 'r-card-3' };
    await processCardImages([card(PNG_DATA_URL), second, third], { kind: 'legacy' }, attempt);
    expect(storage.uploads).toHaveLength(3);
    expect(attempt.uploadedPaths).toEqual([storage.uploads[0], storage.uploads[2]]);
  });

  it('on a denial abort, uploads that already succeeded in the attempt are in the ledger for cleanup', async () => {
    const storage = installFakeStorage({ userId: USER, outcomes: ['ok', DENIAL_RLS] });
    const attempt: CardImageUploadAttempt = { uploadedPaths: [] };
    const second = { ...card(JPG_DATA_URL), id: 'r-card-2' };
    await expect(processCardImages([card(PNG_DATA_URL), second], wsMember(WS_A), attempt)).rejects.toMatchObject({
      code: 'insufficient-role',
    });
    expect(attempt.uploadedPaths).toEqual([storage.uploads[0]]);
  });
});

describe('removeUploadedCardImages (attempt cleanup)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no paths ⇒ no storage call at all', async () => {
    const storage = installFakeStorage({ userId: USER, outcomes: [] });
    await removeUploadedCardImages([]);
    expect(storage.fromCalls).toBe(0);
  });

  it('deletes exactly the recorded paths and resolves', async () => {
    const storage = installFakeStorage({ userId: USER, outcomes: [] });
    await removeUploadedCardImages(['a/1.png', 'a/2.jpg']);
    expect(storage.removed).toEqual([['a/1.png', 'a/2.jpg']]);
  });

  it('a storage error from remove is logged, never thrown (never masks the mutation error)', async () => {
    installFakeStorage({ userId: USER, outcomes: [], removeError: { message: 'denied by policy' } });
    await expect(removeUploadedCardImages(['a/1.png'])).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('a transport throw from remove is logged, never thrown', async () => {
    installFakeStorage({ userId: USER, outcomes: [], removeThrows: true });
    await expect(removeUploadedCardImages(['a/1.png'])).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('source pins — builder flow wiring', () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
  const automationsSrc = read('src/hooks/useAutomations.ts');
  const accountsSrc = read('src/hooks/useInstagramAccounts.ts');
  const postsSrc = read('src/hooks/useInstagramPosts.ts');
  const contactsSrc = read('src/hooks/useContacts.ts');

  it('useAutomations: all five hooks route through sendWorkspaceRequest; no direct apiClient call remains', () => {
    const occurrences = automationsSrc.split('sendWorkspaceRequest').length - 1;
    // import + list + create + toggle + delete + update
    expect(occurrences).toBeGreaterThanOrEqual(6);
    expect(automationsSrc).not.toContain('apiClient<');
    expect(automationsSrc).not.toContain('apiClient(');
  });

  it('useAutomations: create and update resolve ONE captured context and run the attempt cleanup', () => {
    for (const hook of ['useCreateAutomation', 'useUpdateAutomation']) {
      const start = automationsSrc.indexOf(`export function ${hook}`);
      const next = automationsSrc.indexOf('export function ', start + 10);
      const body = automationsSrc.slice(start, next === -1 ? undefined : next);
      expect(body).toContain('useAutomationWorkspaceContext()');
      expect(body).toContain('const { uploadScope, requestScope }');
      expect(body).toContain('processCardImages(');
      expect(body).toContain('uploadScope, attempt');
      expect(body).toContain('sendWorkspaceRequest');
      expect(body).toContain('removeUploadedCardImages(attempt.uploadedPaths)');
    }
  });

  it('processCardImages: the scope argument is REQUIRED (no legacy default remains)', () => {
    expect(automationsSrc).toContain('scope: CardImageUploadScope,');
    expect(automationsSrc).not.toContain("scope: CardImageUploadScope = { kind: 'legacy' }");
  });

  it('useAutomations: the workspace list cache key names the workspace; the legacy key is untouched', () => {
    expect(automationsSrc).toContain("? ['automations', accountId ?? 'all', requestScope.workspaceId]");
    expect(automationsSrc).toContain(": ['automations', accountId ?? 'all']");
  });

  it('useInstagramAccounts: all account hooks route through sendWorkspaceRequest; no direct apiClient call remains (Programme 28)', () => {
    expect(accountsSrc).toContain('sendWorkspaceRequest');
    expect(accountsSrc).toContain("? ['instagram-accounts', requestScope.workspaceId]");
    // Programme 28 note (2026-11-07): the disposition changed — P27
    // finding B-7 (settings-surface selector gap) is now CLOSED.
    // Refresh / resubscribe / subscription-status previously stayed
    // on plain apiClient by deliberate P27 scope boundary; they now
    // route through sendWorkspaceRequest like the account read.
    expect(accountsSrc).toContain('useRefreshInstagramToken');
    expect(accountsSrc).not.toContain('apiClient<');
    expect(accountsSrc).not.toContain('apiClient(');
    expect(accountsSrc.split('sendWorkspaceRequest').length - 1).toBeGreaterThanOrEqual(5);
  });

  it('useInstagramPosts: the builder post picker is scoped, with a workspace-named cache key', () => {
    expect(postsSrc).toContain('sendWorkspaceRequest');
    // Refresh nonce (2026-11-13): the picker Refresh button bumps a
    // nonce in the key so the refetch carries `refresh=1` past the
    // server's 5-minute cache. The scope invariant is unchanged — the
    // workspace key still names the workspace, the legacy key still
    // does not.
    expect(postsSrc).toContain("? ['instagram-posts', accountId, requestScope.workspaceId, refreshNonce]");
    expect(postsSrc).toContain(": ['instagram-posts', accountId, refreshNonce]");
    expect(postsSrc).not.toContain('apiClient');
  });

  it('useContacts: the audience read is scoped, with a workspace-named cache key (follow-up to the flakiness round)', () => {
    // The flakiness round gated this hook on the resolved scope but
    // deliberately left its transport unscoped; GET /api/contacts is
    // workspace-aware, so in workspace mode the unscoped read 400'd
    // workspace-context-required. It now follows the sibling pattern.
    expect(contactsSrc).toContain('sendWorkspaceRequest');
    expect(contactsSrc).toContain('sendWorkspaceRequest<{ contacts: ContactFromDB[] }>');
    expect(contactsSrc).toContain("? ['contacts', accountId ?? 'all', requestScope.workspaceId]");
    expect(contactsSrc).toContain(": ['contacts', accountId ?? 'all']");
    expect(contactsSrc).not.toContain('apiClient<');
    expect(contactsSrc).not.toContain('apiClient(');
  });

  it('clientRequest: the selector convention matches the server (header name + typed error)', () => {
    const src = read('src/lib/tenancy/clientRequest.ts');
    // Programme 28 note (2026-11-07): the merge is now
    // Headers-normalized (Iteration-5 §2) — the selector is set on a
    // `new Headers(options?.headers)` instead of an object-literal
    // Record spread, which corrupted Headers/tuple-array inputs.
    expect(src).toContain('new Headers(options?.headers)');
    expect(src).toContain("headers.set('x-workspace-id', scope.workspaceId)");
    expect(src).toContain('WorkspaceAccessError');
    expect(src).toContain("'workspace-context-required'");
  });
});
