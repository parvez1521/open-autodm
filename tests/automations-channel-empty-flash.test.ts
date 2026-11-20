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
