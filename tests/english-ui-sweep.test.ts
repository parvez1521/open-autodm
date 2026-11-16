/**
 * English-only UI sweep (2026-11-17) — owner decision: opendm.in product
 * UI is English only, because customers are national + international.
 *
 * This test fails if a Hinglish string reappears in the swept files:
 *  (a) the exact strings that were removed (resolve-route errors, the
 *      post-picker panel) must not exist anywhere under src/;
 *  (b) a word-boundary scan for distinctive Roman-Hindi words must find
 *      nothing in src/ outside the documented allowlist.
 *
 * ALLOWLIST (intentional keeps — NOT UI copy):
 *  - src/lib/ai/workersAi.ts — the Hinglish AI-reply fallback pools and
 *    the Hinglish system-prompt instruction (feature 6: generated reply
 *    CONTENT in Hinglish is the point; the option's own labels are English).
 *  - src/lib/script-writer/prompt.ts — the Script Writer generates
 *    Hinglish scripts (generated content, not UI copy; needs an explicit
 *    owner decision to change).
 *  - src/components/home/FlowBuilder.tsx — the homepage demo's Hinglish
 *    reply-style option, showing what a Hinglish AI reply looks like
 *    (the feature-6 demo, not a UI label).
 *  - src/lib/owner.ts, src/components/home/IntroWorkflow.tsx — code
 *    comments quoting the owner's own words (never rendered).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(__dirname, '..', 'src');

/** Exact strings removed by the sweep — they must never come back. */
const REMOVED_STRINGS = [
  'Is link ko samajh nahi paye',
  'Is post ko load nahi kar paye',
  'Post list mein nahi dikh raha?',
  'Agar tumhara post',
];

/** Distinctive Roman-Hindi words (word-boundary matched). */
const HINGLISH_WORDS = [
  'nahi', 'karo', 'tumhara', 'tumhare', 'aata', 'jaise', 'samajh',
  'chahiye', 'hoga', 'kya', 'kaise', 'kyun', 'mera', 'meri', 'apna',
  'wala', 'wali', 'kaafi', 'sirf', 'abhi', 'karna', 'dekh', 'bana',
  'rahe', 'raha', 'rahi', 'hain', 'hai', 'bhi', 'mujhe', 'humaare',
  'ye', 'yeh', 'sab', 'kuch', 'koi', 'bilkul', 'bahut', 'bohot',
  'bhot', 'accha', 'theek', 'kabhi', 'aur', 'lekin', 'iska', 'uska',
];
const HINGLISH_RE = new RegExp(`\\b(${HINGLISH_WORDS.join('|')})\\b`);

/** Files whose Hinglish is intentional (see the header comment). */
const ALLOWLISTED_FILES = new Set([
  'lib/ai/workersAi.ts',
  'lib/script-writer/prompt.ts',
  'components/home/FlowBuilder.tsx',
  'lib/owner.ts',
  'components/home/IntroWorkflow.tsx',
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

describe('English-only UI sweep', () => {
  it('the removed Hinglish strings do not appear anywhere under src/', () => {
    const hits: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const content = readFileSync(file, 'utf8');
      for (const removed of REMOVED_STRINGS) {
        if (content.includes(removed)) hits.push(`${file}: ${removed}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no Roman-Hindi words appear in product UI strings outside the allowlist', () => {
    const hits: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const rel = file.slice(SRC_DIR.length + 1);
      if (ALLOWLISTED_FILES.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const match = HINGLISH_RE.exec(line);
        if (match) hits.push(`${rel}:${i + 1}: ${match[0]} — ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the allowlisted files are still the only intentional keeps', () => {
    // Guard against the allowlist silently growing stale: every listed
    // file must still exist and still contain Hinglish (otherwise the
    // allowlist entry — and the reason for it — is dead).
    for (const rel of ALLOWLISTED_FILES) {
      const content = readFileSync(join(SRC_DIR, rel), 'utf8');
      expect(HINGLISH_RE.test(content)).toBe(true);
    }
  });
});
