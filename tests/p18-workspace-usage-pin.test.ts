/**
 * Programme 18 / Phase D — usage pin: every route file touched by Phase D
 * must actually USE the tenancy layer in product code (import
 * routeContext, repository, or workspaceFlags) — not merely be covered
 * by helper-level tests. Source-scan style follows
 * tests/p18-guard-usage-pin.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const API = path.resolve(process.cwd(), 'src/app/api');
const read = (rel: string): string => readFileSync(path.join(API, rel), 'utf8');

const TOUCHED_ROUTES = [
  'automations/route.ts',
  'automations/[id]/route.ts',
  'contacts/route.ts',
  'analytics/route.ts',
  'activity/route.ts',
  'instagram/accounts/route.ts',
  'instagram/disconnect/[accountId]/route.ts',
  'instagram/refresh/[accountId]/route.ts',
  'instagram/resubscribe/[accountId]/route.ts',
  'instagram/subscription-status/[accountId]/route.ts',
  'instagram/posts/[accountId]/route.ts',
  'traffic-guard/status/route.ts',
  'traffic-guard/pause/route.ts',
  'traffic-guard/resume/route.ts',
  'traffic-guard/dismiss/route.ts',
  'debug/events/route.ts',
] as const;

describe('Phase D route usage pin', () => {
  it.each(TOUCHED_ROUTES)('%s imports the tenancy layer', (rel) => {
    const src = read(rel);
    const usesLayer =
      src.includes("from '@/lib/tenancy/routeContext'") ||
      src.includes("from '@/lib/tenancy/repository'") ||
      src.includes("from '@/lib/tenancy/workspaceFlags'");
    expect(usesLayer).toBe(true);
  });

  it.each(TOUCHED_ROUTES)('%s reads the workspace flag via readWorkspaceFlags(process.env)', (rel) => {
    const src = read(rel);
    expect(src).toContain('readWorkspaceFlags(process.env)');
  });

  it.each(TOUCHED_ROUTES)('%s resolves workspace context via resolveRouteWorkspaceContext (no ad-hoc resolver)', (rel) => {
    const src = read(rel);
    expect(src).toContain('resolveRouteWorkspaceContext');
  });

  it('routes that gate writes use requireCapability; account-admin routes use accountAdmin', () => {
    for (const rel of [
      'automations/route.ts',
      'automations/[id]/route.ts',
      'traffic-guard/pause/route.ts',
      'traffic-guard/resume/route.ts',
      'traffic-guard/dismiss/route.ts',
      'debug/events/route.ts',
    ]) {
      expect(read(rel)).toContain('requireCapability');
    }
    for (const rel of [
      'instagram/disconnect/[accountId]/route.ts',
      'instagram/refresh/[accountId]/route.ts',
      'instagram/resubscribe/[accountId]/route.ts',
    ]) {
      expect(read(rel)).toContain("'accountAdmin'");
    }
  });

  it('repository-backed routes import createTenantRepository', () => {
    for (const rel of [
      'automations/route.ts',
      'automations/[id]/route.ts',
      'contacts/route.ts',
      'activity/route.ts',
      'instagram/accounts/route.ts',
      'instagram/disconnect/[accountId]/route.ts',
      'instagram/posts/[accountId]/route.ts',
      'traffic-guard/status/route.ts',
      'traffic-guard/dismiss/route.ts',
    ]) {
      expect(read(rel)).toContain('createTenantRepository');
    }
  });

  it('PD-3 and PD-1 decisions are cited in the routes that implement them', () => {
    expect(read('instagram/subscription-status/[accountId]/route.ts')).toContain('PD-3');
    expect(read('instagram/posts/[accountId]/route.ts')).toContain('PD-3');
    expect(read('debug/events/route.ts')).toContain('PD-1');
    expect(read('traffic-guard/pause/route.ts')).toContain('PD-4');
    expect(read('traffic-guard/resume/route.ts')).toContain('PD-4');
  });
});
