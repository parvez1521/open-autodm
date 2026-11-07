/**
 * Programme 18 / Phase G — workspace frontend source pins.
 *
 * This codebase's page tests are source-pin / static-render style
 * (see customer-journey.test.ts), so the UI contract is pinned here:
 *  - the flag is read SERVER-side in the (main) layout and the
 *    settings/workspace page, and passed down as the
 *    `workspaceRuntimeEnabled` prop — no client env var is invented;
 *  - the switcher is mounted in the sidebar ONLY behind that prop,
 *    and the switcher itself returns null when disabled (flag OFF ⇒
 *    sidebar renders exactly as before);
 *  - the provider attaches the Phase D selector header
 *    (`x-workspace-id`) and persists the selection in localStorage
 *    (documented local-prototype choice);
 *  - member write controls (invite, role change, remove) sit behind
 *    the canManageMembers condition; the read-only presentation and
 *    the no-access denied state both exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const layoutSrc = readSrc('app/(main)/layout.tsx');
const sidebarSrc = readSrc('components/dashboard/Sidebar.tsx');
const providerSrc = readSrc('components/workspace/WorkspaceProvider.tsx');
const switcherSrc = readSrc('components/workspace/WorkspaceSwitcher.tsx');
const membersSrc = readSrc('components/workspace/WorkspaceMembers.tsx');
const pageSrc = readSrc('app/(main)/settings/workspace/page.tsx');

describe('server-side flag gating (no invented client env var)', () => {
  it('the (main) layout reads the flag server-side and passes it down as a prop', () => {
    expect(layoutSrc).toContain('readWorkspaceFlags(process.env)');
    expect(layoutSrc).toContain('workspaceRuntimeEnabled={workspaceRuntimeEnabled}');
    expect(layoutSrc).toContain('<WorkspaceProvider workspaceRuntimeEnabled={workspaceRuntimeEnabled}>');
  });

  it('the workspace settings page is server-gated the same way, with an inert OFF state', () => {
    expect(pageSrc).toContain('readWorkspaceFlags(process.env)');
    expect(pageSrc).toContain('workspaceRuntimeEnabled={workspaceRuntimeEnabled}');
    expect(pageSrc).toContain('workspace-runtime-disabled');
  });

  it('no new Phase G file invents a NEXT_PUBLIC_ workspace flag', () => {
    for (const src of [layoutSrc, providerSrc, switcherSrc, membersSrc, pageSrc]) {
      expect(src).not.toContain('NEXT_PUBLIC_WORKSPACE');
      expect(src).not.toContain('NEXT_PUBLIC_');
    }
  });
});

describe('WorkspaceSwitcher mounting', () => {
  it('the sidebar mounts the switcher ONLY behind the enabled prop (desktop + mobile)', () => {
    const occurrences = sidebarSrc.split('{workspaceRuntimeEnabled && (').length - 1;
    expect(occurrences).toBe(2);
    expect(sidebarSrc).toContain('<WorkspaceSwitcher isCollapsed={isCollapsed} />');
    expect(sidebarSrc).toContain('<WorkspaceSwitcher isCollapsed={false} />');
  });

  it('the switcher itself returns null when the runtime is disabled', () => {
    expect(switcherSrc).toContain('if (!workspaceRuntimeEnabled) return null;');
    expect(switcherSrc).toContain('data-testid="workspace-switcher"');
  });

  it('the switcher shows the current workspace name and a role badge', () => {
    expect(switcherSrc).toContain('selectedWorkspace?.name');
    expect(switcherSrc).toContain('data-testid="workspace-role-badge"');
    expect(switcherSrc).toContain('selectedWorkspace.role');
  });
});

describe('WorkspaceProvider contract', () => {
  it('attaches the x-workspace-id header (Phase D selector convention) in its fetch helper', () => {
    expect(providerSrc).toContain('workspaceFetch');
    expect(providerSrc).toContain('headers["x-workspace-id"] = selected');
  });

  it('loads the member-derived list from GET /api/workspaces only when enabled', () => {
    expect(providerSrc).toContain('apiClient<{ workspaces: WorkspaceSummary[] }>("/workspaces")');
    expect(providerSrc).toContain('if (!workspaceRuntimeEnabled) return;');
  });

  it('persists the selection in localStorage (documented local-prototype choice) and drops stale ids', () => {
    expect(providerSrc).toContain('WORKSPACE_SELECTION_STORAGE_KEY = "opendm:selected-workspace-id"');
    expect(providerSrc).toContain('localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY');
    expect(providerSrc).toContain('localStorage.removeItem(WORKSPACE_SELECTION_STORAGE_KEY)');
    expect(providerSrc).toContain('droppedWorkspaceId');
  });

  it('exposes canManageMembers derived from the selected workspace role (owner/admin)', () => {
    expect(providerSrc).toContain('canManageMembers:');
    expect(providerSrc).toContain('selectedWorkspace?.role === "owner" || selectedWorkspace?.role === "admin"');
  });
});

describe('WorkspaceMembers page presentation', () => {
  it('invite panel and member write controls are behind canManageMembers', () => {
    expect(membersSrc).toContain('{canManageMembers && (');
    expect(membersSrc).toContain('data-testid="workspace-invite-panel"');
    expect(membersSrc).toContain('{canManageMembers && m.userId && (');
  });

  it('viewer/member get a read-only presentation with NO write controls section', () => {
    expect(membersSrc).toContain('data-testid="workspace-members-readonly"');
    expect(membersSrc).toContain('{!canManageMembers && (');
  });

  it('the no-access denied state exists and drops the workspace from the switcher', () => {
    expect(membersSrc).toContain('data-testid="workspace-no-access"');
    expect(membersSrc).toContain('You no longer have access to this workspace');
    expect(membersSrc).toContain('dropWorkspace(selectedWorkspaceId)');
  });

  it('permission-denied copy exists for insufficient role on write actions', () => {
    expect(membersSrc).toContain('Permission denied: only workspace owners and admins can invite members.');
    expect(membersSrc).toContain('Permission denied: only workspace owners and admins can change roles.');
  });

  it('the invite result is shown once with the accept link, and the page states no email is sent', () => {
    expect(membersSrc).toContain('data-testid="workspace-invite-result"');
    expect(membersSrc).toContain('No email is sent');
    expect(membersSrc).toContain('shown only once');
  });
});
