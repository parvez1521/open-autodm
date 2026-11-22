/**
 * UI-bugs audit fixes (2026-11-22 evening, live audit of opendm.in).
 *
 * Twelve bugs, eleven fixes — #9 (the two thumbnail-less IG rows) is
 * NOT a bug and is untouched. The pins below are source-text pins in
 * the repo's usual style: if one breaks, the fix it guards regressed.
 *
 *  #1  Orphaned "Choose a post" picker: closing the editor left the
 *      step-1 picker floating — the outer AnimatePresence child was a
 *      plain unkeyed div and the inner step transition used
 *      mode="wait", so the close deadlocked on the exiting step child.
 *      The outer child is now a keyed motion.div and the step
 *      transition uses the default (sync) mode.
 *  #2  Escape did not dismiss the "New automation" dialog (no keydown
 *      listener at all). It calls handleClose now.
 *  #3  /settings flashed "No accounts/Pages connected yet" on arrival:
 *      both list queries are disabled while the workspace scope is
 *      'unavailable', and a disabled query reports isLoading false.
 *      Both sections gate on the WorkspaceProvider loading flag now.
 *  #4  /dashboard flashed 0s + unchecked Getting-started steps for
 *      the same reason. Stats, System rows and the checklist all gate
 *      on the workspace loading flag; the checklist renders neutral
 *      skeleton rows while loading.
 *  #5  /contacts 404d with no sidebar entry. New (main)/contacts
 *      route renders the same ContactsList the /automations tab does.
 *  #6  /analytics "1 already follow you" — singular/plural-aware now.
 *  #7  Helper strings cut off mid-sentence: the accordion animated
 *      height 0 -> "auto" (measured once at open), so content that
 *      appeared later clipped; the settings IG/FB header text divs
 *      lacked min-w-0, so the flex row overflowed at narrow widths.
 *      (#7d billing note / #7e analytics footnote: no truncation
 *      mechanism exists in code — plain wrapping <p>s — so they are
 *      reported unverified, with no change.)
 *  #8  DM preview bubbles are overflow-hidden; a long unbreakable run
 *      (pasted URL) was hard-cut mid-word. Bubble text wraps now.
 *  #10 IgAvatar showed "_" for @_caption.it (first char of the
 *      username). The initial is the first letter/digit now.
 *  #11 /billing used the marketing shell instead of the app sidebar.
 *      The route moved to the (main) group (URL unchanged) with
 *      middleware protection.
 *  #12 Recent Activity showed "No recent events" while the page
 *      reported 99 DMs / 80 comments: useActivity issued a plain
 *      unscoped call that 400d on the fail-closed workspace context.
 *      It rides the workspace scope like its siblings now, and the
 *      feed keys off isPending with an honest error branch.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const readTest = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'tests', rel), 'utf8');

describe('#1 + #2 — NewAutomationModal close is deterministic, Escape works', () => {
  const modal = readSrc('components/automations/new-flow/NewAutomationModal.tsx');

  it('outer AnimatePresence child is a keyed motion.div, not a plain div', () => {
    expect(modal).toContain('<motion.div key="editor" data-no-reveal');
    expect(modal).not.toContain('<div data-no-reveal className="fixed inset-0 z-[200]');
  });

  it('inner step transition does not use mode="wait"', () => {
    expect(modal).not.toContain('<AnimatePresence mode="wait">');
  });

  it('Escape dismisses the dialog via handleClose', () => {
    expect(modal).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(modal).toContain('if (e.key !== "Escape") return;');
    expect(modal).toContain('handleClose();');
  });
});

describe('#3 — settings empty states gate on the workspace loading flag', () => {
  const settings = readSrc('app/(main)/settings/page.tsx');

  it('reads the WorkspaceProvider loading flag', () => {
    expect(settings).toContain('const { loading: workspaceLoading } = useWorkspace();');
  });

  it('both account lists stay on skeletons while the workspace resolves', () => {
    expect(settings).toContain('{isLoading || workspaceLoading ? (');
    expect(settings).toContain('{fbLoading || workspaceLoading ? (');
  });
});

describe('#4 — dashboard never flashes false zeros or unchecked steps', () => {
  const dashboard = readSrc('components/dashboard/DashboardClient.tsx');

  it('stats and system gates include the workspace loading flag', () => {
    expect(dashboard).toContain(
      'const statsLoading = workspaceLoading || automationsLoading || contactsLoading || analyticsLoading;'
    );
    expect(dashboard).toContain(
      'const systemLoading = workspaceLoading || setupLoading || automationsLoading;'
    );
  });

  it('the checklist renders neutral skeleton rows while loading, not unchecked boxes', () => {
    expect(dashboard).toContain('const checklistLoading = workspaceLoading ||');
    expect(dashboard).toContain('{checklistLoading ? (');
    expect(dashboard).toContain('"Loading your setup…"');
  });
});

describe('#5 — /contacts exists, in the sidebar, behind auth', () => {
  it('the (main)/contacts route renders the existing ContactsList', () => {
    const page = readSrc('app/(main)/contacts/page.tsx');
    expect(page).toContain('ContactsList');
    expect(page).toContain('import { ContactsList } from "@/components/automations/ContactsList";');
  });

  it('the sidebar has a Contacts entry pointing at /contacts', () => {
    const sidebar = readSrc('components/dashboard/Sidebar.tsx');
    expect(sidebar).toContain('{ name: "Contacts", href: "/contacts", icon: User, external: false },');
  });

  it('middleware protects /contacts like the other console routes', () => {
    expect(readSrc('middleware.ts')).toContain("pathname.startsWith('/contacts')");
  });

  it('the /automations Contacts tab still renders the same list (no fork)', () => {
    expect(readSrc('app/(main)/automations/page.tsx')).toContain('<ContactsList />');
  });
});

describe('#6 — analytics NEW CONTACTS grammar', () => {
  it('says "1 already follows you" for a single new-contact follower', () => {
    const analytics = readSrc('app/(main)/analytics/page.tsx');
    expect(analytics).toContain(
      'totals.newContactFollowers === 1 ? "1 already follows you" : `${totals.newContactFollowers} already follow you`'
    );
  });
});

describe('#7 — helper strings are never clipped', () => {
  it('accordion sections size intrinsically (grid-rows), not by a measured height animation', () => {
    const configure = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');
    expect(configure).toContain('grid-rows-[1fr]');
    expect(configure).toContain('grid-rows-[0fr]');
    expect(configure).toContain('aria-hidden={!open}');
  });

  it('settings IG + FB header text divs can shrink (min-w-0), like the Meta app / Session headers', () => {
    const settings = readSrc('app/(main)/settings/page.tsx');
    expect(settings).toContain(
      '<div className="min-w-0">\n                        <h2 className="text-[14px] font-heading font-semibold text-foreground">Instagram accounts</h2>'
    );
    expect(settings).toContain(
      '<div className="min-w-0">\n                        <h2 className="text-[14px] font-heading font-semibold text-foreground">Facebook Pages</h2>'
    );
  });
});

describe('#8 — DM preview bubbles wrap instead of cutting mid-word', () => {
  it('opening, ask-to-follow, response and trigger bubbles break long words', () => {
    const phones = readSrc('components/automations/new-flow/steps/PhoneComponents.tsx');
    expect(phones).toContain('whitespace-pre-line break-words px-3 py-2.5">{openingMessage}</p>');
    expect(phones).toContain('text-[11px] leading-relaxed break-words px-3 py-2.5');
    expect(phones).toContain('whitespace-pre-line break-words px-3 py-2.5">{resp.content');
    expect(phones).toContain('text-[12px] font-medium break-words">{trigger.text');
  });
});

describe('#10 — IgAvatar initial is a letter/digit, never "_"', () => {
  it('strips leading non-alphanumerics before taking the initial', () => {
    const avatar = readSrc('components/dashboard/IgAvatar.tsx');
    expect(avatar).toContain('.replace(/^[^a-zA-Z0-9]+/, "")');
    expect(avatar).not.toContain('username?.trim().charAt(0).toUpperCase()');
  });

  it('the rule maps _caption.it to C and a punctuation-only name to the glyph fallback', () => {
    const initial = (username: string | null | undefined) =>
      username?.trim().replace(/^[^a-zA-Z0-9]+/, '').charAt(0).toUpperCase();
    expect(initial('_caption.it')).toBe('C');
    expect(initial('@beyond_the.feed')).toBe('B');
    expect(initial('___')).toBe('');
    expect(initial(null)).toBeUndefined();
  });
});

describe('#11 — /billing lives in the app shell', () => {
  it('the route moved from (saas) to (main); the URL is unchanged', () => {
    expect(existsSync(path.resolve(process.cwd(), 'src/app/(main)/billing/page.tsx'))).toBe(true);
    expect(existsSync(path.resolve(process.cwd(), 'src/app/(saas)/billing'))).toBe(false);
  });

  it('journey model, panel comment and customer-journey test name the new location', () => {
    expect(readSrc('lib/tenancy/journey.ts')).toContain('Live at (main)/billing');
    expect(readSrc('components/billing/BillingPanel.tsx')).toContain(
      'Rendered by src/app/(main)/billing/page.tsx'
    );
    expect(readTest('customer-journey.test.ts')).toContain(
      "renderPage('src/app/(main)/billing/page.tsx')"
    );
  });

  it('middleware protects /billing now that it is a console route', () => {
    expect(readSrc('middleware.ts')).toContain("pathname.startsWith('/billing')");
  });
});

describe('#12 — Recent Activity rides the workspace scope', () => {
  it('useActivity uses the scoped transport with the readiness gate, not a plain apiClient call', () => {
    const hook = readSrc('hooks/useActivity.ts');
    expect(hook).toContain('sendWorkspaceRequest');
    expect(hook).toContain('workspaceRequestScopeFromSelection');
    expect(hook).toContain("enabled: requestScope.kind !== 'unavailable'");
    expect(hook).not.toContain("from '@/lib/api/client'");
  });

  it('the dashboard feed keys off isPending and has an honest error branch', () => {
    const dashboard = readSrc('components/dashboard/DashboardClient.tsx');
    expect(dashboard).toContain('isPending: isActivityPending');
    expect(dashboard).toContain('isError: isActivityError');
    expect(dashboard).toContain("Activity couldn&apos;t be loaded.");
    expect(dashboard).toContain('refetchActivity');
  });
});
