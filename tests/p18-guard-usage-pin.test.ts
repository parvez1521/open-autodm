/**
 * Programme 18 — usage pin for the workspace guard LAYER itself.
 *
 * Phase D will add route-level pins (which routes use the layer). This
 * pin guards the layer's own contract so a later refactor cannot
 * silently weaken it:
 *   - routeContext exports the expected API and delegates to
 *     resolveWorkspaceContext (no second resolver);
 *   - repository exports the expected API, is built ON scopedDb
 *     (imports + re-exports its primitives, and actually calls
 *     applyTenantScope / stampWorkspace / assertRowInWorkspace);
 *   - workspaceFlags exports the expected API and reads ONLY the
 *     WORKSPACE_RUNTIME_ENABLED literal-'true' check;
 *   - neither new module touches the GATED settings surface
 *     (app_settings / platform_config / workspace_settings /
 *     saveMetaSettings / getMetaSettings) or the billing flags.
 *
 * Source-scan style follows tests/p17-service-role-pins.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src/lib/tenancy');
const read = (name: string): string => readFileSync(path.join(SRC, name), 'utf8');

const routeContextSrc = read('routeContext.ts');
const repositorySrc = read('repository.ts');
const workspaceFlagsSrc = read('workspaceFlags.ts');

describe('routeContext module pin', () => {
  it('exports the expected API', () => {
    expect(routeContextSrc).toContain('export async function resolveRouteWorkspaceContext');
    expect(routeContextSrc).toContain('export async function listUserWorkspaces');
    expect(routeContextSrc).toContain('export function requireCapability');
    expect(routeContextSrc).toContain('export function hasCapability');
    expect(routeContextSrc).toContain('export type RouteWorkspaceResult');
    expect(routeContextSrc).toContain("export type RouteCapability = 'write' | 'manageMembers' | 'manageBilling' | 'accountAdmin'");
  });

  it('does not read workspace_memberships directly (the §5 reader inventory stays at context.ts)', () => {
    expect(routeContextSrc).not.toContain("from('workspace_memberships')");
    expect(routeContextSrc).not.toContain('from("workspace_memberships")');
    expect(routeContextSrc).toContain('listMembershipsForUser');
  });

  it('delegates to resolveWorkspaceContext (no second resolver) and wraps errors fail-closed', () => {
    expect(routeContextSrc).toContain('resolveWorkspaceContext');
    expect(routeContextSrc).toContain("code: 'workspace-resolution-failed'");
    expect(routeContextSrc).toContain("'workspace-context-required': 400");
    // Header documents the freshness contract.
    expect(routeContextSrc).toContain('FRESH RESOLUTION PER REQUEST');
    expect(routeContextSrc).toContain('CLIENT ID IS A SELECTOR, NEVER PROOF');
    expect(routeContextSrc).toContain('NO DEFAULT WORKSPACE');
  });

  it("documents and implements the accountAdmin = owner/admin mapping", () => {
    expect(routeContextSrc).toContain("'accountAdmin'");
    expect(routeContextSrc).toContain("ctx.role === 'owner' || ctx.role === 'admin'");
  });
});

describe('repository module pin', () => {
  it('exports the expected API', () => {
    expect(repositorySrc).toContain('export function createTenantRepository');
    expect(repositorySrc).toContain('export function capabilityForContext');
    expect(repositorySrc).toContain('export const TENANT_TABLES');
    expect(repositorySrc).toContain('getByIdInWorkspace');
    expect(repositorySrc).toContain("export type TenantCapability = 'read' | 'write'");
  });

  it('is built ON scopedDb: imports, re-exports, and actually calls its primitives', () => {
    expect(repositorySrc).toContain("from './scopedDb'");
    expect(repositorySrc).toContain(
      "export { tenantFilter, stampWorkspace, applyTenantScope, assertRowInWorkspace } from './scopedDb'",
    );
    // Actual call sites, not just imports.
    expect(repositorySrc).toContain('applyTenantScope(query, ctx)');
    expect(repositorySrc).toContain('stampWorkspace(ctx)');
    expect(repositorySrc).toContain('assertRowInWorkspace(data as TenantRow, ctx)');
  });

  it('keeps platform exceptions out: no gated settings surface is referenced', () => {
    for (const src of [repositorySrc, routeContextSrc]) {
      expect(src).not.toContain('saveMetaSettings');
      expect(src).not.toContain('getMetaSettings');
      expect(src).not.toContain("from '../settings'");
      expect(src).not.toContain('from "@/lib/settings"');
    }
    // The allowlist itself must never name a gated/platform table as reachable.
    const allowlistBlock = repositorySrc.slice(
      repositorySrc.indexOf('export const TENANT_TABLES'),
      repositorySrc.indexOf('] as const;'),
    );
    expect(allowlistBlock).not.toContain("'app_settings'");
    expect(allowlistBlock).not.toContain("'platform_config'");
    expect(allowlistBlock).not.toContain("'workspace_settings'");
    expect(allowlistBlock).not.toContain("'profiles'");
  });
});

describe('workspaceFlags module pin', () => {
  it('exports the expected API following the billing flags pattern', () => {
    expect(workspaceFlagsSrc).toContain('export interface WorkspaceFlags');
    expect(workspaceFlagsSrc).toContain('export function readWorkspaceFlags');
    expect(workspaceFlagsSrc).toContain('export const DEFAULT_WORKSPACE_FLAGS');
    expect(workspaceFlagsSrc).toContain('export function assertWorkspaceRouteEnabled');
    expect(workspaceFlagsSrc).toContain("{ workspaceRuntimeEnabled: false }");
  });

  it("reads ONLY WORKSPACE_RUNTIME_ENABLED with a literal 'true' check", () => {
    expect(workspaceFlagsSrc).toContain("env.WORKSPACE_RUNTIME_ENABLED === 'true'");
    expect(workspaceFlagsSrc).not.toContain('BILLING_ENABLED');
    expect(workspaceFlagsSrc).not.toContain('PUBLIC_SIGNUP_ENABLED');
    expect(workspaceFlagsSrc).not.toContain('ENTITLEMENTS_ENFORCED');
    expect(workspaceFlagsSrc).not.toContain('PAYMENTS_LIVE_MODE');
  });
});
