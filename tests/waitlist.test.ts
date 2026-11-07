/**
 * Waitlist (preview launch preparation, 2026-11-07).
 *
 * POST /api/waitlist is the single write path into waitlist_entries.
 * The route is exercised here with the service-role client factory
 * mocked — no real database, no real credentials. The migration is
 * pinned for its access shape: RLS on, and NO grant to anon or
 * authenticated (the service role is the only reader/writer).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => ({ insert: mocks.insert }),
  }),
}));

import { POST } from '@/app/api/waitlist/route';
import { normalizeWaitlistEmail } from '@/lib/waitlist';

function postReq(body: unknown, ip: string): Request {
  return new Request('https://app.opendm.in/api/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.insert.mockReset();
  mocks.insert.mockResolvedValue({ error: null });
});

describe('normalizeWaitlistEmail', () => {
  it('trims and lowercases a valid address', () => {
    expect(normalizeWaitlistEmail('  Person@Example.COM ')).toBe('person@example.com');
  });
  it('rejects non-strings and malformed addresses', () => {
    expect(normalizeWaitlistEmail(undefined)).toBeNull();
    expect(normalizeWaitlistEmail(42)).toBeNull();
    expect(normalizeWaitlistEmail('')).toBeNull();
    expect(normalizeWaitlistEmail('not-an-email')).toBeNull();
    expect(normalizeWaitlistEmail('a@b')).toBeNull();
    expect(normalizeWaitlistEmail('a b@example.com')).toBeNull();
  });
});

describe('POST /api/waitlist', () => {
  it('stores a normalized email and reports a fresh join', async () => {
    const res = await POST(postReq({ email: ' Person@Example.com ' }, '203.0.113.11'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyOnList: false });
    expect(mocks.insert).toHaveBeenCalledWith({ email: 'person@example.com', source: 'landing' });
  });

  it('treats a duplicate address as already on the list, not an error', async () => {
    mocks.insert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
    const res = await POST(postReq({ email: 'dup@example.com' }, '203.0.113.12'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyOnList: true });
  });

  it('rejects an invalid email with 400 and writes nothing', async () => {
    const res = await POST(postReq({ email: 'nope' }, '203.0.113.13'));
    expect(res.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await POST(postReq('{oops', '203.0.113.14'));
    expect(res.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('reports 500 when the insert fails for a non-duplicate reason', async () => {
    mocks.insert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });
    const res = await POST(postReq({ email: 'x@example.com' }, '203.0.113.15'));
    expect(res.status).toBe(500);
  });

  it('keeps an explicit source label, capped and defaulted', async () => {
    const res = await POST(postReq({ email: 's@example.com', source: 'landing-final-cta' }, '203.0.113.16'));
    expect(res.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith({ email: 's@example.com', source: 'landing-final-cta' });
  });
});

describe('waitlist migration access shape', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '..', 'supabase', 'migrations', '20260730000034_waitlist.sql'),
    'utf8',
  );
  it('creates the table with RLS enabled', () => {
    expect(sql).toContain('waitlist_entries');
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });
  it('grants nothing to anon or authenticated — service role only', () => {
    // Anchored at statement starts so the migration's own prose about
    // granting nothing cannot trip the pin.
    expect(sql).not.toMatch(/^\s*GRANT\s[^;]*\bTO\s+(anon|authenticated)\b/im);
    expect(sql).toMatch(/GRANT ALL ON public\.waitlist_entries TO service_role/);
  });
});
