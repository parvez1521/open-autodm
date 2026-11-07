/**
 * Phase 13 — tenancy model tests (static/schema level).
 * The live RLS behaviour is proven by the disposable-PostgreSQL rehearsal
 * (scripts in /tmp during the phase; results in
 * saas/phase13-customer-journey.md + checkpoint). These tests pin the
 * migration FILES' structural contract so a future edit cannot silently
 * drop RLS, a policy, a grant, or the copy-only header.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve(process.cwd(), 'supabase/migrations');
const read = (f: string) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');

const FILES = {
  core: '20260730000024_tenancy_core.sql',
  settings: '20260730000025_workspace_settings_platform.sql',
  binding: '20260730000026_instagram_workspace_binding.sql',
  billing: '20260730000027_subscriptions_billing.sql',
  events: '20260730000028_billing_events_attempts.sql',
} as const;

const TENANT_TABLES = [
  'workspaces', 'workspace_memberships', 'workspace_invitations',
  'workspace_settings', 'usage_counters', 'workspace_instagram_accounts',
  'subscriptions', 'workspace_billing_profiles', 'billing_customers',
  'billing_events', 'payment_attempts', 'platform_config', 'platform_admins',
];

describe('tenancy migrations: file contract', () => {
  it('all five Phase 13 migrations exist, numbered after 000023', () => {
    for (const f of Object.values(FILES)) {
      expect(fs.existsSync(path.join(MIGRATIONS, f)), f).toBe(true);
      expect(Number(f.slice(0, 14))).toBeGreaterThan(20260730000023);
    }
  });
  it('every file carries the copy-only / not-approved-apply-list header', () => {
    for (const f of Object.values(FILES)) {
      const sql = read(f);
      expect(sql, f).toContain('COPY-ONLY');
      expect(sql, f).toContain('NOT part of the frozen');
      expect(sql, f).toContain('000021');
    }
  });
  it('every tenant/platform table has RLS enabled somewhere in the migrations', () => {
    const all = Object.values(FILES).map(read).join('\n');
    for (const t of TENANT_TABLES) {
      expect(all, t).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
      expect(all, t).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM PUBLIC, anon, authenticated`));
      expect(all, t).toMatch(new RegExp(`GRANT ALL ON TABLE public\\.${t} TO service_role`));
    }
  });
  it('no policy or grant ever authorizes from user-editable metadata', () => {
    // SQL comment lines are stripped first: the migration headers mention
    // the prohibition in prose; what matters is that no executable SQL
    // (policy, grant, function body) references user-editable metadata.
    const stripComments = (sql: string) =>
      sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    const all = Object.values(FILES).map((f) => stripComments(read(f))).join('\n');
    expect(all).not.toContain('raw_user_meta_data');
    expect(all).not.toContain('raw_app_meta_data');
  });
  it('helpers are SECURITY DEFINER with pinned search_path and revoked from anon/public', () => {
    const core = read(FILES.core);
    for (const fn of ['workspace_role', 'is_workspace_member', 'has_workspace_role']) {
      expect(core).toContain(`FUNCTION public.${fn}`);
    }
    expect(core).toContain("SECURITY DEFINER SET search_path = ''");
    expect(core).toContain('FROM PUBLIC, anon');
  });
  it('policies are per-operation and TO authenticated', () => {
    const all = Object.values(FILES).map(read).join('\n');
    const policies = all.match(/CREATE POLICY \w+ ON public\.\w+\s*\n?\s*FOR (SELECT|INSERT|UPDATE|DELETE) TO authenticated/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(20);
  });
  it('subscriptions has NO authenticated write grant (service-role writes only)', () => {
    const billingSql = read(FILES.billing);
    expect(billingSql).toContain('GRANT SELECT ON TABLE public.subscriptions TO authenticated');
    expect(billingSql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*ON TABLE public\.subscriptions TO authenticated/);
    expect(billingSql).not.toMatch(/GRANT [^;]*,\s*(INSERT|UPDATE|DELETE)[^;]*ON TABLE public\.subscriptions TO authenticated/);
  });
  it('usage_counters has NO authenticated write grant', () => {
    const s = read(FILES.settings);
    expect(s).toContain('GRANT SELECT ON TABLE public.usage_counters TO authenticated');
    expect(s).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*ON TABLE public\.usage_counters TO authenticated/);
  });
  it('platform_config and billing_events grant NOTHING to authenticated', () => {
    const all = Object.values(FILES).map(read).join('\n');
    expect(all).not.toMatch(/GRANT [^;]*ON TABLE public\.platform_config TO authenticated/);
    expect(all).not.toMatch(/GRANT [^;]*ON TABLE public\.billing_events TO authenticated/);
  });
  it('billing_events enforces provider-event idempotency at the DB level and stores no payload', () => {
    const e = read(FILES.events);
    expect(e).toContain('UNIQUE (provider, provider_event_id)');
    expect(e.toLowerCase()).not.toContain('raw_payload');
    expect(e.toLowerCase()).not.toContain('payload_json');
  });
  it('subscription currency immutability trigger exists', () => {
    const b = read(FILES.billing);
    expect(b).toContain('subscriptions_currency_immutable');
    expect(b).toContain('currency is immutable');
  });
  it('app_settings is never altered by Phase 13 migrations', () => {
    const all = Object.values(FILES).map(read).join('\n');
    expect(all).not.toMatch(/ALTER TABLE public\.app_settings/);
    expect(all).not.toMatch(/CREATE TABLE (IF NOT EXISTS )?public\.app_settings/);
    expect(all).not.toMatch(/DROP TABLE[^;]*app_settings/);
  });
  it('instagram binding keeps one-workspace-per-account uniqueness', () => {
    const b = read(FILES.binding);
    expect(b).toContain('UNIQUE (instagram_account_id)');
    expect(b).toContain('workspace_id UUID REFERENCES public.workspaces');
  });
  it('filter columns used by policies are indexed', () => {
    const all = Object.values(FILES).map(read).join('\n');
    expect(all).toContain('idx_memberships_user_id');
    expect(all).toContain('idx_memberships_workspace_role');
    expect(all).toContain('idx_subscriptions_provider_sub');
    expect(all).toContain('idx_instagram_accounts_workspace');
  });
});
