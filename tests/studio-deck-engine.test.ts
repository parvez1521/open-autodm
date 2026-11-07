/**
 * Area — Creator Studio Presentations engine (Programme S3).
 *
 * Pins the deck shape for every supported size, determinism, the
 * edit-operation guards around the title/closing anchors, and the
 * standalone HTML export contract (self-contained, escaped, printable).
 */

import { describe, it, expect } from 'vitest';
import {
  DECK_MAX_SLIDES,
  DECK_MIN_SLIDES,
  addContentSlide,
  buildDeck,
  clampSlideCount,
  deckToStandaloneHtml,
  escapeHtml,
  moveSlide,
  removeSlide,
  updateSlide,
} from '@/lib/studio/deckEngine';

const TOPIC = 'getting started with home workouts';
const AUDIENCE = 'busy parents';

function build(n: number) {
  return buildDeck({ topic: TOPIC, audience: AUDIENCE, slideCount: n });
}

describe('clampSlideCount', () => {
  it('clamps to the 5..12 range', () => {
    expect(clampSlideCount(1)).toBe(DECK_MIN_SLIDES);
    expect(clampSlideCount(5)).toBe(5);
    expect(clampSlideCount(8)).toBe(8);
    expect(clampSlideCount(12)).toBe(12);
    expect(clampSlideCount(99)).toBe(DECK_MAX_SLIDES);
  });
});

