/**
 * Phase 14 — administrative audit log (append-only by construction).
 *
 * Model (mirrors migration …000029 `admin_audit_log`): every entry has
 * actor, action, target, before/after snapshots, a mandatory reason and
 * a timestamp. The service-layer API exposes ONLY `append` and `list`:
 * there is deliberately no update / delete / clear method, entries are
 * frozen on write, and `list` returns deep-frozen copies so a caller
 * mutating what it received cannot rewrite history. The DB design adds
 * a trigger that raises on UPDATE/DELETE (see the migration), so the
 * append-only property holds at both layers.
 *
 * Snapshots stored here must already be sanitized by the caller (the
 * admin service passes DTO-shaped before/after values — never internal
 * records, never secret material).
 */
import type { PlatformRole } from './types';

export interface AdminAuditEntry {
  id: string;
  actorUserId: string;
  actorPlatformRole: PlatformRole;
  action: string;
  targetType: 'workspace' | 'subscription' | 'refund' | 'invoice' | 'entitlement';
  targetId: string;
  workspaceId: string | null;
  before: unknown;
  after: unknown;
  reason: string;
  at: number; // ms epoch
}

export type AdminAuditAppendInput = Omit<AdminAuditEntry, 'id' | 'at'> & { at?: number };

export interface AdminAuditLog {
  append(input: AdminAuditAppendInput): AdminAuditEntry;
  list(filter?: { workspaceId?: string; action?: string }): readonly AdminAuditEntry[];
}

function deepFreezeCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const copy: unknown = Array.isArray(value)
    ? value.map((v) => deepFreezeCopy(v))
    : Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepFreezeCopy(v)]));
  return Object.freeze(copy) as T;
}

export class InMemoryAdminAuditLog implements AdminAuditLog {
  private readonly entries: AdminAuditEntry[] = [];
  private seq = 0;

  append(input: AdminAuditAppendInput): AdminAuditEntry {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new Error('audit entry requires a non-empty reason');
    }
    this.seq += 1;
    const entry: AdminAuditEntry = deepFreezeCopy({
      ...input,
      before: deepFreezeCopy(input.before),
      after: deepFreezeCopy(input.after),
      id: `audit_${this.seq}`,
      at: input.at ?? Date.now(),
    });
    this.entries.push(entry);
    return entry;
  }

  list(filter: { workspaceId?: string; action?: string } = {}): readonly AdminAuditEntry[] {
    return this.entries
      .filter((e) => (filter.workspaceId ? e.workspaceId === filter.workspaceId : true))
      .filter((e) => (filter.action ? e.action === filter.action : true))
      .map((e) => deepFreezeCopy(e));
  }
}
