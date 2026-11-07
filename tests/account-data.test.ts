/**
 * Areas 2 & 3 (library level) — deauthorize + data-deletion data operations
 * (src/lib/meta/accountData.ts) against an in-memory fake Supabase client.
 * Route-level behaviour is covered in meta-callbacks.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findConnectedAccountByIgId,
  deleteConnectedAccount,
  deleteAudienceData,
  getOrCreateDeletionRequest,
  processDeletionRequest,
  findDeletionRequestByCode,
  generateConfirmationCode,
  type DeletionRequestRow,
} from '@/lib/meta/accountData';
import { FakeSupabase, type FakeRow } from './helpers/fakeSupabase';

let fake: FakeSupabase;
let db: SupabaseClient;

const ACCOUNT: FakeRow = {
  id: 'acct-1',
  user_id: 'operator-1',
  instagram_user_id: 'IG-OWNER',
  username: 'creator',
};

function seedAudience(igId: string, otherIgId = 'IG-OTHER'): void {
  fake.seed('contacts', [
    { id: 'c1', audience_ig_user_id: igId },
    { id: 'c2', audience_ig_user_id: igId },
    { id: 'c3', audience_ig_user_id: otherIgId },
  ]);
  fake.seed('automation_sessions', [{ id: 's1', audience_ig_user_id: igId }]);
  fake.seed('dm_sent_log', [{ id: 'l1', trigger_user_id: igId }]);
  fake.seed('dm_jobs', [
    { id: 'j1', trigger_user_id: igId },
    { id: 'j2', trigger_user_id: otherIgId },
  ]);
  fake.seed('job_queue', [
    { id: 'q1', status: 'pending', payload: { triggerUserId: igId } },
    { id: 'q2', status: 'done', payload: { triggerUserId: igId } },
    { id: 'q3', status: 'processing', payload: { triggerUserId: igId } },
    { id: 'q4', status: 'pending', payload: { triggerUserId: otherIgId } },
  ]);
}

beforeEach(() => {
  fake = new FakeSupabase();
  db = fake as unknown as SupabaseClient;
});

describe('connected account lookup + deletion (deauthorize core)', () => {
  it('finds a connected account by IG id, and returns null for unknown ids', async () => {
    fake.seed('instagram_accounts', [ACCOUNT]);
    expect(await findConnectedAccountByIgId(db, 'IG-OWNER')).toMatchObject({ id: 'acct-1' });
    expect(await findConnectedAccountByIgId(db, 'IG-UNKNOWN')).toBeNull();
  });

  it('deletes the account row exactly once, double-scoped by PK and IG id', async () => {
    fake.seed('instagram_accounts', [ACCOUNT]);
    const account = await findConnectedAccountByIgId(db, 'IG-OWNER');
    await deleteConnectedAccount(db, account!);

    expect(fake.rows('instagram_accounts')).toHaveLength(0);
    const deleteCalls = fake.callsFor('instagram_accounts', 'delete');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.filters).toEqual(
      expect.arrayContaining([
        { column: 'id', op: 'eq', value: 'acct-1' },
        { column: 'instagram_user_id', op: 'eq', value: 'IG-OWNER' },
      ])
    );

    // Duplicate deauthorize: no row left, second delete is a harmless no-op.
    const again = await findConnectedAccountByIgId(db, 'IG-OWNER');
    expect(again).toBeNull();
  });
});

describe('deleteAudienceData', () => {
  it("deletes only the target IGSID's rows, in every audience table", async () => {
    seedAudience('IG-FAN');
    const counts = await deleteAudienceData(db, 'IG-FAN');

    expect(counts).toEqual({
      contacts: 2,
      automationSessions: 1,
      dmSentLog: 1,
      dmJobs: 1,
      queuedJobs: 2, // pending + processing only; the done row is queue history
      total: 7,
    });

    // The other person's rows survive untouched.
    expect(fake.rows('contacts').map((r) => r['id'])).toEqual(['c3']);
    expect(fake.rows('dm_jobs').map((r) => r['id'])).toEqual(['j2']);
    expect(fake.rows('job_queue').map((r) => r['id'])).toEqual(['q2', 'q4']);
  });

  it('scopes the job_queue delete by payload triggerUserId AND live statuses', async () => {
    seedAudience('IG-FAN');
    await deleteAudienceData(db, 'IG-FAN');
    const queueDelete = fake.callsFor('job_queue', 'delete')[0]!;
    expect(queueDelete.filters).toEqual(
      expect.arrayContaining([
        { column: 'payload->>triggerUserId', op: 'filter', value: 'IG-FAN' },
        { column: 'status', op: 'in', value: ['pending', 'processing'] },
      ])
    );
  });

  it('is idempotent: a second sweep deletes nothing and does not throw', async () => {
    seedAudience('IG-FAN');
    await deleteAudienceData(db, 'IG-FAN');
    const second = await deleteAudienceData(db, 'IG-FAN');
    expect(second.total).toBe(0);
  });
});

describe('generateConfirmationCode', () => {
  it('produces 16-char codes from the unambiguous alphabet (no 0/O/1/l/I)', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateConfirmationCode();
      expect(code).toHaveLength(16);
      expect(code).not.toMatch(/[0O1lI]/);
    }
  });
});

describe('deletion request records + workflow', () => {
  it('creates a request with status received and a fresh code', async () => {
    const { row, created } = await getOrCreateDeletionRequest(db, 'IG-OWNER');
    expect(created).toBe(true);
    expect(row.status).toBe('received');
    expect(row.confirmation_code).toHaveLength(16);
    expect(row.meta_user_id).toBe('IG-OWNER');
  });

  it('reuses the same record + confirmation code for a duplicate request (Meta retry)', async () => {
    const first = await getOrCreateDeletionRequest(db, 'IG-OWNER');
    const second = await getOrCreateDeletionRequest(db, 'IG-OWNER');
    expect(second.created).toBe(false);
    expect(second.row.confirmation_code).toBe(first.row.confirmation_code);
    expect(fake.rows('data_deletion_requests')).toHaveLength(1);
  });

  it('starts a fresh record when the only prior request failed', async () => {
    fake.seed('data_deletion_requests', [
      {
        id: 'req-old',
        meta_user_id: 'IG-OWNER',
        confirmation_code: 'OLDFailedCode123',
        status: 'failed',
        account_id: null,
        operator_user_id: null,
        error: 'boom',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      },
    ]);
    const { row, created } = await getOrCreateDeletionRequest(db, 'IG-OWNER');
    expect(created).toBe(true);
    expect(row.confirmation_code).not.toBe('OLDFailedCode123');
  });

  it('owner-account path: processes to completed and deletes the account', async () => {
    fake.seed('instagram_accounts', [ACCOUNT]);
    const { row } = await getOrCreateDeletionRequest(db, 'IG-OWNER');
    const processed = await processDeletionRequest(db, row);
    expect(processed.status).toBe('completed');
    expect(fake.rows('instagram_accounts')).toHaveLength(0);
    const stored = await findDeletionRequestByCode(db, row.confirmation_code);
    expect(stored?.status).toBe('completed');
    expect(stored?.completed_at).toBeTruthy();
    expect(stored?.operator_user_id).toBe('operator-1');
  });

  it('audience path: completes using only the audience sweep (no account row)', async () => {
    seedAudience('IG-FAN');
    const { row } = await getOrCreateDeletionRequest(db, 'IG-FAN');
    const processed = await processDeletionRequest(db, row);
    expect(processed.status).toBe('completed');
    expect(fake.callsFor('instagram_accounts', 'delete')).toHaveLength(0);
  });

  it('unknown user: resolves to not_found, deletes nothing', async () => {
    seedAudience('IG-FAN');
    const { row } = await getOrCreateDeletionRequest(db, 'IG-GHOST');
    const processed = await processDeletionRequest(db, row);
    expect(processed.status).toBe('not_found');
    expect(fake.rows('contacts')).toHaveLength(3);
  });

  it('re-processing an already-completed request keeps it completed', async () => {
    fake.seed('instagram_accounts', [ACCOUNT]);
    const { row } = await getOrCreateDeletionRequest(db, 'IG-OWNER');
    const first = await processDeletionRequest(db, row);
    const second = await processDeletionRequest(db, first as DeletionRequestRow);
    expect(second.status).toBe('completed');
  });

  it('marks the record failed (and rethrows) when processing errors', async () => {
    fake.seed('instagram_accounts', [ACCOUNT]);
    const { row } = await getOrCreateDeletionRequest(db, 'IG-OWNER');
    // A client whose instagram_accounts lookup fails (DB outage): the
    // workflow must mark the durable record failed, not lose the request.
    const badDb = {
      from: (table: string) => {
        if (table === 'instagram_accounts') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: { message: 'db down' } }),
              }),
            }),
          };
        }
        return fake.from(table);
      },
    } as unknown as SupabaseClient;
    await expect(processDeletionRequest(badDb, row)).rejects.toThrow('db down');
    const stored = await findDeletionRequestByCode(db, row.confirmation_code);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('db down');
  });
});
