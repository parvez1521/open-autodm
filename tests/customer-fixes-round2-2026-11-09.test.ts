/**
 * Customer-journey fixes, round 2 (2026-11-09) — source pins for
 * the UI-layer items (the suite is node-only, no DOM; component
 * fixes are pinned at source level, the repo's established pattern
 * — see customer-fixes-ui-2026-11-09.test.ts).
 *
 *  1  /forgot-password tells ONE story: the reset form + how reset
 *     works. No "reset is disabled / ask your admin" notice exists
 *     on either surface (the standalone page and the /login forgot
 *     toggle share the one ForgotPasswordForm and subheading).
 *  2  BillingPanel follows the console's shared workspace
 *     selection (the WorkspaceProvider's persisted localStorage
 *     key), forgets a stale selection on 403 not-a-member, and
 *     never renders the previous workspace's plan while a switch
 *     loads.
 *  3  No transient error flicker: the dashboard plan card and
 *     /analytics key their loading branch off React Query's
 *     isPending (a scope-disabled query is pending, not failed);
 *     the WorkspaceProvider's list load starts in the loading
 *     state and the switcher renders loading, not "0 workspaces".
 *  4  Dashboard subheading is hosted-product copy, not
 *     "self-hosted".
 *  5  Member Role/Remove accessible names carry the member's
 *     display identity, never the raw member UUID.
 *  6  Studio Ideas: category defaults to none — generation
 *     resolves the blank to the neutral "Other" bucket so the
 *     topic drives the output.
 *  7  /analytics default range is one named constant: 30 days.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readSrc(rel: string): string {
  return readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');
}

describe('R2-1 — forgot-password tells one consistent story', () => {
  const panel = readSrc('components/auth/ForgotPasswordPanel.tsx');
  const form = readSrc('components/auth/ForgotPasswordForm.tsx');
  const login = readSrc('components/auth/LoginForm.tsx');

  it('no reset-disabled / ask-your-admin notice exists on any auth surface', () => {
    for (const src of [panel, form, login]) {
      expect(src).not.toContain('reset is disabled');
      expect(src).not.toContain('Reset is disabled');
      expect(src).not.toContain('Ask your admin');
      expect(src).not.toContain('restore access');
      expect(src).not.toContain('standalone installation');
    }
  });

  it('both surfaces render the shared form under the same how-reset-works line', () => {
    expect(panel).toContain('ForgotPasswordForm');
    expect(panel).toContain('We will email you a link to choose a new one.');
    expect(login).toContain('ForgotPasswordForm');
    expect(login).toContain('We will email you a link to choose a new one.');
    // The form itself completes the story: the sent state explains
    // the emailed link and the new-password step.
    expect(form).toContain('we sent it a');
    expect(form).toContain('reset link');
  });
});

describe('R2-2 — BillingPanel follows the shared workspace selection', () => {
  const src = readSrc('components/billing/BillingPanel.tsx');

  it('reads and writes the WorkspaceProvider selection key', () => {
    expect(src).toContain('WORKSPACE_SELECTION_STORAGE_KEY');
    expect(src).toContain('localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)');
    expect(src).toContain('localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, id)');
    expect(src).toContain('void load(stored);');
  });

  it('a stale selection (403 not-a-member) is forgotten, not an error', () => {
    expect(src).toContain('"stale-workspace"');
    expect(src).toContain('data?.code === "not-a-member"');
    expect(src).toContain('localStorage.removeItem(WORKSPACE_SELECTION_STORAGE_KEY)');
  });

  it('a workspace switch drops the previous payload before loading (no stale plan)', () => {
    expect(src).toContain('prev.workspaceId !== wsId ? null : prev');
    expect(src).toContain('if (loading && !status)');
  });
});

describe('R2-3 — loading is modelled as loading, never as an error or an empty list', () => {
  it('dashboard plan card: skeleton on isPending, error copy only on isError', () => {
    const page = readSrc('app/(main)/dashboard/page.tsx');
    expect(page).toContain('isPending: billingPending');
    expect(page).toContain('billingPending ? (');
    expect(page).not.toContain('billingLoading');
  });

  it('/analytics: the spinner branch keys off isPending, before the error branch', () => {
    const page = readSrc('app/(main)/analytics/page.tsx');
    expect(page).toContain('isPending || (workspaceRuntimeEnabled && workspaceLoading) ? (');
    expect(page.indexOf('isPending ||')).toBeLessThan(page.indexOf('isError || !data ? ('));
  });

  it('the workspace list load starts in the loading state when the runtime is on', () => {
    const provider = readSrc('components/workspace/WorkspaceProvider.tsx');
    expect(provider).toContain('useState(workspaceRuntimeEnabled)');
  });

  it('the switcher renders a load in flight as loading, not as zero workspaces', () => {
    const switcher = readSrc('components/workspace/WorkspaceSwitcher.tsx');
    expect(switcher).toContain('? "Loading…"');
    expect(switcher).toContain('loading ? "Loading workspaces…" : "No workspaces yet."');
  });
});

describe('R2-4 — dashboard copy is the hosted product', () => {
  it('no self-hosted claim; the landing line is reused', () => {
    const page = readSrc('app/(main)/dashboard/page.tsx');
    expect(page).not.toContain('self-hosted Instagram automation console');
    expect(page).toContain('Turn comments into customers on autopilot.');
  });
});

describe('R2-5 — member accessible names use the display identity, never the UUID', () => {
  const src = readSrc('components/workspace/WorkspaceMembers.tsx');
  it('Role and Remove labels resolve through memberLabel', () => {
    expect(src).toContain('const memberLabel = m.email ?? `member ${idx + 1}`;');
    expect(src).toContain('aria-label={`Role for ${memberLabel}`}');
    expect(src).toContain('aria-label={`Remove ${memberLabel}`}');
    expect(src).not.toContain('m.email ?? m.userId');
  });
});

describe('R2-6 — Studio Ideas category defaults to none', () => {
  const page = readSrc('app/(main)/studio/ideas/page.tsx');
  it('the state starts blank with an explicit any-category option', () => {
    expect(page).toContain('useState<StudioCategory | "">("")');
    expect(page).toContain('<option value="">Any category — topic decides</option>');
    expect(page).not.toContain('useState<StudioCategory>("Tech & AI Tools")');
  });
  it('generation resolves the blank to the neutral bucket, so the topic drives it', () => {
    expect(page).toContain('const effectiveCategory: StudioCategory = category === "" ? "Other" : category;');
    expect(page).toContain('generateIdeas({ topic, category: effectiveCategory, mode, count: 8 })');
    expect(page).toContain('requestAiIdeas({ topic, category: effectiveCategory, mode, count: 8 })');
  });
});

describe('R2-7 — /analytics default range is uniformly 30 days', () => {
  it('the default is one named constant, used by the range state', () => {
    const page = readSrc('app/(main)/analytics/page.tsx');
    expect(page).toContain('const DEFAULT_RANGE_DAYS = 30;');
    expect(page).toContain('useState<number>(DEFAULT_RANGE_DAYS)');
    expect(page).not.toContain('useState<number>(7)');
  });
  it('the API route default window agrees (30d)', () => {
    const route = readSrc('app/api/analytics/route.ts');
    expect(route).toContain('30 * 86400_000');
  });
});
