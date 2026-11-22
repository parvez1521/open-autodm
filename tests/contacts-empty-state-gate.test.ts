/**
 * /contacts false-empty flash (2026-11-23, audit #12 follow-up).
 *
 * Right after a reload, /contacts briefly showed "No Contacts Yet"
 * before the 500 contacts arrived — the same false-empty class as
 * the 0080aff settings/dashboard fixes, on a page that fix did not
 * cover. Root cause, same mechanism as Item 27: ContactsList gated
 * its skeleton on `isLoading` from useContacts(), but while the
 * WorkspaceProvider scope is 'unavailable' the query is DISABLED,
 * and in TanStack Query v5 a disabled query reports isLoading false
 * with no data — so the skeleton branch was skipped and the
 * `!contacts || contacts.length === 0` branch rendered the empty
 * state until the scope resolved and data arrived. `isPending`
 * stays true while disabled-with-no-data, so the skeleton holds
 * until the contacts actually arrive. The LeadsPanel (same file,
 * same disabled-window trap via useLeads) gets the same treatment.
 *
 * Pins are source-text pins in the repo's usual UI-test style (the
 * suite runs node-only with no DOM, so components cannot be
 * rendered): if one breaks, the gate it guards regressed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const list = readSrc('components/automations/ContactsList.tsx');

describe('contacts list gates its skeleton on isPending, not isLoading', () => {
  it('useContacts is destructured as isPending (disabled queries report isLoading false)', () => {
    expect(list).toContain('const { data: contacts, isPending,');
    expect(list).not.toContain('const { data: contacts, isLoading,');
  });

  it('the skeleton branch is gated on isPending, and it precedes the empty state in the file', () => {
    const skeletonGate = list.indexOf('if (isPending) {');
    expect(skeletonGate).toBeGreaterThan(-1);
    // The JSX heading (not the comments that mention the same words).
    const emptyHeading = list.indexOf('>No Contacts Yet</h3>');
    expect(emptyHeading).toBeGreaterThan(-1);
    expect(skeletonGate).toBeLessThan(emptyHeading);
  });

  it('the empty state is only reachable after the pending gate (data resolved, still zero)', () => {
    // The empty branch reads the resolved data, not the loading flag:
    // it fires when contacts resolved to an empty list.
    expect(list).toContain('!contacts || contacts.length === 0');
  });
});

describe('leads panel gets the same pending gate', () => {
  it('useLeads is destructured as isPending (leadsPending), not isLoading', () => {
    expect(list).toContain('isPending: leadsPending');
    expect(list).not.toContain('isLoading: leadsLoading');
  });

  it('LeadsPanel receives the pending flag as its isLoading prop', () => {
    expect(list).toContain('isLoading={leadsPending}');
  });
});
