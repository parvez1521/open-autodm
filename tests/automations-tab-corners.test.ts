/**
 * Automations page pill corners (2026-11-22).
 *
 * Regression: the active pill (Automations, and Facebook in the
 * channel toggle) visibly overhung the pill container's rounded outer
 * corners. Cause: nested-radius mismatch. The container is rounded-lg
 * (8px) with p-0.5 (2px) padding, so a button sitting 2px inside it
 * must use 8 − 2 = 6px to stay concentric with the container's arc;
 * the buttons used 7px, so the active pill's corner arc poked past
 * the container's rounded outline. Both pill groups on the page share
 * the cause and both are pinned here. If a third pill group is ever
 * added to this page, give it the same 6px buttons or this pin will
 * (correctly) fail.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

describe('automations page pill corners', () => {
  const page = readSrc('app/(main)/automations/page.tsx');

  it('both pill groups use the nested radius (8px container − 2px padding = 6px)', () => {
    // Both groups render through the shared PillToggle (UI polish
    // 2026-11-25) — the container and the 6px button radius live in
    // the component, not inline in the page.
    expect(page.match(/<PillToggle/g)?.length).toBe(2);
    expect(page).not.toContain('bg-muted rounded-lg p-0.5');
    const toggle = readSrc('components/ui/PillToggle.tsx');
    expect(toggle).toContain('bg-muted rounded-lg p-0.5');
    expect(toggle).toContain('rounded-[6px]');
    // …and the overhanging 7px radius is gone from this page.
    expect(page).not.toContain('rounded-[7px]');
  });

  it('keeps the pill styling and behaviour otherwise unchanged', () => {
    // md is the component default — the page relies on it.
    expect(readSrc('components/ui/PillToggle.tsx')).toContain('size = "md"');
    expect(page).toContain('ariaLabel="Automation channel"');
    // The md sizing + active state live in the shared component.
    const toggle = readSrc('components/ui/PillToggle.tsx');
    expect(toggle).toContain('h-8 px-3.5');
    expect(toggle).toContain('bg-card text-foreground shadow-sm');
  });
});
