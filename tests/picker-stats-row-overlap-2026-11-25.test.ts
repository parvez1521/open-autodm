/**
 * Picker stats-row overlap — SUPERSEDED by the below-image restructure
 * (2026-11-25, tests/picker-tiles-below-image-2026-11-25.test.ts).
 *
 * This file originally pinned the 2026-11-25 stats-row fix: each stat on
 * its own near-solid dark chip over the image. That fix FAILED live the
 * same night — the pills made the numbers legible, but they do not mask
 * the thumbnails' own burned-in text on the same bottom band, so the row
 * still visually merged with it ("Higgsfield is dead" read as
 * "♡1dea 💬0ow, Nov 12"). Both overlay treatments (strong scrim, then
 * dark chips) are now gone: caption + stats render BELOW the thumbnail
 * on the solid card surface. The pins below assert the replacement, not
 * the overlay.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const picker = () =>
  readSrc('components/automations/new-flow/steps/SelectPostStep.tsx');

describe('picker tile stats row — plain text below the image, no overlay', () => {
  it('stats are plain muted text on the solid card surface, not dark chips', () => {
    const src = picker();
    // The chips died with the overlay — on a solid surface they are
    // unnecessary, and they were the thing that still merged with
    // burned-in text.
    expect(src).not.toContain('rounded-full bg-black/70');
    expect(src).toContain('flex items-center justify-between text-muted-foreground text-[10px]');
    expect(src).toContain('<Heart className="w-2.5 h-2.5" />');
    expect(src).toContain('<ChatCircle className="w-2.5 h-2.5" />');
    expect(src).not.toContain('from-purple');
  });

  it('the text area sits below the image, lifted off its bottom edge', () => {
    const src = picker();
    // No absolute bottom overlay at all; the text block is a normal
    // sibling below the image container.
    expect(src).not.toContain('absolute bottom-0');
    expect(src).toContain('px-2.5 py-2 bg-card');
  });

  it('keeps caption above stats and the tile click unchanged', () => {
    const src = picker();
    const captionIdx = src.indexOf('truncateWithEllipsis(post.caption, 70)');
    const statsIdx = src.indexOf('flex items-center justify-between text-muted-foreground');
    expect(captionIdx).toBeGreaterThan(-1);
    expect(statsIdx).toBeGreaterThan(captionIdx);
    expect(src).toContain('onClick={() => onSelect(post.id, flowName, thumbUrl ?? null, post.caption ?? "")}');
  });

  it('the scrim and text-shadows are gone — the overlay approach is over', () => {
    const src = picker();
    expect(src).not.toContain('bg-gradient-to-t from-black/95');
    expect(src).not.toContain('[text-shadow:');
  });
});
