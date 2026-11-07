/**
 * Area — AI mixed-scope negative test (Phase 7, proposal §6 #4).
 *
 * Source-scanning, in the style of the existing parity tests: the restored
 * drafting surface must be the ONLY AI surface in the candidate. No runtime
 * AI code path may exist anywhere in src/ — not as live code, not as dead
 * code, not as a comment that could be re-enabled.
 *
 * What is scanned: candidate source under src/ (the repo root is the parent
 * of this tests/ directory). node_modules and the tests/ directory itself
 * are out of scope for the scan.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', 'src');

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

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

function relOf(abs: string): string {
  return path.relative(SRC_ROOT, abs).replace(/\\/g, '/');
}

describe('AI mixed-scope negative — no runtime AI exists in the candidate', () => {
  it('the restored workersAi.ts contains no runtime generator', () => {
    const src = read('lib/ai/workersAi.ts');
    expect(src).not.toContain('generateRuntime');
    expect(src).not.toContain('RuntimePublicReply');
    expect(src).not.toContain('RuntimeDmResponse');
    expect(src).toContain('generateOpeningVariations');
    expect(src).toContain('generatePublicReplies');
    expect(src).toContain('generateResponseDraft');
    expect(src).toContain('generateFollowUpDraft');
  });

  it('no file under lib/automation, lib/instagram, or app/api (other than the drafting route) references lib/ai or DEFAULT_AI_MODEL', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relOf(file);
      if (rel === 'app/api/ai/generate/route.ts') continue;
      if (
        rel.startsWith('lib/automation/') ||
        rel.startsWith('lib/instagram/') ||
        rel.startsWith('app/api/')
      ) {
        const src = fs.readFileSync(file, 'utf8');
        if (src.includes('lib/ai') || src.includes('DEFAULT_AI_MODEL')) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the candidate source contains no runtime-AI gate, flag, or identifier anywhere', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      const hits: string[] = [];
      if (src.includes("public_reply_mode === 'ai_generated'")) hits.push('ai_generated gate');
      if (src.includes('ai_runtime_mode_enabled')) hits.push('ai_runtime_mode_enabled');
      if (src.includes('generateRuntime')) hits.push('generateRuntime*');
      if (src.includes('ai_runtime_instructions')) hits.push('ai_runtime_instructions');
      if (src.includes('public_reply_ai_instructions')) hits.push('public_reply_ai_instructions');
      if (hits.length > 0) offenders.push(`${relOf(file)}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('POST /api/ai/generate is the only route under app/api/ai/', () => {
    const aiDir = path.join(SRC_ROOT, 'app', 'api', 'ai');
    const routes: string[] = [];
    for (const file of collectSourceFiles(aiDir)) {
      routes.push(relOf(file));
    }
    expect(routes).toEqual(['app/api/ai/generate/route.ts']);
  });

  it('the Script Writer shares no code with the drafting restore', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(path.join(SRC_ROOT, 'lib', 'script-writer'))) {
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('lib/ai/workersAi') || src.includes("from '@/lib/ai")) {
        offenders.push(relOf(file));
      }
    }
    for (const file of collectSourceFiles(path.join(SRC_ROOT, 'app', 'api', 'script-writer'))) {
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('lib/ai/workersAi') || src.includes("from '@/lib/ai")) {
        offenders.push(relOf(file));
      }
    }
    expect(offenders).toEqual([]);
    // And the drafting route does not reach into the Script Writer either.
    const route = read('app/api/ai/generate/route.ts');
    expect(route).not.toContain('script-writer');
    expect(route).not.toContain('Groq');
  });
});
