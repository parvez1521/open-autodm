/**
 * In-memory fake of the small slice of the Supabase PostgREST query-builder
 * API that the code under test uses. NO real database, NO network.
 *
 * Supports: select / insert / update / delete / upsert chains with
 * eq / neq / in / filter / lte / order / limit, awaited directly (thenable)
 * or terminated with .maybeSingle() / .single(). Every executed statement
 * is recorded in `fake.calls` so tests can assert on the exact filters an
 * operation carried (tenant-scoping assertions).
 *
 * Phase 5 additions (additive — the Phase 2 suite is unaffected):
 *  - `fake.rpc(name, params)` with table-backed defaults for the RPCs the
 *    restored automation code calls (suppression, rate limit, counters,
 *    contacts, traffic guard). Tests may override any RPC via
 *    `setRpcHandler`, e.g. to simulate a lookup failure (fail-closed tests).
 *  - `fake.failNextQuery(table, error)` makes the NEXT builder statement
 *    against that table resolve with an error (DB-blip simulation).
 *  - update(...).select() returns the updated rows, as PostgREST does —
 *    the follow-up atomic claim depends on it.
 *  - upsert honours the `onConflict` column list when one is supplied.
 *
 * Phase 6 additions (additive): table-backed defaults for the eight
 * comment-reservation RPCs (reserve/confirm/release/mark-failed ×
 * private/public), implementing the real SQL semantics — UNIQUE
 * (account, comment) conflict, automation/account pair validation, and
 * the 10-minute fail-closed stale transition.
 */

import { randomUUID } from 'node:crypto';

export type FakeRow = Record<string, unknown>;

export interface FakeDbError {
  message: string;
  code?: string;
}

export interface RecordedFilter {
  column: string;
  op: 'eq' | 'neq' | 'in' | 'filter' | 'lte';
  value: unknown;
}

export interface RpcResult {
  data: unknown;
  error: FakeDbError | null;
}

export type RpcHandler = (
  params: Record<string, unknown>,
  fake: FakeSupabase
) => RpcResult | Promise<RpcResult>;

export interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  filters: RecordedFilter[];
  payload: FakeRow | null;
  countOption: string | null;
}

interface QueryResult {
  data: unknown;
  error: FakeDbError | null;
  count: number | null;
}

const ok = (data: unknown, count: number | null = null): QueryResult => ({ data, error: null, count });
const fail = (error: FakeDbError): QueryResult => ({ data: null, error, count: null });

function readColumn(row: FakeRow, column: string): unknown {
  // PostgREST JSONB path used by accountData: 'payload->>triggerUserId'
  const jsonb = /^(\w+)->>(\w+)$/.exec(column);
  if (jsonb) {
    const container = row[jsonb[1]!] as FakeRow | undefined;
    return container?.[jsonb[2]!];
  }
  return row[column];
}

function matches(row: FakeRow, filters: RecordedFilter[]): boolean {
  return filters.every((f) => {
    const actual = readColumn(row, f.column);
    switch (f.op) {
      case 'eq':
      case 'filter':
        return actual === f.value;
      case 'neq':
        return actual !== f.value;
      case 'in':
        return Array.isArray(f.value) && f.value.includes(actual);
      case 'lte':
        // ISO timestamps / dates compare correctly as strings.
        return actual !== null && actual !== undefined && String(actual) <= String(f.value);
    }
  });
}

