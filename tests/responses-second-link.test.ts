/**
 * Second link button on text responses (2026-11-22).
 *
 * A text response step can now carry a second link button (max 2).
 * Stored as `buttons` (max 2, each { id, title, link }); the legacy
 * buttonTitle/buttonLink fields stay synced to buttons[0], so old
 * single-button automations keep working unchanged with no migration.
 * Both platforms send both buttons: the IG and FB senders already
 * accept an array and build a button template with up to 3 web_url
 * buttons (verified in src/lib/instagram/api.ts and
 * src/lib/facebook/api.ts), and link tracking rewrites both links.
 * If any of these pins break, the second link is edited but never
 * sent, or old automations lose their button.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  getTextLinkButtons,
  formatInlineLinkButtons,
  MAX_TEXT_LINK_BUTTONS,
} from '@/lib/automation/responseButtons';
import { DMResponseSchema } from '@/lib/api/schemas';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

describe('getTextLinkButtons', () => {
  it('resolves a legacy single-button response to exactly one button', () => {
    expect(
      getTextLinkButtons({ buttonTitle: 'Get it now!', buttonLink: 'https://switchroute.in/x' }),
    ).toEqual([{ title: 'Get it now!', link: 'https://switchroute.in/x' }]);
  });

  it('returns both buttons in order when `buttons` is set', () => {
    expect(
      getTextLinkButtons({
        buttonTitle: 'First',
        buttonLink: 'https://one.example',
        buttons: [
          { id: 'a', title: 'First', link: 'https://one.example' },
          { id: 'b', title: 'Second', link: 'https://two.example' },
        ],
      }),
    ).toEqual([
      { title: 'First', link: 'https://one.example' },
      { title: 'Second', link: 'https://two.example' },
    ]);
  });

  it('caps at two buttons and drops empty links', () => {
    expect(MAX_TEXT_LINK_BUTTONS).toBe(2);
    expect(
      getTextLinkButtons({
        buttons: [
          { id: 'a', title: 'One', link: 'https://one.example' },
          { id: 'b', title: '', link: '' },
          { id: 'c', title: 'Three', link: 'https://three.example' },
          { id: 'd', title: 'Four', link: 'https://four.example' },
        ],
      }),
    ).toEqual([
      { title: 'One', link: 'https://one.example' },
      { title: 'Three', link: 'https://three.example' },
    ]);
  });

  it('falls back to the legacy button when `buttons` carries no usable link', () => {
    expect(
      getTextLinkButtons({
        buttonTitle: 'Legacy',
        buttonLink: 'https://legacy.example',
        buttons: [{ id: 'a', title: '', link: '' }],
      }),
    ).toEqual([{ title: 'Legacy', link: 'https://legacy.example' }]);
  });

  it('defaults a blank title to "Open link" and returns [] with no links', () => {
    expect(
      getTextLinkButtons({ buttons: [{ id: 'a', title: '  ', link: 'https://x.example' }] }),
    ).toEqual([{ title: 'Open link', link: 'https://x.example' }]);
    expect(getTextLinkButtons({})).toEqual([]);
    expect(getTextLinkButtons(null)).toEqual([]);
  });

  it('formats the inline fallback with one "Title: link" line per button', () => {
    expect(
      formatInlineLinkButtons([
        { title: 'Get it now!', link: 'https://one.example' },
        { title: 'Learn more', link: 'https://two.example' },
      ]),
    ).toBe('Get it now!: https://one.example\nLearn more: https://two.example');
  });
});

describe('second link button: model', () => {
  it('DMResponse carries an optional `buttons` array in the client model', () => {
    expect(readSrc('hooks/useAutomations.ts')).toContain(
      'buttons?: { id: string; title: string; link: string }[];',
    );
    expect(readSrc('components/automations/new-flow/NewAutomationModal.tsx')).toContain(
      'buttons?: CardButton[];',
    );
  });

  it('the API schema accepts two buttons, rejects three, and still accepts the legacy shape', () => {
    const base = { id: 'r1', type: 'text', content: 'Hi' };
    expect(
      DMResponseSchema.safeParse({
        ...base,
        buttons: [
          { id: 'a', title: 'One', link: 'https://one.example' },
          { id: 'b', title: 'Two', link: 'https://two.example' },
        ],
      }).success,
    ).toBe(true);
    expect(
      DMResponseSchema.safeParse({
        ...base,
        buttons: [
          { id: 'a', title: 'One', link: 'https://one.example' },
          { id: 'b', title: 'Two', link: 'https://two.example' },
          { id: 'c', title: 'Three', link: 'https://three.example' },
        ],
      }).success,
    ).toBe(false);
    expect(
      DMResponseSchema.safeParse({ ...base, buttonTitle: 'Get it', buttonLink: 'https://x.example' })
        .success,
    ).toBe(true);
  });
});

describe('second link button: editor UI', () => {
  const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');

  it('offers "Add another link" for a second button, capped at two', () => {
    expect(step).toContain('Add another link');
    expect(step).toContain('Add link button');
    // The add control only shows while exactly one button exists.
    expect(step).toContain('buttons.length === 1');
    // Each block has its own remove, and the legacy fields stay synced
    // to the first button so old readers keep working.
    expect(step).toContain('removeButton');
    expect(step).toContain('buttonTitle: next[0]?.title');
    expect(step).toContain('buttonLink: next[0]?.link');
  });

  it('reads legacy single-button rows as one button', () => {
    expect(step).toContain('legacyButton');
    expect(step).toContain('DRAFT_LINK_BUTTON_ID');
  });

  it('the phone preview renders every resolved button, not just the first', () => {
    const preview = readSrc('components/automations/new-flow/steps/PhoneComponents.tsx');
    expect(preview).toContain('getTextLinkButtons(resp).map');
    expect(preview).not.toContain('resp.buttonLink &&');
  });
});

describe('second link button: engine', () => {
  it('both senders accept an array of buttons (up to Meta\'s 3-button limit)', () => {
    expect(readSrc('lib/instagram/api.ts')).toContain(
      'buttonOrButtons: string | LinkButtonConfig[]',
    );
    expect(readSrc('lib/facebook/api.ts')).toContain(
      'buttonOrButtons: string | FbLinkButtonConfig[]',
    );
  });

  it('both response senders pass the resolved buttons as an array and fall back inline with all of them', () => {
    const ig = readSrc('lib/automation/processJob.ts');
    expect(ig).toContain('getTextLinkButtons(response)');
    expect(ig).toContain('buttons.map((b) => ({ title: b.title, url: b.link }))');
    expect(ig).toContain('formatInlineLinkButtons(buttons)');
    const fb = readSrc('lib/automation/processFacebookJob.ts');
    expect(fb).toContain('getTextLinkButtons(response)');
    expect(fb).toContain('buttons.map((b) => ({ title: b.title, url: b.link }))');
    expect(fb).toContain('formatInlineLinkButtons(buttons)');
  });

  it('link tracking rewrites both buttons, not just the legacy one', () => {
    const tracking = readSrc('lib/automation/linkTracking.ts');
    expect(tracking).toContain('if (response.buttons?.length)');
    expect(tracking).toContain('trackedButtons.push({ ...btn, link: tracked })');
  });
});
