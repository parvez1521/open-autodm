/**
 * Area — Instagram post-link helpers (src/lib/instagram/postUrl.ts).
 *
 * The picker list only ever shows posts the connected account OWNS
 * (Graph API /{ig-user-id}/media), so a collab reel owned by the
 * other account can only be selected by pasting its link. These
 * helpers are the URL side of that path: extract the shortcode from
 * whatever link form the user pastes, and decode it to the numeric
 * media ID (the shortcode IS the media ID in base-64).
 */

import { describe, expect, it } from 'vitest';
import {
  decodeInstagramShortcode,
  encodeInstagramShortcode,
  extractInstagramShortcode,
  normalizeInstagramPostUrl,
} from '@/lib/instagram/postUrl';

describe('extractInstagramShortcode', () => {
  it('accepts /p/ links, with or without trailing slash and query params', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/p/DfuQz-VKO0y/')).toBe('DfuQz-VKO0y');
    expect(extractInstagramShortcode('https://www.instagram.com/p/DfuQz-VKO0y')).toBe('DfuQz-VKO0y');
    expect(
      extractInstagramShortcode('https://www.instagram.com/p/DfuQz-VKO0y/?igsh=abc123&utm_source=ig_web_copy_link'),
    ).toBe('DfuQz-VKO0y');
    expect(extractInstagramShortcode('https://instagram.com/p/DfuQz-VKO0y/')).toBe('DfuQz-VKO0y');
  });

  it('accepts /reel/ links (the form the app hands out for reels)', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/reel/DfuQz-VKO0y/')).toBe('DfuQz-VKO0y');
    expect(extractInstagramShortcode('https://www.instagram.com/reels/DfuQz-VKO0y/')).toBe('DfuQz-VKO0y');
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractInstagramShortcode('  https://www.instagram.com/p/DfuQz-VKO0y/  ')).toBe('DfuQz-VKO0y');
  });

  it('rejects non-Instagram hosts', () => {
    expect(extractInstagramShortcode('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(extractInstagramShortcode('https://notinstagram.com/p/DfuQz-VKO0y/')).toBeNull();
    expect(extractInstagramShortcode('https://instagram.com.evil.example/p/DfuQz-VKO0y/')).toBeNull();
  });

  it('rejects profile, explore and other non-post paths', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/beyond_the.feed/')).toBeNull();
    expect(extractInstagramShortcode('https://www.instagram.com/explore/')).toBeNull();
    expect(extractInstagramShortcode('https://www.instagram.com/p/')).toBeNull();
    expect(extractInstagramShortcode('https://www.instagram.com/p')).toBeNull();
  });

  it('rejects garbage and empty input', () => {
    expect(extractInstagramShortcode('')).toBeNull();
    expect(extractInstagramShortcode('   ')).toBeNull();
    expect(extractInstagramShortcode('not a url')).toBeNull();
    expect(extractInstagramShortcode('https://www.instagram.com/p/not valid!/')).toBeNull();
  });
});

describe('normalizeInstagramPostUrl', () => {
  it('builds the canonical /p/ URL oEmbed receives', () => {
    expect(normalizeInstagramPostUrl('DfuQz-VKO0y')).toBe('https://www.instagram.com/p/DfuQz-VKO0y/');
  });
});

describe('decodeInstagramShortcode / encodeInstagramShortcode', () => {
  it('round-trips real media IDs', () => {
    for (const id of ['17841400000000000', '123456789012345678', '1', '0']) {
      expect(decodeInstagramShortcode(encodeInstagramShortcode(id))).toBe(id);
    }
  });

  it('decodes a known shortcode to a numeric id', () => {
    const id = decodeInstagramShortcode('DfuQz-VKO0y');
    expect(id).toMatch(/^\d+$/);
    expect(encodeInstagramShortcode(id!)).toBe('DfuQz-VKO0y');
  });

  it('rejects invalid shortcodes', () => {
    expect(decodeInstagramShortcode('')).toBeNull();
    expect(decodeInstagramShortcode('bad code!')).toBeNull();
    expect(encodeInstagramShortcode('not-a-number')).toBe('');
    expect(encodeInstagramShortcode('-5')).toBe('');
  });
});