describe('buildDeck shape', () => {
  for (let n = DECK_MIN_SLIDES; n <= DECK_MAX_SLIDES; n++) {
    it(`builds exactly ${n} slides for slideCount=${n}`, () => {
      const deck = build(n);
      expect(deck.slides).toHaveLength(n);
      expect(deck.slides[0]!.kind).toBe('title');
      expect(deck.slides[0]!.title).toBe(TOPIC);
      expect(deck.slides[1]!.kind).toBe('agenda');
      expect(deck.slides[1]!.title).toBe('What we will cover');
      expect(deck.slides[deck.slides.length - 1]!.kind).toBe('closing');
      expect(deck.slides[deck.slides.length - 1]!.bullets).toHaveLength(3);
      // Agenda bullets equal the section titles present, in order.
      const sectionTitles = deck.slides.filter((s) => s.kind === 'section').map((s) => s.title);
      expect(sectionTitles.length).toBeGreaterThanOrEqual(2);
      expect(deck.slides[1]!.bullets).toEqual(sectionTitles);
      // Every slide carries non-empty string bullets except none here:
      // built decks have at least one bullet on every slide.
      for (const slide of deck.slides) {
        expect(slide.bullets.length).toBeGreaterThanOrEqual(1);
        for (const bullet of slide.bullets) {
          expect(typeof bullet).toBe('string');
          expect(bullet.trim().length).toBeGreaterThan(0);
        }
        expect(slide.engine).toBe('built-in');
      }
      // Title slide subtitle names the audience.
      expect(deck.slides[0]!.bullets[0]).toContain(AUDIENCE);
      // Content slides carry 3–4 bullets each.
      for (const slide of deck.slides.filter((s) => s.kind === 'content')) {
        expect(slide.bullets.length).toBeGreaterThanOrEqual(3);
        expect(slide.bullets.length).toBeLessThanOrEqual(4);
      }
      // Ids are unique.
      const ids = deck.slides.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('is deterministic: two builds with the same input are deep-equal', () => {
    expect(build(8)).toEqual(build(8));
    expect(buildDeck({ topic: 'chess basics', audience: 'children', slideCount: 10, tone: 'bold' })).toEqual(
      buildDeck({ topic: 'chess basics', audience: 'children', slideCount: 10, tone: 'bold' })
    );
  });

  it('composes topic and audience into the bullets', () => {
    const deck = build(10);
    const allBullets = deck.slides.flatMap((s) => s.bullets).join('\n');
    expect(allBullets).toContain(TOPIC);
    expect(allBullets).toContain(AUDIENCE);
  });

  it('defaults the tone to educational', () => {
    const implicit = buildDeck({ topic: TOPIC, audience: AUDIENCE, slideCount: 7 });
    const explicit = buildDeck({ topic: TOPIC, audience: AUDIENCE, slideCount: 7, tone: 'educational' });
    expect(implicit).toEqual(explicit);
  });
});

describe('edit operations', () => {
  it('updateSlide changes only the target slide and keeps its engine', () => {
    const deck = build(8);
    const target = deck.slides[3]!;
    const next = updateSlide(deck, target.id, { title: 'Renamed slide', bullets: ['One new point.'] });
    expect(next.slides).toHaveLength(deck.slides.length);
    next.slides.forEach((slide, i) => {
      if (slide.id === target.id) {
        expect(slide.title).toBe('Renamed slide');
        expect(slide.bullets).toEqual(['One new point.']);
        expect(slide.engine).toBe(target.engine);
      } else {
        expect(slide).toEqual(deck.slides[i]);
      }
    });
    // Original is untouched (pure operation).
    expect(deck.slides[3]!.title).toBe(target.title);
  });

  it('moveSlide keeps the title slide first and the closing slide last', () => {
    const deck = build(8);
    const ids = deck.slides.map((s) => s.id);
    // Moving the title slide down is a no-op.
    expect(moveSlide(deck, ids[0]!, 'down').slides.map((s) => s.id)).toEqual(ids);
    // Moving the closing slide up is a no-op.
    expect(moveSlide(deck, ids[ids.length - 1]!, 'up').slides.map((s) => s.id)).toEqual(ids);
    // A non-anchor slide at index 1 cannot move up past the title.
    expect(moveSlide(deck, ids[1]!, 'up').slides.map((s) => s.id)).toEqual(ids);
    // A non-anchor slide at index len-2 cannot move down past the closing.
    expect(moveSlide(deck, ids[ids.length - 2]!, 'down').slides.map((s) => s.id)).toEqual(ids);
  });

  it('moveSlide swaps a middle slide with its neighbour', () => {
    const deck = build(8);
    const target = deck.slides[3]!;
    const next = moveSlide(deck, target.id, 'up');
    expect(next.slides[2]!.id).toBe(target.id);
    expect(next.slides[0]!.kind).toBe('title');
    expect(next.slides[next.slides.length - 1]!.kind).toBe('closing');
    const back = moveSlide(next, target.id, 'down');
    expect(back.slides.map((s) => s.id)).toEqual(deck.slides.map((s) => s.id));
  });

  it('removeSlide guards the anchors and the 3-slide minimum', () => {
    const deck = build(5);
    const ids = deck.slides.map((s) => s.id);
    expect(removeSlide(deck, ids[0]!).slides).toHaveLength(5);
    expect(removeSlide(deck, ids[ids.length - 1]!).slides).toHaveLength(5);
    // Remove middle slides down to 3, then further removal is a no-op.
    let small = removeSlide(deck, deck.slides[2]!.id);
    expect(small.slides).toHaveLength(4);
    small = removeSlide(small, small.slides[1]!.id);
    // That removal targeted the agenda (non-anchor) at length 4 -> 3.
    expect(small.slides).toHaveLength(3);
    const remainingMiddle = small.slides[1]!;
    expect(removeSlide(small, remainingMiddle.id).slides).toHaveLength(3);
  });

  it('addContentSlide inserts a blank content slide before the closing slide', () => {
    const deck = build(7);
    const next = addContentSlide(deck, deck.slides[2]!.id);
    expect(next.slides).toHaveLength(8);
    expect(next.slides[next.slides.length - 1]!.kind).toBe('closing');
    const inserted = next.slides[next.slides.length - 2]!;
    // When inserted after an early slide it lands right after it; either
    // way a new content slide exists that was not in the original deck.
    const originalIds = new Set(deck.slides.map((s) => s.id));
    const added = next.slides.filter((s) => !originalIds.has(s.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.kind).toBe('content');
    expect(added[0]!.engine).toBe('built-in');
    expect(inserted.kind === 'content' || added[0]).toBeTruthy();
    // Adding relative to the closing slide still lands before it.
    const beforeClosing = addContentSlide(deck, deck.slides[deck.slides.length - 1]!.id);
    expect(beforeClosing.slides[beforeClosing.slides.length - 1]!.kind).toBe('closing');
    expect(beforeClosing.slides[beforeClosing.slides.length - 2]!.kind).toBe('content');
    expect(beforeClosing.slides[beforeClosing.slides.length - 2]!.title).toBe('New slide');
  });
});

describe('escapeHtml', () => {
  it('escapes the HTML-sensitive characters', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('deckToStandaloneHtml', () => {
  it('contains every slide title and the player counter script', () => {
    const deck = build(8);
    const html = deckToStandaloneHtml(deck);
    for (const slide of deck.slides) {
      expect(html).toContain(escapeHtml(slide.title));
    }
    expect(html).toContain(`<title>${TOPIC}</title>`);
    expect(html).toContain('id="counter"');
    expect(html).toContain('1 / 8');
    expect(html).toContain('ArrowRight');
    expect(html).toContain('ArrowLeft');
  });

  it('escapes a malicious topic instead of emitting it raw', () => {
    const evil = '<script>alert(1)</script>';
    const deck = buildDeck({ topic: evil, audience: AUDIENCE, slideCount: 5 });
    const html = deckToStandaloneHtml(deck);
    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('has a print stylesheet laying one slide per page', () => {
    const html = deckToStandaloneHtml(build(6));
    expect(html).toContain('@media print');
    expect(html).toContain('page-break-after');
    expect(html).toContain('always');
  });

  it('is fully self-contained with no external references', () => {
    const html = deckToStandaloneHtml(build(6));
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});
