/**
 * Picker tiles rebuilt: caption + stats below the image (2026-11-25).
 *
 * Two overlay treatments failed in a row. Round 2 (commit 2814628)
 * strengthened the scrim (black/95 via black/70 + caption text-shadow)
 * — captions became readable, but the stats row still collided with
 * burned-in image text. The follow-up (commit 7f6fcfe) put each stat on
 * a near-solid dark chip — live verification 2026-11-25 ~00:11 IST
 * verdict: FAIL, partial only. The numbers were legible in their pills,
 * but the pills do not mask the thumbnails' own on-image text on the
 * same bottom band, so the row still visually merged with it — worst
 * case the "Higgsfield is dead" tile read "♡1dea 💬0ow, Nov 12", and
 * the Flight tile stayed cluttered with green on-image text showing
 * through behind/around the caption and stats.
 *
 * Root cause: creators burn text into arbitrary parts of the image,
 * including the exact bottom band — NO overlay treatment (scrim, chips,
 * shadows) can ever fully win. So the tile is restructured: the
 * thumbnail is a clean image, and caption + stats render BELOW it in a
 * solid dark card area. The only things still on the image are the two
 * icon-only badges (media-type, selection check) on solid dark circles
 * — they carry no text and cannot merge with burned-in text.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const picker = () =>
  readSrc('components/automations/new-flow/steps/SelectPostStep.tsx');

describe('picker tiles — caption + stats below the image, nothing overlaid', () => {
  it('has no text overlay on the thumbnail: no scrim, no bottom overlay, no text-shadow', () => {
    const src = picker();
    expect(src).not.toContain('bg-gradient-to-t from-black/95');
    expect(src).not.toContain('from-black/95 via-black/70');
    expect(src).not.toContain('absolute bottom-0');
    expect(src).not.toContain('[text-shadow:');
    expect(src).not.toContain('rounded-full bg-black/70');
  });

  it('renders caption + stats in a solid card area below the image container', () => {
    const src = picker();
    const imageIdx = src.indexOf('<div className="aspect-[4/5] relative bg-muted w-full overflow-hidden">');
    const textAreaIdx = src.indexOf('<div className="px-2.5 py-2 bg-card">');
    const captionIdx = src.indexOf('truncateWithEllipsis(post.caption, 70)');
    const statsIdx = src.indexOf('flex items-center justify-between text-muted-foreground text-[10px]');
    expect(imageIdx).toBeGreaterThan(-1);
    expect(textAreaIdx).toBeGreaterThan(imageIdx);
    expect(captionIdx).toBeGreaterThan(textAreaIdx);
    expect(statsIdx).toBeGreaterThan(captionIdx);
    // Solid surface, not a gradient, not purple.
    expect(src).not.toContain('from-purple');
  });

  it('caption keeps round-2 truncation (70 chars + ellipsis) and a full-text tooltip', () => {
    const src = picker();
    expect(src).toContain('truncateWithEllipsis(post.caption, 70)');
    expect(src).toContain('title={post.caption || undefined}');
    expect(src).toContain('line-clamp-2 leading-snug mb-1');
  });

  it('stats stay likes / comments / date, in that order, as plain text', () => {
    const src = picker();
    expect(src).toContain('<Heart className="w-2.5 h-2.5" />{post.like_count.toLocaleString()}');
    expect(src).toContain('<ChatCircle className="w-2.5 h-2.5" />{post.comments_count.toLocaleString()}');
    expect(src).toContain('toLocaleDateString("en-US", { month: "short", day: "numeric" })');
  });

  it('tile click behaviour is unchanged', () => {
    const src = picker();
    expect(src).toContain('onClick={() => onSelect(post.id, flowName, thumbUrl ?? null, post.caption ?? "")}');
  });

  it('keeps the icon-only badges on the image (type + selection check), no text in them', () => {
    const src = picker();
    expect(src).toContain('absolute top-2 right-2 w-6 h-6 rounded-full bg-black/55');
    expect(src).toContain('absolute top-2 left-2 w-6 h-6 bg-foreground rounded-full');
    expect(src).toContain('post.type === "reel" ? <PlayCircle');
  });

  it('loading skeletons match the new tile shape (image + text bars)', () => {
    const src = picker();
    const skeletonIdx = src.indexOf('animate-[shimmer_1.5s_infinite]');
    const barsIdx = src.indexOf('h-3 w-4/5 rounded bg-muted/60');
    expect(skeletonIdx).toBeGreaterThan(-1);
    expect(barsIdx).toBeGreaterThan(skeletonIdx);
  });
});
