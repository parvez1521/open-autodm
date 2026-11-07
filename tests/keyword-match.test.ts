/**
 * Area 8 — Keyword matching (src/lib/automation/keywordMatch.ts).
 *
 * Phase 5 REWRITE: documents the HARDENED release-prep semantics that
 * replaced the ancestor matcher. The four original wildcard/quirk
 * expectations were deliberately inverted by the restoration:
 *  - null / empty keywords NEVER match (no implicit wildcard — an
 *    unconfigured automation must not mass-message);
 *  - '*ANY*' matches only with an explicit allowWildcard opt-in;
 *  - punctuation-ending keywords (e.g. 'c++') CAN match now: the matcher
 *    uses unicode letter/number boundaries instead of \b...\b.
 * Standard mode remains case-insensitive WHOLE-WORD matching.
 */

import { describe, it, expect } from 'vitest';
import { keywordMatches, isExplicitWildcardAutomation } from '@/lib/automation/keywordMatch';

describe('keywordMatches', () => {
  it('treats null keywords as NEVER matching (hardened: no implicit wildcard)', () => {
    expect(keywordMatches('anything at all', null)).toBe(false);
    expect(keywordMatches('LINK', null)).toBe(false);
    expect(keywordMatches('', null)).toBe(false);
  });

  it('treats an empty keyword list as NEVER matching', () => {
    expect(keywordMatches('hello', [])).toBe(false);
    expect(keywordMatches('', [])).toBe(false);
  });

  it('treats *ANY* as a wildcard ONLY when explicitly allowed', () => {
    // Default: the token is inert — it must never fire by accident.
    expect(keywordMatches('whatever', ['*ANY*'])).toBe(false);
    expect(keywordMatches('whatever', ['LINK', '*ANY*'])).toBe(false);
    // Explicit opt-in: the token matches everything.
    expect(keywordMatches('whatever', ['*ANY*'], { allowWildcard: true })).toBe(true);
    expect(keywordMatches('whatever', ['LINK', '*ANY*'], { allowWildcard: true })).toBe(true);
  });

  it('matches a whole word, case-insensitively', () => {
    expect(keywordMatches('please send me the link', ['LINK'])).toBe(true);
    expect(keywordMatches('LINK', ['link'])).toBe(true);
    expect(keywordMatches('LiNk please', ['lInK'])).toBe(true);
  });

  it('matches when the keyword is at a punctuation boundary', () => {
    expect(keywordMatches('link!', ['link'])).toBe(true);
    expect(keywordMatches('(link)', ['link'])).toBe(true);
  });

  it('does NOT substring-match: a keyword inside a larger word does not trigger', () => {
    // Whole-word (unicode boundary) semantics - this is the implemented behaviour.
    expect(keywordMatches('check my hyperlink', ['link'])).toBe(false);
    expect(keywordMatches('links are great', ['link'])).toBe(false);
    expect(keywordMatches('start now', ['art'])).toBe(false);
  });

  it('does not match an absent keyword', () => {
    expect(keywordMatches('hello there', ['LINK'])).toBe(false);
    expect(keywordMatches('', ['LINK'])).toBe(false);
  });

  it('matches if ANY keyword in the list matches', () => {
    expect(keywordMatches('send the guide', ['LINK', 'GUIDE'])).toBe(true);
    expect(keywordMatches('send the guide', ['LINK', 'EBOOK'])).toBe(false);
  });

  it('ignores blank keywords in the list', () => {
    expect(keywordMatches('hello', [''])).toBe(false);
    expect(keywordMatches('hello', ['  ', 'hello'])).toBe(true);
  });

  it('escapes regex metacharacters in keywords', () => {
    expect(keywordMatches('learn a+b today', ['a+b'])).toBe(true);
    expect(keywordMatches('get file.txt now', ['file.txt'])).toBe(true);
    // '.' in the keyword is literal, not a regex wildcard:
    expect(keywordMatches('get fileXtxt now', ['file.txt'])).toBe(false);
  });

  it('matches keywords ending in punctuation at a real boundary (unicode matcher)', () => {
    // The ancestor \b...\b matcher could NEVER match 'c++' (no word
    // boundary after '+'). The restored matcher requires the keyword not
    // be glued to another letter/digit/same-symbol, so a standalone
    // 'c++' matches — and a glued one still does not.
    expect(keywordMatches('learn c++ today', ['c++'])).toBe(true);
    expect(keywordMatches('c++', ['c++'])).toBe(true);
    expect(keywordMatches('learn c++today', ['c++'])).toBe(false);
  });

  it('exactStandalone mode requires the WHOLE comment to be the keyword', () => {
    expect(keywordMatches('LINK', ['link'], { exactStandalone: true })).toBe(true);
    // Outer punctuation / sigils are stripped before comparison:
    expect(keywordMatches('Link!', ['link'], { exactStandalone: true })).toBe(true);
    expect(keywordMatches('#link', ['link'], { exactStandalone: true })).toBe(true);
    // A keyword merely present in a longer comment does NOT fire:
    expect(keywordMatches('send link please', ['link'], { exactStandalone: true })).toBe(false);
    // …while standard mode does match it (the modes are distinct):
    expect(keywordMatches('send link please', ['link'])).toBe(true);
  });

  it('allowEmptyAsWildcard is an explicit opt-in, never the default', () => {
    expect(keywordMatches('anything', null, { allowEmptyAsWildcard: true })).toBe(true);
    expect(keywordMatches('anything', [], { allowEmptyAsWildcard: true })).toBe(true);
    expect(keywordMatches('anything', null, { allowEmptyAsWildcard: false })).toBe(false);
  });
});

describe('isExplicitWildcardAutomation', () => {
  it('recognises the *ANY* / __ANY__ keyword tokens as opt-in', () => {
    expect(isExplicitWildcardAutomation({ keywords: ['*ANY*'] })).toBe(true);
    expect(isExplicitWildcardAutomation({ keywords: ['link', '__ANY__'] })).toBe(true);
    expect(isExplicitWildcardAutomation({ keywords: [' *any* '] })).toBe(true);
  });

  it('recognises trigger_config opt-ins', () => {
    expect(isExplicitWildcardAutomation({ keywords: null, trigger_config: { trigger_mode: 'any' } })).toBe(true);
    expect(isExplicitWildcardAutomation({ keywords: null, trigger_config: { keywords_any_mode: true } })).toBe(true);
    expect(isExplicitWildcardAutomation({ keywords: null, trigger_config: { trigger_mode: 'keyword' } })).toBe(false);
  });

  it('recognises a flow-graph trigger node with keywordsAnyMode', () => {
    expect(
      isExplicitWildcardAutomation({
        keywords: null,
        flow_graph: { nodes: [{ type: 'trigger', data: { keywordsAnyMode: true } }] },
      })
    ).toBe(true);
    expect(
      isExplicitWildcardAutomation({
        keywords: null,
        flow_graph: { nodes: [{ type: 'send_dm', data: { keywordsAnyMode: true } }] },
      })
    ).toBe(false);
  });

  it('null / empty / ordinary keywords alone NEVER enable wildcard mode', () => {
    expect(isExplicitWildcardAutomation({ keywords: null })).toBe(false);
    expect(isExplicitWildcardAutomation({ keywords: [] })).toBe(false);
    expect(isExplicitWildcardAutomation({ keywords: ['LINK'] })).toBe(false);
    expect(isExplicitWildcardAutomation({})).toBe(false);
  });
});
