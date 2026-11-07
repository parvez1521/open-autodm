/**
 * Typed API client for the app's own /api routes (same origin).
 * Attaches the current Supabase JWT as a Bearer token.
 */

import { createBrowserClient } from '@/lib/supabase/clients';

const API_URL = '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error?: string; message?: string; details?: unknown }
  ) {
    super(body.message ?? body.error ?? `API error ${status}`);
    this.name = 'ApiError';
  }
}

export async function apiClient<T>(path: string, options?: RequestInit & { skipAuth?: boolean }): Promise<T> {
  // Headers-normalized construction (Programme 28): `new Headers(...)`
  // preserves plain-object, Headers-instance and tuple-array inputs
  // without corruption (the previous Record spread destroyed the
  // latter two). Observable precedence is preserved:
  // - Content-Type: the JSON default applies only when a body exists
  //   and the caller did not supply a Content-Type (caller wins).
  //   Bodyless requests get no JSON Content-Type — some runtimes
  //   would otherwise try to parse an empty body.
  // - Authorization: set after caller headers, so it wins when a
  //   session token exists and auth is not skipped.
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (!options?.skipAuth) {
    const supabase = createBrowserClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      headers.set('Authorization', `Bearer ${session.access_token}`);
    }
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = (await res.json()) as { error?: string; message?: string };
    } catch {
      // ignore parse errors
    }
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}
