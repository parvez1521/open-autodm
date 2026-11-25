/**
 * UI polish — pill toggles + account switcher (2026-11-25, owner
 * complaint with screenshots).
 *
 * The owner called the /automations pill toggles and the account
 * switcher popover unprofessional: the active pill was a muddy
 * slab barely distinct from its container, the two toggle groups
 * looked like different components, the Instagram/Facebook icons
 * were stylistically mismatched (heavy camera glyph vs thin
 * circle-f), the popover mixed a real photo avatar with bare
 * letter tiles, the active check floated at the far edge, and
 * "Signed in as parvezsiddiqui018…" was cut mid-email.
 *
 * Fixes pinned here (source-text pins in the repo's usual style,
 * plus unit tests for the fresh-picture resolvers):
 *
 *  #1  One shared PillToggle component owns every pill group
 *      (11 sites). Crisp active state (bg-card + ring-1
 *      ring-border + shadow), 6px inner radius everywhere (the
 *      8px container minus 2px padding — the small toggles and the
 *      switcher popover still used 7px, overhanging the corners).
 *  #2  Instagram/Facebook icons match: both render at Phosphor
 *      `weight="fill"` (solid glyphs of equal visual weight).
 *  #3  Avatars resolve fresh at render time (pictures batch
 *      endpoints, mirroring the 2026-11-22 thumbnails pattern);
 *      the fallback is one consistent glyph tile for every
 *      account — never a bare letter next to a photo.
 *  #4  Active checkmark sits in a fixed slot, vertically centred
 *      on the row, in the brand accent.
 *  #5  "Signed in as" shows the full email on its own line
 *      (switcher popover, sidebar footer, settings) — never
 *      truncated mid-string.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import {
  resolveInstagramProfilePicture,
  parseProfilePictureIds,
} from '@/lib/instagram/profilePicture';
import { resolveFacebookPagePicture } from '@/lib/facebook/pagePicture';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const PILL_SITES = [
  'app/(main)/automations/page.tsx',
  'app/(main)/analytics/page.tsx',
  'components/dashboard/AccountSwitcher.tsx',
  'components/automations/new-flow/steps/ConfigureStep.tsx',
  'components/automations/new-flow/steps/SelectPostStep.tsx',
  'components/automations/ContactsList.tsx',
];

describe('PillToggle — one shared treatment', () => {
  it('every pill group renders through the shared component', () => {
    for (const site of PILL_SITES) {
      const src = readSrc(site);
      expect(src, `${site} should use PillToggle`).toContain('PillToggle');
    }
  });

  it('no hand-rolled pill container remains outside the component', () => {
    // The only `bg-muted rounded-lg p-0.5` pill container in src
    // is the one inside PillToggle itself.
    const hits = execSync(
      "grep -rn --include='*.tsx' 'bg-muted rounded-lg p-0.5' src | grep -v PillToggle.tsx | grep -v tests || true",
      { encoding: 'utf8' },
    ).trim();
    expect(hits).toBe('');
  });

  it('active state has a defined edge, not a muddy slab', () => {
    const src = readSrc('components/ui/PillToggle.tsx');
    expect(src).toContain('ring-1 ring-border');
    expect(src).toContain('bg-card text-foreground shadow-sm');
  });

  it('both sizes use the 6px inner radius (8px container minus 2px padding)', () => {
    const src = readSrc('components/ui/PillToggle.tsx');
    expect(src).toContain('rounded-[6px]');
    expect(src).not.toContain('rounded-[7px]');
  });

  it('no rounded-[7px] pill button remains anywhere in src', () => {
    const hits = execSync(
      "grep -rn --include='*.tsx' 'rounded-\\[7px\\]' src | grep -v tests || true",
      { encoding: 'utf8' },
    ).trim();
    expect(hits).toBe('');
  });
});

describe('Channel icons — matched visual weight', () => {
  it('both brand glyphs render at Phosphor fill weight', () => {
    const src = readSrc('components/ui/PillToggle.tsx');
    expect(src).toContain('InstagramGlyph');
    expect(src).toContain('FacebookGlyph');
    expect(src).toContain('weight="fill"');
  });

  it('the channel toggles use the matched glyphs, not the raw outline icons', () => {
    for (const site of [
      'app/(main)/automations/page.tsx',
      'app/(main)/analytics/page.tsx',
      'components/dashboard/AccountSwitcher.tsx',
    ]) {
      const src = readSrc(site);
      expect(src, `${site} should use InstagramGlyph`).toContain('InstagramGlyph');
      expect(src, `${site} should use FacebookGlyph`).toContain('FacebookGlyph');
    }
  });
});

describe('Avatars — fresh pictures + one consistent fallback', () => {
  it('the switcher and settings resolve fresh pictures at render time', () => {
    const switcher = readSrc('components/dashboard/AccountSwitcher.tsx');
    expect(switcher).toContain('useProfilePictures');
    expect(switcher).toContain('pictures[account.id] ?? account.profile_picture_url');
    const settings = readSrc('app/(main)/settings/page.tsx');
    expect(settings).toContain('useProfilePictures');
    expect(settings).toContain('pictures[account.id] ?? account.profile_picture_url');
  });

  it('the pictures batch endpoints exist and return a pictures map', () => {
    expect(existsSync(path.resolve(process.cwd(), 'src/app/api/instagram/accounts/pictures/route.ts'))).toBe(true);
    expect(existsSync(path.resolve(process.cwd(), 'src/app/api/facebook/pages/pictures/route.ts'))).toBe(true);
    expect(readSrc('app/api/instagram/accounts/pictures/route.ts')).toContain('Response.json({ pictures:');
    expect(readSrc('app/api/facebook/pages/pictures/route.ts')).toContain('Response.json({ pictures:');
  });

  it('IgAvatar never falls back to a bare letter', () => {
    const src = readSrc('components/dashboard/IgAvatar.tsx');
    expect(src).not.toContain('charAt(0)');
    expect(src).not.toContain('initial');
    // One deliberate glyph tile for every account.
    expect(src).toContain('bg-[#E1306C]/10');
    expect(src).toContain('weight="fill"');
  });

  it('the Facebook fallback glyph matches (fill weight)', () => {
    const switcher = readSrc('components/dashboard/AccountSwitcher.tsx');
    expect(switcher).toContain('bg-[#1877F2]/10');
    expect(switcher).toContain('weight="fill"');
  });
});

describe('Active checkmark — fixed slot, brand accent', () => {
  it('switcher rows pin the check in a centred fixed slot', () => {
    const src = readSrc('components/dashboard/AccountSwitcher.tsx');
    expect(src).toContain('w-5 h-5 shrink-0 flex items-center justify-center');
    expect(src).toContain('text-primary');
    expect(src).not.toContain('<Check className="w-3.5 h-3.5 text-foreground shrink-0" />');
  });

  it('the workspace switcher rows use the same treatment', () => {
    const src = readSrc('components/workspace/WorkspaceSwitcher.tsx');
    expect(src).toContain('w-5 h-5 shrink-0 flex items-center justify-center');
    expect(src).toContain('text-primary');
  });
});

describe('Signed-in email — full, never truncated mid-string', () => {
  it('the switcher popover shows the full email on its own line', () => {
    const src = readSrc('components/dashboard/AccountSwitcher.tsx');
    expect(src).toContain('break-all">{userEmail}</p>');
    // No truncate on the session line.
    const sessionBlock = src.slice(src.indexOf('Signed in as'));
    expect(sessionBlock).not.toContain('truncate');
  });

  it('the sidebar footer shows the full email on its own line', () => {
    const src = readSrc('components/dashboard/SessionFooter.tsx');
    expect(src).toContain('break-all">{email}</p>');
    expect(src).not.toContain('truncate');
  });

  it('the settings session line wraps instead of truncating', () => {
    const src = readSrc('app/(main)/settings/page.tsx');
    expect(src).toContain('mt-0.5 break-all');
  });
});

describe('resolveInstagramProfilePicture', () => {
  const ok = (body: unknown) => async () => ({ ok: true, json: async () => body });

  it('returns the fresh URL on success', async () => {
    const url = await resolveInstagramProfilePicture(
      ok({ profile_picture_url: 'https://example.com/fresh.jpg' }) as never,
      'https://graph.instagram.com/v23.0',
      'tok',
      '123',
    );
    expect(url).toBe('https://example.com/fresh.jpg');
  });

  it('returns null on a non-ok response, bad JSON, or an empty URL', async () => {
    const fail = async () => ({ ok: false, json: async () => ({}) });
    expect(
      await resolveInstagramProfilePicture(fail as never, 'https://graph.instagram.com/v23.0', 'tok', '123'),
    ).toBeNull();
    const badJson = async () => ({ ok: true, json: async () => { throw new Error('bad'); } });
    expect(
      await resolveInstagramProfilePicture(badJson as never, 'https://graph.instagram.com/v23.0', 'tok', '123'),
    ).toBeNull();
    expect(
      await resolveInstagramProfilePicture(
        ok({ profile_picture_url: '' }) as never,
        'https://graph.instagram.com/v23.0',
        'tok',
        '123',
      ),
    ).toBeNull();
  });

  it('returns null when the fetch itself throws or the id is blank', async () => {
    const throwing = async () => { throw new Error('down'); };
    expect(
      await resolveInstagramProfilePicture(throwing as never, 'https://graph.instagram.com/v23.0', 'tok', '123'),
    ).toBeNull();
    expect(
      await resolveInstagramProfilePicture(ok({}) as never, 'https://graph.instagram.com/v23.0', 'tok', '   '),
    ).toBeNull();
  });

  it('calls the user endpoint with the profile_picture_url field', async () => {
    let called = '';
    const spy = async (url: string) => { called = url; return { ok: true, json: async () => ({ profile_picture_url: 'https://x/y.jpg' }) }; };
    await resolveInstagramProfilePicture(spy as never, 'https://graph.instagram.com/v23.0', 'tok', '123');
    expect(called).toContain('/123?fields=profile_picture_url');
  });
});

describe('resolveFacebookPagePicture', () => {
  it('returns the nested picture URL on success', async () => {
    const ok = async () => ({
      ok: true,
      json: async () => ({ picture: { data: { url: 'https://example.com/page.jpg' } } }),
    });
    const url = await resolveFacebookPagePicture(
      ok as never,
      'https://graph.facebook.com/v23.0',
      'tok',
      '348182738386266',
    );
    expect(url).toBe('https://example.com/page.jpg');
  });

  it('returns null when the picture is missing or the call fails', async () => {
    const noPicture = async () => ({ ok: true, json: async () => ({}) });
    expect(
      await resolveFacebookPagePicture(noPicture as never, 'https://graph.facebook.com/v23.0', 'tok', '1'),
    ).toBeNull();
    const fail = async () => ({ ok: false, json: async () => ({}) });
    expect(
      await resolveFacebookPagePicture(fail as never, 'https://graph.facebook.com/v23.0', 'tok', '1'),
    ).toBeNull();
  });
});

describe('parseProfilePictureIds', () => {
  it('trims, dedupes, and caps the list', () => {
    expect(parseProfilePictureIds('a, b, a, , c')).toEqual(['a', 'b', 'c']);
    expect(parseProfilePictureIds(null)).toEqual([]);
    expect(parseProfilePictureIds('a,b,c,d', 2)).toEqual(['a', 'b']);
  });
});
