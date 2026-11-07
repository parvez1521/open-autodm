/**
 * Programme 28 — §2 (Headers merge) + §4 (settings selector gap B-7).
 *
 * §2: P27's `sendWorkspaceRequest` merged the workspace selector by
 * spreading `options.headers` as a plain Record, which corrupts
 * `Headers` instances and tuple-array `HeadersInit`. The real
 * transport (`apiClient`) had the same spread defect, so a `Headers`
 * object passed through would have been destroyed before `fetch`.
 * Both are now Headers-normalized:
 *   - clientRequest workspace branch: `new Headers(options?.headers)`
 *     + `headers.set('x-workspace-id', scope.workspaceId)`.
 *   - apiClient: `new Headers(options?.headers)`, JSON Content-Type
 *     default only when a body exists and the caller supplied none
 *     (caller wins), Authorization set after (it wins).
 * Legacy branch remains `client(path, options)` by reference.
 *
 * §4: the three account-admin hooks in useInstagramAccounts.ts
 * (refresh / resubscribe / subscription-status — P27 finding B-7)
 * now route through `sendWorkspaceRequest` with the file's existing
 * `useWorkspaceRequestScope()`, preserving exact legacy call shapes.
 *
 * Tier note (honest): sendWorkspaceRequest tests are unit-tier with
 * a fake transport (mirroring p27). apiClient tests ARE unit-tier
 * against the real client here — a practical seam exists (mock
 * `@/lib/supabase/clients` session + mock global `fetch`) — and are
 * supplemented by source pins. Hook wiring is verified by SOURCE
 * PINS, not runtime integration, per codebase convention (no JSX /
 * React rendering in this suite).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/supabase/clients', () => ({ createBrowserClient: vi.fn() }));

import { createBrowserClient } from '@/lib/supabase/clients';
import { apiClient } from '@/lib/api/client';
import {
  sendWorkspaceRequest,
  type WorkspaceRequestClient,
  type WorkspaceRequestScope,
} from '@/lib/tenancy/clientRequest';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '33333333-3333-4333-8333-333333333333';

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

function headersOf(options?: RequestInit): Headers {
  const h = options?.headers;
  expect(h).toBeInstanceOf(Headers);
  return h as Headers;
}

describe('sendWorkspaceRequest — Headers-normalized merge (workspace mode)', () => {
  it('(a) plain-object headers: entries preserved, selector set, scope wins over caller x-workspace-id', async () => {
    const { calls, client } = fakeClient();
    await sendWorkspaceRequest(
      wsA,
      '/automations',
      {
        method: 'POST',
        body: '{}',
        headers: { 'x-custom': 'kept', 'content-type': 'text/plain', 'x-workspace-id': WS_B },
      },
      client,
    );
    expect(calls).toHaveLength(1);
    const headers = headersOf(calls[0]!.options);
    expect(headers.get('x-custom')).toBe('kept');
    expect(headers.get('content-type')).toBe('text/plain');
    expect(headers.get('x-workspace-id')).toBe(WS_A);
    expect(calls[0]!.options?.method).toBe('POST');
    expect(calls[0]!.options?.body).toBe('{}');
  });

  it('(b) Headers instance input: its entries survive, selector set', async () => {
    const { calls, client } = fakeClient();
    const input = new Headers({ 'x-custom': 'from-instance', 'x-other': 'yes' });
    await sendWorkspaceRequest(wsA, '/automations', { method: 'PUT', headers: input }, client);
    expect(calls).toHaveLength(1);
    const headers = headersOf(calls[0]!.options);
    expect(headers.get('x-custom')).toBe('from-instance');
    expect(headers.get('x-other')).toBe('yes');
    expect(headers.get('x-workspace-id')).toBe(WS_A);
    // The caller's Headers object is not mutated by the merge.
    expect(input.get('x-workspace-id')).toBeNull();
  });

  it('(c) tuple-array input: entries survive, selector set', async () => {
    const { calls, client } = fakeClient();
    await sendWorkspaceRequest(
      wsA,
      '/automations',
      { method: 'POST', headers: [['x-a', '1'], ['x-b', '2']] },
      client,
    );
    expect(calls).toHaveLength(1);
    const headers = headersOf(calls[0]!.options);
    expect(headers.get('x-a')).toBe('1');
    expect(headers.get('x-b')).toBe('2');
    expect(headers.get('x-workspace-id')).toBe(WS_A);
  });

  it('workspace mode with no caller headers: only the selector is present', async () => {
    const { calls, client } = fakeClient();
    await sendWorkspaceRequest(wsA, '/automations', { method: 'DELETE' }, client);
    const headers = headersOf(calls[0]!.options);
    expect(headers.get('x-workspace-id')).toBe(WS_A);
  });
});

describe('sendWorkspaceRequest — legacy passthrough', () => {
  it('options object passes through by reference even when it carries headers', async () => {
    const { calls, client } = fakeClient();
    const options: RequestInit = {
      method: 'POST',
      body: '{}',
      headers: { 'x-custom': 'kept', 'x-workspace-id': WS_B },
    };
    await sendWorkspaceRequest(legacy, '/automations', options, client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toBe(options);
    expect(calls[0]!.options?.headers).toBe(options.headers);
  });

  it('a Headers instance in legacy mode also passes through untouched by reference', async () => {
    const { calls, client } = fakeClient();
    const input = new Headers({ 'x-custom': 'kept' });
    const options: RequestInit = { method: 'GET', headers: input };
    await sendWorkspaceRequest(legacy, '/instagram/accounts', options, client);
    expect(calls[0]!.options).toBe(options);
    expect(calls[0]!.options?.headers).toBe(input);
    expect(input.get('x-workspace-id')).toBeNull();
  });
});

describe('apiClient — Headers survive to fetch (real client, mocked session + fetch)', () => {
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  function sessionWith(token: string | null) {
    vi.mocked(createBrowserClient).mockReturnValue({
      auth: {
        getSession: async () => ({
          data: { session: token ? { access_token: token } : null },
        }),
      },
    } as unknown as ReturnType<typeof createBrowserClient>);
  }

  beforeEach(() => {
    fetchCalls.length = 0;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    sessionWith('tok-123');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a Headers instance passed by the caller reaches fetch intact, plus Authorization and JSON Content-Type', async () => {
    const input = new Headers({ 'x-custom': 'kept', 'x-workspace-id': WS_A });
    await apiClient('/automations', { method: 'POST', body: '{}', headers: input });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('/api/automations');
    const headers = headersOf(fetchCalls[0]!.init);
    expect(headers.get('x-custom')).toBe('kept');
    expect(headers.get('x-workspace-id')).toBe(WS_A);
    expect(headers.get('authorization')).toBe('Bearer tok-123');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('tuple-array headers reach fetch intact', async () => {
    await apiClient('/automations', { headers: [['x-a', '1'], ['x-b', '2']] });
    const headers = headersOf(fetchCalls[0]!.init);
    expect(headers.get('x-a')).toBe('1');
    expect(headers.get('x-b')).toBe('2');
    expect(headers.get('authorization')).toBe('Bearer tok-123');
    // No body ⇒ no JSON Content-Type default.
    expect(headers.get('content-type')).toBeNull();
  });

  it('caller-supplied Content-Type wins over the JSON default', async () => {
    await apiClient('/automations', {
      method: 'POST',
      body: 'plain',
      headers: { 'Content-Type': 'text/plain' },
    });
    const headers = headersOf(fetchCalls[0]!.init);
    expect(headers.get('content-type')).toBe('text/plain');
  });

  it('Authorization wins over a caller-supplied Authorization header', async () => {
    await apiClient('/automations', { headers: { Authorization: 'Bearer stale' } });
    const headers = headersOf(fetchCalls[0]!.init);
    expect(headers.get('authorization')).toBe('Bearer tok-123');
  });

  it('skipAuth: no Authorization is attached and no session is consulted for it', async () => {
    await apiClient('/automations', { skipAuth: true } as RequestInit & { skipAuth?: boolean });
    const headers = headersOf(fetchCalls[0]!.init);
    expect(headers.get('authorization')).toBeNull();
  });

  it('no session token: no Authorization header is attached', async () => {
    sessionWith(null);
    await apiClient('/automations');
    const headers = headersOf(fetchCalls[0]!.init);
    expect(headers.get('authorization')).toBeNull();
  });
});

describe('source pins — apiClient Headers construction', () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
  const clientSrc = read('src/lib/api/client.ts');
  const requestSrc = read('src/lib/tenancy/clientRequest.ts');

  it('apiClient builds headers via new Headers(options?.headers)', () => {
    expect(clientSrc).toContain('new Headers(options?.headers)');
    expect(clientSrc).toContain("!headers.has('Content-Type')");
    expect(clientSrc).toContain("headers.set('Content-Type', 'application/json')");
    expect(clientSrc).toContain("headers.set('Authorization'");
  });

  it('no Record spread of options headers remains in either file', () => {
    expect(clientSrc).not.toContain('options?.headers as Record');
    expect(clientSrc).not.toContain('...(options?.headers');
    expect(requestSrc).not.toContain('options?.headers as Record');
    expect(requestSrc).not.toContain('...(options?.headers');
  });

  it('clientRequest workspace branch is Headers-normalized; legacy branch is the exact passthrough', () => {
    expect(requestSrc).toContain('const headers = new Headers(options?.headers);');
    expect(requestSrc).toContain("headers.set('x-workspace-id', scope.workspaceId);");
    expect(requestSrc).toContain('return client<T>(path, { ...options, headers });');
    expect(requestSrc).toContain("if (scope.kind === 'legacy') return client<T>(path, options);");
  });
});

describe('source pins — settings selector wiring (B-7 closed)', () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
  const accountsSrc = read('src/hooks/useInstagramAccounts.ts');

  function hookBody(name: string): string {
    const start = accountsSrc.indexOf(`export function ${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = accountsSrc.indexOf('export function ', start + 10);
    return accountsSrc.slice(start, next === -1 ? undefined : next);
  }

  it('useInstagramAccounts.ts contains no direct apiClient call', () => {
    expect(accountsSrc).not.toContain('apiClient<');
    expect(accountsSrc).not.toContain('apiClient(');
  });

  it('useRefreshInstagramToken routes through sendWorkspaceRequest with its exact path and POST shape', () => {
    const body = hookBody('useRefreshInstagramToken');
    expect(body).toContain('useWorkspaceRequestScope()');
    expect(body).toContain('sendWorkspaceRequest');
    expect(body).toContain('`/instagram/refresh/${accountId}`');
    expect(body).toContain("{ method: 'POST' }");
    // Return / invalidation behaviour preserved.
    expect(body).toContain("invalidateQueries({ queryKey: ['instagram-accounts'] })");
  });

  it('useResubscribeWebhook routes through sendWorkspaceRequest with its exact path and POST shape', () => {
    const body = hookBody('useResubscribeWebhook');
    expect(body).toContain('useWorkspaceRequestScope()');
    expect(body).toContain('sendWorkspaceRequest');
    expect(body).toContain('`/instagram/resubscribe/${accountId}`');
    expect(body).toContain("{ method: 'POST' }");
  });

  it('useCheckSubscription routes through sendWorkspaceRequest with its exact path and NO options argument', () => {
    const body = hookBody('useCheckSubscription');
    expect(body).toContain('useWorkspaceRequestScope()');
    expect(body).toContain('sendWorkspaceRequest');
    expect(body).toContain('`/instagram/subscription-status/${accountId}`');
    // Legacy shape preserved: the pre-P28 call passed no options, so
    // the scoped call must not invent a method/body either.
    expect(body).not.toContain("method: 'POST'");
    expect(body).not.toContain("method: 'GET'");
    expect(body).not.toContain('body:');
  });

  it('all four account hooks (read + three mutations) route through sendWorkspaceRequest', () => {
    // import + read + refresh + resubscribe + subscription-status
    expect(accountsSrc.split('sendWorkspaceRequest').length - 1).toBeGreaterThanOrEqual(5);
    for (const hook of [
      'useInstagramAccounts',
      'useRefreshInstagramToken',
      'useResubscribeWebhook',
      'useCheckSubscription',
    ]) {
      expect(hookBody(hook)).toContain('sendWorkspaceRequest');
    }
  });
});
