/**
 * Picker stats-row overlap fix (2026-11-25).
 *
 * Residual from UI-bugs round 2 (commit 2814628): the stronger scrim
 * made the tile caption readable, but the stats row (likes / comments /
 * date) at the very bottom edge of each picker tile still collided with
 * the thumbnails' own burned-in text — creators put lines like
 * "WATCH TILL END" or "DOWNLOAD ANY VIDEO FROM THE INTERNET" right at
 * the bottom edge, and a bright or red line still showed through the
 * black/95 gradient and fought the 10px stats. Each stat now sits on
 * its own near-solid dark chip, so it reads no matter what is behind
 * it. Caption-then-stats order, tile click behaviour, and the thumbnail
 * refresh logic are all untouched.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const picker = () =>
  readSrc('components/automations/new-flow/steps/SelectPostStep.tsx');

describe('picker tile stats row — legible over burned-in image text', () => {
  it('puts every stat (likes, comments, date) on its own dark chip', () => {
    const src = picker();
    // Three stats, three chips: likes (Heart), comments (ChatCircle),
    // date. The chip is a near-solid dark pill, not a gradient.
    const chips = src.match(/rounded-full bg-black\/70 px-1\.5 py-0\.5/g) ?? [];
    expect(chips.length).toBe(3);
    expect(src).toContain('<Heart className="w-2.5 h-2.5" />');
    expect(src).toContain('<ChatCircle className="w-2.5 h-2.5" />');
    expect(src).not.toContain('from-purple');
  });

  it('raises the overlay off the tile bottom edge', () => {
    const src = picker();
    // pb-3 instead of the old uniform p-2.5, so the stats row no
    // longer sits flush on the very bottom edge of the image.
    expect(src).toContain('px-2.5 pb-3 pt-12');
  });

  it('keeps caption above stats and the tile click unchanged', () => {
    const src = picker();
    const captionIdx = src.indexOf('line-clamp-2 leading-snug mb-1');
    const statsIdx = src.indexOf('flex items-center justify-between text-white/85');
    expect(captionIdx).toBeGreaterThan(-1);
    expect(statsIdx).toBeGreaterThan(captionIdx);
    expect(src).toContain('onClick={() => onSelect(post.id, flowName, thumbUrl ?? null, post.caption ?? "")}');
  });

  it('keeps the strong scrim and caption text-shadow from round 2', () => {
    const src = picker();
    expect(src).toContain('bg-gradient-to-t from-black/95 via-black/70 to-transparent');
    expect(src).toContain('[text-shadow:0_1px_3px_rgba(0,0,0,0.9)]');
  });
});