class FakeBuilder implements PromiseLike<QueryResult> {
  private op: RecordedCall['op'] = 'select';
  private readonly filters: RecordedFilter[] = [];
  private payload: FakeRow | FakeRow[] | null = null;
  private countOption: string | null = null;
  private orderSpec: { column: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private wantsReturning = false;
  private conflictColumns: string[] | null = null;

  constructor(
    private readonly fake: FakeSupabase,
    private readonly table: string
  ) {}

  select(_columns?: string): this {
    // After insert(), PostgREST chains .select() to return the row - the op
    // stays 'insert' and single()/maybeSingle() resolve the inserted row.
    // After update()/upsert(), .select() returns the affected rows.
    if (this.op === 'update' || this.op === 'upsert') this.wantsReturning = true;
    return this;
  }

  insert(row: FakeRow | FakeRow[]): this {
    this.op = 'insert';
    this.payload = row;
    return this;
  }

  update(patch: FakeRow): this {
    this.op = 'update';
    this.payload = patch;
    return this;
  }

  upsert(row: FakeRow, options?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.payload = row;
    if (options?.onConflict) {
      this.conflictColumns = options.onConflict.split(',').map((c) => c.trim());
    }
    return this;
  }

  delete(options?: { count?: string }): this {
    this.op = 'delete';
    this.countOption = options?.count ?? null;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ column, op: 'neq', value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push({ column, op: 'in', value: values });
    return this;
  }

  filter(column: string, operator: string, value: unknown): this {
    void operator; // only 'eq' is used by the code under test
    this.filters.push({ column, op: 'filter', value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ column, op: 'lte', value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderSpec = { column, ascending: options?.ascending ?? true };
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private matchingRows(): FakeRow[] {
    return this.fake.rows(this.table).filter((row) => matches(row, this.filters));
  }

  private record(): void {
    this.fake.calls.push({
      table: this.table,
      op: this.op,
      filters: [...this.filters],
      payload: Array.isArray(this.payload) ? null : this.payload,
      countOption: this.countOption,
    });
  }

  private execute(): QueryResult {
    this.record();
    const queryError = this.fake.consumeQueryError(this.table);
    if (queryError) return fail(queryError);
    switch (this.op) {
      case 'select': {
        let rows = this.matchingRows().map((r) => ({ ...r }));
        if (this.orderSpec) {
          const { column, ascending } = this.orderSpec;
          rows = rows.sort((a, b) => {
            const av = String(a[column] ?? '');
            const bv = String(b[column] ?? '');
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (this.limitN !== null) rows = rows.slice(0, this.limitN);
        return ok(rows);
      }
      case 'insert': {
        const injected = this.fake.consumeInsertError(this.table);
        if (injected) return fail(injected);
        const now = new Date().toISOString();
        const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
        let first: FakeRow | null = null;
        for (const p of payloads) {
          const row: FakeRow = {
            id: randomUUID(),
            created_at: now,
            updated_at: now,
            ...p,
          };
          this.fake.rows(this.table).push(row);
          first = first ?? row;
        }
        return ok(first);
      }
      case 'upsert': {
        const payload = (Array.isArray(this.payload) ? this.payload[0] : this.payload) ?? {};
        const rows = this.fake.rows(this.table);
        const existing = this.conflictColumns
          ? rows.find((r) => this.conflictColumns!.every((c) => r[c] === payload[c]))
          : rows.find((r) => r['id'] === payload['id']);
        if (existing) {
          Object.assign(existing, payload);
          return ok(this.wantsReturning ? { ...existing } : null);
        }
        rows.push({ ...payload });
        return ok(null);
      }
      case 'update': {
        const victims = this.matchingRows();
        for (const row of victims) Object.assign(row, this.payload ?? {});
        // PostgREST returns the updated rows when .select() was chained.
        return ok(this.wantsReturning ? victims.map((r) => ({ ...r })) : null);
      }
      case 'delete': {
        const victims = this.matchingRows();
        const keep = this.fake.rows(this.table).filter((r) => !victims.includes(r));
        this.fake.replaceRows(this.table, keep);
        return ok(null, this.countOption === 'exact' ? victims.length : null);
      }
    }
  }

  private executeSingle(): QueryResult {
    if (this.op === 'insert') return this.execute();
    const result = this.execute();
    if (result.error) return result;
    const rows = result.data as FakeRow[];
    return ok(rows[0] ?? null);
  }

  maybeSingle(): Promise<QueryResult> {
    return Promise.resolve(this.executeSingle());
  }

  single(): Promise<QueryResult> {
    return Promise.resolve(this.executeSingle());
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onFulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }
}

interface QueuedInsertError {
  error: FakeDbError;
  /** Row a "concurrent winner" commits at the moment our insert fails (race tests). */
  winnerRow?: FakeRow;
}

export class FakeSupabase {
  private readonly tables = new Map<string, FakeRow[]>();
  readonly calls: RecordedCall[] = [];
  private readonly insertErrors = new Map<string, QueuedInsertError[]>();
  private readonly queryErrors = new Map<string, FakeDbError[]>();
  private readonly rpcHandlers = new Map<string, RpcHandler>();

  rows(table: string): FakeRow[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  replaceRows(table: string, rows: FakeRow[]): void {
    this.tables.set(table, rows);
  }

  seed(table: string, rows: FakeRow[]): void {
    this.rows(table).push(...rows.map((r) => ({ ...r })));
  }

  /** Make the NEXT insert into `table` fail with the given error (e.g. a 23505 race). */
  failNextInsert(table: string, error: FakeDbError, winnerRow?: FakeRow): void {
    const queue = this.insertErrors.get(table) ?? [];
    queue.push({ error, winnerRow });
    this.insertErrors.set(table, queue);
  }

  consumeInsertError(table: string): FakeDbError | null {
    const queue = this.insertErrors.get(table);
    if (!queue || queue.length === 0) return null;
    const next = queue.shift();
    if (!next) return null;
    if (next.winnerRow) this.rows(table).push({ ...next.winnerRow });
    return next.error;
  }

  callsFor(table: string, op?: RecordedCall['op']): RecordedCall[] {
    return this.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
  }

  /** Make the NEXT builder statement against `table` resolve with `error`. */
  failNextQuery(table: string, error: FakeDbError): void {
    const queue = this.queryErrors.get(table) ?? [];
    queue.push(error);
    this.queryErrors.set(table, queue);
  }

  consumeQueryError(table: string): FakeDbError | null {
    const queue = this.queryErrors.get(table);
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  /** Override one RPC's behaviour (e.g. force an error for fail-closed tests). */
  setRpcHandler(name: string, handler: RpcHandler): void {
    this.rpcHandlers.set(name, handler);
  }

  clearRpcHandlers(): void {
    this.rpcHandlers.clear();
  }

  /**
   * Phase 6: in-memory implementation of the reservation RPC semantics
   * from migration 20260730000020 (release-prep …000004/…000005): atomic
   * insert-or-conflict on UNIQUE (instagram_account_id, comment_id),
   * cross-entity automation/account validation, and the fail-closed stale
   * rule (a 'reserved' row older than 10 minutes transitions to 'failed'
   * with reason 'stale_unconfirmed_abandoned' and is NEVER re-authorized).
   * Synchronous by design: two interleaved async callers cannot both win,
   * which is what makes the concurrency tests meaningful.
   */
  private reserveReply(
    table: string,
    params: Record<string, unknown>,
    inFlightReason: string
  ): RpcResult {
    const accountId = params['p_instagram_account_id'];
    const commentId = params['p_comment_id'];
    const automationId = params['p_automation_id'];

    const pairValid = this.rows('automations').some(
      (a) => a['id'] === automationId && a['instagram_account_id'] === accountId
    );
    if (!pairValid) {
      return {
        data: { authorized: false, status: 'error', reason: 'invalid_automation_account_pair' },
        error: null,
      };
    }

    const rows = this.rows(table);
    const existing = rows.find(
      (r) => r['instagram_account_id'] === accountId && r['comment_id'] === commentId
    );
    if (!existing) {
      rows.push({
        id: randomUUID(),
        instagram_account_id: accountId,
        comment_id: commentId,
        automation_id: automationId,
        status: 'reserved',
        reserved_at: new Date().toISOString(),
        sent_at: null,
        failed_at: null,
        failure_reason: null,
      });
      return { data: { authorized: true, status: 'reserved', reason: 'new_reservation' }, error: null };
    }
    if (existing['status'] === 'sent') {
      return { data: { authorized: false, status: 'sent', reason: 'already_sent' }, error: null };
    }
    if (existing['status'] === 'failed') {
      return { data: { authorized: false, status: 'failed', reason: 'previously_failed' }, error: null };
    }
    // status === 'reserved'
    const reservedAt = new Date(existing['reserved_at'] as string).getTime();
    if (reservedAt < Date.now() - 10 * 60 * 1000) {
      existing['status'] = 'failed';
      existing['failed_at'] = new Date().toISOString();
      existing['failure_reason'] = 'stale_unconfirmed_abandoned';
      return {
        data: { authorized: false, status: 'failed', reason: 'stale_unconfirmed_abandoned' },
        error: null,
      };
    }
    return { data: { authorized: false, status: 'reserved', reason: inFlightReason }, error: null };
  }

  /**
   * PostgREST RPC. Defaults are backed by the fake's tables where the real
   * function is a thin lookup (suppression), and permissive no-ops where
   * the real function is an accounting side effect (rate limit, counters).
   */
  async rpc(name: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
    const handler = this.rpcHandlers.get(name);
    if (handler) return handler(params, this);
    switch (name) {
      case 'is_recipient_suppressed': {
        const suppressed = this.rows('recipient_opt_outs').some(
          (r) =>
            r['instagram_account_id'] === params['p_instagram_account_id'] &&
            r['recipient_id'] === params['p_recipient_id']
        );
        return { data: suppressed, error: null };
      }
      case 'record_recipient_opt_out': {
        const rows = this.rows('recipient_opt_outs');
        const existing = rows.find(
          (r) =>
            r['instagram_account_id'] === params['p_instagram_account_id'] &&
            r['recipient_id'] === params['p_recipient_id']
        );
        if (!existing) {
          rows.push({
            id: randomUUID(),
            instagram_account_id: params['p_instagram_account_id'],
            recipient_id: params['p_recipient_id'],
            trigger_event_id: params['p_trigger_event_id'] ?? null,
            opt_out_text: params['p_opt_out_text'] ?? null,
            reason: params['p_reason'] ?? null,
          });
        }
        return { data: true, error: null };
      }
      case 'reserve_comment_private_reply':
        return this.reserveReply('comment_private_reply_reservations', params, 'reserved_by_other_or_active');
      case 'reserve_comment_public_reply':
        return this.reserveReply('comment_public_reply_reservations', params, 'in_flight');
      case 'confirm_comment_private_reply_sent': {
        const row = this.rows('comment_private_reply_reservations').find(
          (r) =>
            r['instagram_account_id'] === params['p_instagram_account_id'] &&
            r['comment_id'] === params['p_comment_id'] &&
            r['automation_id'] === params['p_automation_id'] &&
            r['status'] === 'reserved'
        );
        if (row) {
          row['status'] = 'sent';
          row['sent_at'] = new Date().toISOString();
        }
        return { data: null, error: null };
      }
      case 'confirm_comment_public_reply_sent': {
        const row = this.rows('comment_public_reply_reservations').find(
          (r) =>
            r['instagram_account_id'] === params['p_instagram_account_id'] &&
            r['comment_id'] === params['p_comment_id'] &&
            r['status'] === 'reserved'
        );
        if (row) {
          row['status'] = 'sent';
          row['sent_at'] = new Date().toISOString();
          row['reply_comment_id'] = params['p_reply_comment_id'] ?? null;
        }
        return { data: null, error: null };
      }
      case 'release_comment_private_reply':
        this.replaceRows(
          'comment_private_reply_reservations',
          this.rows('comment_private_reply_reservations').filter(
            (r) =>
              !(
                r['instagram_account_id'] === params['p_instagram_account_id'] &&
                r['comment_id'] === params['p_comment_id'] &&
                r['automation_id'] === params['p_automation_id'] &&
                r['status'] === 'reserved'
              )
          )
        );
        return { data: null, error: null };
      case 'release_comment_public_reply':
        this.replaceRows(
          'comment_public_reply_reservations',
          this.rows('comment_public_reply_reservations').filter(
            (r) =>
              !(
                r['instagram_account_id'] === params['p_instagram_account_id'] &&
                r['comment_id'] === params['p_comment_id'] &&
                r['automation_id'] === params['p_automation_id'] &&
                r['status'] === 'reserved'
              )
          )
        );
        return { data: null, error: null };
      case 'mark_comment_private_reply_failed': {
        const row = this.rows('comment_private_reply_reservations').find(
          (r) =>
            r['instagram_account_id'] === params['p_instagram_account_id'] &&
            r['comment_id'] === params['p_comment_id'] &&
            r['automation_id'] === params['p_automation_id'] &&
            r['status'] === 'reserved'
        );
        if (row) {
          row['status'] = 'failed';
          row['failed_at'] = new Date().toISOString();
          row['failure_reason'] = params['p_failure_reason'] ?? null;
        }
        return { data: null, error: null };
      }
      case 'mark_comment_public_reply_failed': {
        // Release-prep's SQL has NO status filter here (updates the row for
        // the account+comment unconditionally) — mirrored faithfully.
        const row = this.rows('comment_public_reply_reservations').find(
          (r) =>
            r['instagram_account_id'] === params['p_instagram_account_id'] &&
            r['comment_id'] === params['p_comment_id']
        );
        if (row) {
          row['status'] = 'failed';
          row['failed_at'] = new Date().toISOString();
          row['failure_reason'] = params['p_failure_reason'] ?? null;
        }
        return { data: null, error: null };
      }
      case 'check_and_record_dm_rate_limit':
        return { data: [{ allowed: true, current_count: 0, retry_after_seconds: 0 }], error: null };
      case 'evaluate_traffic_guard_state':
        return {
          data: { state: 'normal', current_60s_count: 0, incident_id: null, notification_emitted: null },
          error: null,
        };
      case 'claim_due_jobs':
        return { data: [], error: null };
      default:
        // increment_automation_dms_sent, record_contact_interaction,
        // update_contact_profile, record_comment_traffic_events, …
        return { data: null, error: null };
    }
  }

  from(table: string): FakeBuilder {
    return new FakeBuilder(this, table);
  }
}
