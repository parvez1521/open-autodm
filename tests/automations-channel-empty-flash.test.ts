/**
 * Automations channel empty-state flash (2026-11-20).
 *
 * Regression: after a reload with the Facebook channel tab selected,
 * /automations briefly showed "No Facebook Page connected" while the
 * workspace was still loading, then the Facebook automation row
 * appeared. The account/Page selection queries resolve AFTER the
 * automations query, so a null selection is indeterminate while they
 * are pending — but the page only passed the automations query's
 * isLoading to the list, so the empty state won over the skeleton.
 * The "not connected" copy must only render once the selected
 * channel's selection has settled AND is genuinely null. If these
 * pins break, the flash is back.
 *
 * v2 (2026-11-22): the v1 gate was not enough — the selection
 * queries are DISABLED (enabled: scope !== 'unavailable') until the
 * WorkspaceProvider resolves a selection, and a disabled TanStack
 * query reports isLoading === false with data undefined. So on a
 * reload the v1 gate passed while the workspace was still loading
 * and the false empty state still rendered immediately
 * (browser-verified: it appeared while the sidebar said "Loading
 * workspaces..."). The provider's `loading` flag is the
 * authoritative indeterminate signal and must be part of the gate —
 * on the automations page AND in the sidebar switcher rows, which
 * flashed the same false "No account" / "No Page connected" claims.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

describe('selection loading gates the channel empty state', () => {
  const page = readSrc('app/(main)/automations/page.tsx');

  it('reads the loading flag from both selection hooks', () => {
    expect(page).toContain('isLoading: instagramAccountsLoading');
    expect(page).toContain('isLoading: facebookPagesLoading');
  });

  it('tracks loading for the selected channel only', () => {
    expect(page).toContain('channelTab === "facebook" ? facebookPagesLoading : instagramAccountsLoading');
  });

  it('passes the combined loading flag to the list', () => {
    expect(page).toContain('isLoading={isLoading || selectionLoading}');
  });

  it('still shows the not-connected copy once loading has settled with a null selection', () => {
    expect(page).toContain('activeFacebookPageId === null');
    expect(page).toContain('accountId === null');
    expect(page).toContain('No Facebook Page connected');
    expect(page).toContain('No Instagram account selected');
  });
});

describe('AutomationsList skeleton wins over the empty state while loading', () => {
  const list = readSrc('components/automations/AutomationsList.tsx');

  it('renders the skeleton on isLoading before any empty state can render', () => {
    const loadingAt = list.indexOf('if (isLoading) {');
    const emptyAt = list.indexOf('if (automations.length === 0) {');
    expect(loadingAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(loadingAt).toBeLessThan(emptyAt);
  });
});

describe('v2: workspace loading gates the selection (disabled queries report isLoading === false)', () => {
  const page = readSrc('app/(main)/automations/page.tsx');
  const switcher = readSrc('components/dashboard/AccountSwitcher.tsx');

  it('the automations page reads the WorkspaceProvider loading flag', () => {
    expect(page).toContain('useWorkspace');
    expect(page).toContain('loading: workspaceLoading');
  });

  it('the page gate includes workspace loading before the per-channel query flag', () => {
    expect(page).toContain(
      'workspaceLoading || (channelTab === "facebook" ? facebookPagesLoading : instagramAccountsLoading)',
    );
  });

  it('the switcher reads the workspace loading flag and both selection query flags', () => {
    expect(switcher).toContain('loading: workspaceLoading');
    expect(switcher).toContain('isLoading: instagramAccountsLoading');
    expect(switcher).toContain('isLoading: facebookPagesLoading');
  });

  it('the switcher gates each trigger row on its own channel loading state', () => {
    expect(switcher).toContain('workspaceLoading || instagramAccountsLoading');
    expect(switcher).toContain('workspaceLoading || facebookPagesLoading');
    expect(switcher).toContain('igLoading');
    expect(switcher).toContain('fbLoading');
  });

  it('the switcher shows a loading placeholder, not a not-connected claim, while loading', () => {
    expect(switcher).toContain('animate-pulse');
    expect(switcher).toContain('Loading…');
  });

  it('the settled not-connected copy still exists for a genuinely null selection', () => {
    expect(switcher).toContain('No account');
    expect(switcher).toContain('No Page connected');
    expect(switcher).toContain('Nothing connected yet.');
    expect(switcher).toContain('No Page connected yet.');
  });
});
