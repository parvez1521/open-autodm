/**
 * Phase 10.3 §8 — security regression pins.
 *
 * S-05 fix: src/lib/instagram/api.ts used to write 80-character previews of
 * outbound DM / public-reply CONTENT (messagePreview / replyPreview) into
 * debug_events.metadata, violating the debug logger's metadata-only rule.
 * The previews are replaced by length-only fields. These source-scan tests
 * (the style established by tests/ai-mixed-scope-negative.test.ts) pin that
 * fix plus two adjacent invariants this audit re-verified by hand:
 *  - no API route returns a stack trace to a client;
 *  - the drafting module keeps exactly its four approved generators.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', 'src');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('Phase 10.3 §8 security regressions', () => {
  it('instagram/api.ts debug events carry no message-content previews (metadata only)', () => {
    const src = read('lib/instagram/api.ts');
    expect(src).not.toContain('messagePreview');
    expect(src).not.toContain('replyPreview');
    // Length-only replacements keep the panel debuggable without content.
    expect(src).toContain('messageLength: messageText.length');
    expect(src).toContain('replyLength: replyText.length');
  });

  it('no debugLog call anywhere in src/ logs a content preview field', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('Preview:') && src.includes('debugLog(')) {
        offenders.push(path.relative(SRC_ROOT, file).replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no API route returns a stack trace in an error response', () => {
    const offenders: string[] = [];
    const apiDir = path.join(SRC_ROOT, 'app', 'api');
    for (const file of collectSourceFiles(apiDir)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/Response\.json\([^)]*\.stack/.test(src) || src.includes('error: err.stack')) {
        offenders.push(path.relative(SRC_ROOT, file).replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('workersAi.ts still exports exactly the four approved drafting generators', () => {
    const src = read('lib/ai/workersAi.ts');
    const generators = [...src.matchAll(/export async function (generate\w+)/g)].map((m) => m[1]);
    expect(generators.sort()).toEqual([
      'generateFollowUpDraft',
      'generateOpeningVariations',
      'generatePublicReplies',
      'generateResponseDraft',
    ]);
  });
});
