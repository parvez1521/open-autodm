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
    // Two pill containers, both rounded-lg (8px) with p-0.5 (2px).
    expect(page.match(/bg-muted rounded-lg p-0\.5/g)?.length).toBe(2);
    // Both groups' buttons use the concentric 6px radius…
    expect(page.match(/rounded-\[6px\]/g)?.length).toBe(2);
    // …and the overhanging 7px radius is gone from this page.
    expect(page).not.toContain('rounded-[7px]');
  });

  it('keeps the pill styling and behaviour otherwise unchanged', () => {
    expect(page).toContain('h-8 px-3.5');
    expect(page).toContain('bg-card text-foreground shadow-sm');
    expect(page).toContain('aria-label="Automation channel"');
  });
});
