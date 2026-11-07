/**
 * Programme 18 / Phase I foundation — workspace runtime flag tests
 * (src/lib/tenancy/workspaceFlags.ts). Mirrors the billing-flag pins in
 * launch-acceptance.test.ts: default OFF, only the literal string
 * 'true' enables, and the route gate is inert (503) while off.
 */
import { describe, it, expect } from 'vitest';
import {
  readWorkspaceFlags,
  DEFAULT_WORKSPACE_FLAGS,
  assertWorkspaceRouteEnabled,
} from '@/lib/tenancy/workspaceFlags';

describe('readWorkspaceFlags', () => {
  it('defaults OFF with no env, empty env, and unrelated env', () => {
    expect(readWorkspaceFlags()).toEqual({ workspaceRuntimeEnabled: false });
    expect(readWorkspaceFlags({})).toEqual({ workspaceRuntimeEnabled: false });
    expect(readWorkspaceFlags({ BILLING_ENABLED: 'true' })).toEqual({
      workspaceRuntimeEnabled: false,
    });
    expect(DEFAULT_WORKSPACE_FLAGS).toEqual({ workspaceRuntimeEnabled: false });
  });

  it("only the literal string 'true' enables the flag", () => {
    expect(readWorkspaceFlags({ WORKSPACE_RUNTIME_ENABLED: 'true' }).workspaceRuntimeEnabled).toBe(true);
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '', 'false']) {
      expect(
        readWorkspaceFlags({ WORKSPACE_RUNTIME_ENABLED: value }).workspaceRuntimeEnabled,
        `value ${JSON.stringify(value)} must stay OFF`,
      ).toBe(false);
    }
    expect(readWorkspaceFlags({ WORKSPACE_RUNTIME_ENABLED: undefined }).workspaceRuntimeEnabled).toBe(false);
  });

  it('does not read or widen any billing/signup/entitlement flag', () => {
    const flags = readWorkspaceFlags({
      WORKSPACE_RUNTIME_ENABLED: 'true',
      BILLING_ENABLED: 'false',
      PUBLIC_SIGNUP_ENABLED: 'false',
      ENTITLEMENTS_ENFORCED: 'false',
    });
    expect(Object.keys(flags)).toEqual(['workspaceRuntimeEnabled']);
  });
});

describe('assertWorkspaceRouteEnabled (route gate)', () => {
  it('is inert with 503 while the flag is off (the default)', () => {
    expect(assertWorkspaceRouteEnabled(DEFAULT_WORKSPACE_FLAGS)).toEqual({
      ok: false,
      status: 503,
      reason: 'workspace-runtime-disabled',
    });
    expect(assertWorkspaceRouteEnabled(readWorkspaceFlags({}))).toEqual({
      ok: false,
      status: 503,
      reason: 'workspace-runtime-disabled',
    });
  });

  it('passes only when the flag was read as enabled', () => {
    expect(
      assertWorkspaceRouteEnabled(readWorkspaceFlags({ WORKSPACE_RUNTIME_ENABLED: 'true' })),
    ).toEqual({ ok: true });
    expect(assertWorkspaceRouteEnabled({ workspaceRuntimeEnabled: true })).toEqual({ ok: true });
  });
});
