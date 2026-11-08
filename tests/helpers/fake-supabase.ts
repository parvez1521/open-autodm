/**
 * Minimal in-memory Supabase client fake for billing wiring tests.
 *
 * Implements exactly the PostgREST builder shapes the billing
 * persistence layer + tenancy context use:
 *   .from(t).select(cols).eq(...)[.eq(...)].maybeSingle()
 *   .from(t).select(cols).eq(...).order(...).limit(n)   (awaited)
 *   .from(t).insert(row)                               (awaited)
 *   .from(t).update(patch).eq(...)                     (awaited)
 * Unique constraints enforced like the real migrations:
 *   subscriptions.workspace_id, billing_orders (provider,
 *   provider_order_id), billing_events (provider, provider_event_id)
 * — violations come back as { error: { code: '23505' } }, never thrown,
 * mirroring PostgREST.
 */

export type FakeRow = Record<string, unknown>;

export interface FakeSupabase {
  client: unknown;
  tables: Record<string, FakeRow[]>;
  rows: (table: string) => FakeRow[];
}

const UNIQUE_KEYS: Record<string, string[][]> = {
  subscriptions: [['workspace_id']],
  billing_orders: [['provider', 'provider_order_id']],
  billing_events: [['provider', 'provider_event_id']],
};

class FakeQuery {
  private mode: 'select' | 'insert' | 'update' = 'select';
  private filters: [string, unknown][] = [];
  private orderSpec: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private insertRow: FakeRow | null = null;
  private patch: FakeRow | null = null;

  constructor(
    private readonly tables: Record<string, FakeRow[]>,
    private readonly table: string,
  ) {}

  select(): this {
    return this;
  }
  insert(row: FakeRow): this {
    this.mode = 'insert';
    this.insertRow = row;
    return this;
  }
  update(patch: FakeRow): this {
    this.mode = 'update';
    this.patch = patch;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderSpec = { col, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private tableRows(): FakeRow[] {
    if (!this.tables[this.table]) this.tables[this.table] = [];
    return this.tables[this.table]!;
  }

  private matches(row: FakeRow): boolean {
    return this.filters.every(([c, v]) => row[c] === v);
  }

  private execute(): { data: unknown; error: { code?: string; message: string } | null } {
    const rows = this.tableRows();
    if (this.mode === 'insert') {
      const row = { ...(this.insertRow ?? {}) };
      for (const keySet of UNIQUE_KEYS[this.table] ?? []) {
        const clash = rows.some((r) => keySet.every((k) => r[k] === row[k]));
        if (clash) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          };
        }
      }
      if (row['created_at'] === undefined) row['created_at'] = new Date().toISOString();
      rows.push(row);
      return { data: null, error: null };
    }
    if (this.mode === 'update') {
      for (const row of rows) {
        if (this.matches(row)) Object.assign(row, this.patch ?? {});
      }
      return { data: null, error: null };
    }
    let out = rows.filter((r) => this.matches(r));
    if (this.orderSpec) {
      const { col, ascending } = this.orderSpec;
      out = [...out].sort((a, b) => {
        const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
        return ascending ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return { data: out.map((r) => ({ ...r })), error: null };
  }

  async maybeSingle(): Promise<{ data: FakeRow | null; error: { message: string } | null }> {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    const list = data as FakeRow[];
    if (list.length === 0) return { data: null, error: null };
    if (list.length > 1) return { data: null, error: { message: 'multiple rows' } };
    return { data: list[0]!, error: null };
  }

  // Thenable so `await builder` executes (PostgREST builders are thenable).
  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(
      onFulfilled as never,
      onRejected as never,
    ) as Promise<TResult1 | TResult2>;
  }
}

export function createFakeSupabase(seed: Record<string, FakeRow[]> = {}): FakeSupabase {
  const tables: Record<string, FakeRow[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  const client = {
    from: (table: string) => new FakeQuery(tables, table),
  };
  return {
    client,
    tables,
    rows: (table: string) => tables[table] ?? [],
  };
}
