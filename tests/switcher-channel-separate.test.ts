/**
 * Account switcher channel separation (2026-11-20).
 *
 * The owner asked for the sidebar switcher to show Instagram and
 * Facebook as SEPARATE options, like the /automations channel tabs
 * (commit 41db978): the trigger now has one compact row per
 * channel, and the popover has an Instagram / Facebook toggle so
 * only one channel's list + Add button shows at a time. Picking an
 * account or Page in one channel never clears the other channel's
 * selection. If any of these pins break, the two channels mix
 * again in the switcher or one selection silently disappears.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

describe('switcher trigger shows both channels as separate rows', () => {
  const switcher = readSrc('components/dashboard/AccountSwitcher.tsx');

  it('renders an Instagram row and a Facebook row, each opening the popover on its own channel', () => {
    expect(switcher).toContain('openChannel("instagram")');
    expect(switcher).toContain('openChannel("facebook")');
    expect(switcher).toContain('const openChannel = (channel: SwitcherChannel) => {');
    // Same row clicked again closes; the other row switches the tab.
    expect(switcher).toContain('if (open && switcherChannel === channel) {');
    expect(switcher).toContain('setSwitcherChannel(channel);');
  });

  it('the Facebook row shows the active Page name/status and an honest empty state', () => {
    expect(switcher).toContain('{fbPage.name}');
    expect(switcher).toContain('fbPage.is_paused ? "Safety pause" : "Active"');
    expect(switcher).toContain('No Page connected');
    expect(switcher).toContain('Connect Facebook');
    // The Instagram row keeps its existing copy.
    expect(switcher).toContain('No account');
    expect(switcher).toContain('Connect Instagram');
  });

  it('collapsed sidebar keeps both rows as icons with title tooltips', () => {
    expect(switcher).toContain('title={isCollapsed ? (account ? `@${account.username}` : "Instagram accounts") : undefined}');
    expect(switcher).toContain('title={isCollapsed ? (fbPage ? fbPage.name : "Facebook Pages") : undefined}');
  });
});

describe('switcher popover channel toggle', () => {
  const switcher = readSrc('components/dashboard/AccountSwitcher.tsx');

  it('renders an Instagram / Facebook toggle in the same pill style as the automations tabs', () => {
    expect(switcher).toContain('ariaLabel="Account channel"');
    // The switcher uses the matched fill-weight glyphs for the
    // toggle; FacebookLogo survives for the Page fallback tile.
    expect(switcher).toContain('InstagramGlyph');
    expect(switcher).toContain('FacebookLogo');
    // Shared PillToggle treatment (UI polish 2026-11-25): the pill
    // classes now live in the component, not inline in the switcher.
    expect(switcher).toContain('PillToggle');
    // md is the component default — the switcher relies on it.
    const toggle = readSrc('components/ui/PillToggle.tsx');
    expect(toggle).toContain('size = "md"');
    expect(toggle).toContain('bg-muted rounded-lg p-0.5');
    expect(toggle).toContain('aria-pressed={isActive}');
  });

  it('shows only the selected channel’s list + Add button', () => {
    expect(switcher).toContain('{switcherChannel === "instagram" && (');
    expect(switcher).toContain('{switcherChannel === "facebook" && (');
    // The session/sign-out block is outside both conditionals and
    // stays visible under either tab.
    expect(switcher).toContain('Signed in as');
    expect(switcher).toContain('Sign out');
  });

  it('defaults to Instagram and persists the choice in its own localStorage key', () => {
    expect(switcher).toContain('opendm-switcher-channel');
    expect(switcher).toContain('localStorage.getItem(SWITCHER_CHANNEL_STORAGE_KEY)');
    expect(switcher).toContain('localStorage.setItem(SWITCHER_CHANNEL_STORAGE_KEY, switcherChannel)');
    expect(switcher).toContain('return "instagram"');
    // The automations tab's storage constant is NOT referenced here:
    // a popover tab switch must never flip the /automations list filter.
    expect(switcher).not.toContain('getItem(CHANNEL_STORAGE_KEY)');
    expect(switcher).not.toContain('setItem(CHANNEL_STORAGE_KEY,');
    expect(switcher).not.toContain('getItem("opendm-automations-channel")');
    expect(switcher).not.toContain('setItem("opendm-automations-channel"');
  });

  it('selecting one channel never clears the other channel’s selection', () => {
    // IG selection only ever calls the IG setter; FB selection only
    // ever calls the FB setter; neither setter is called with null
    // on a plain selection.
    expect(switcher).toContain('setActiveAccount(a.id); setOpen(false);');
    expect(switcher).toContain('setActiveFacebookPage(p.id); setOpen(false);');
    expect(switcher).not.toContain('setActiveAccount(null)');
    expect(switcher).not.toContain('setActiveFacebookPage(null)');
  });
});
