/**
 * Story Mention — editor wiring (2026-11-17).
 *
 * The webhook matching is covered in tests/story-mention.test.ts; this
 * file covers the builder side:
 *  (a) the New automation modal's type list offers Story Mention as an
 *      available (not Soon/disabled) trigger;
 *  (b) all five trigger types are offered — enabling Story Mention did
 *      not drop or disable any existing type.
 */

import { describe, it, expect } from 'vitest';
import { AUTOMATION_TYPES } from '@/components/automations/new-flow/constants';

describe('Story Mention in the New automation modal', () => {
  it('offers Story Mention as an available trigger', () => {
    const mention = AUTOMATION_TYPES.find((t) => t.id === 'story-mention');
    expect(mention).toBeDefined();
    expect(mention!.available).toBe(true);
    expect(mention!.name).toBe('Story Mention');
    expect(mention!.description).toContain('mention');
  });

  it('all five trigger types are offered and available', () => {
    expect(AUTOMATION_TYPES.map((t) => t.id)).toEqual([
      'comment-dm',
      'reel-dm',
      'dm-reply',
      'story-reply',
      'story-mention',
    ]);
    for (const type of AUTOMATION_TYPES) {
      expect(type.available).toBe(true);
    }
  });
});
