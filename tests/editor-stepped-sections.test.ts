/**
 * Stepped editor sections (2026-11-22, owner).
 *
 * The automation editor (ConfigureStep) shows its form as an accordion —
 * Post → Keyword → Follow required → DM message, one section open at a
 * time — because the old single long form felt cluttered. Only the
 * wrapping changed: every field, default, validation rule and save
 * payload is exactly as before. If these pins break, a field was lost
 * in the re-wrap or a type shows the wrong sections.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getEditorSections, type EditorSectionData } from '@/lib/automation/editorSections';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const baseData: EditorSectionData = {
  type: 'comment-dm',
  postId: '12345',
  postThumbnailUrl: 'https://example.com/thumb.jpg',
  postCaption: 'My reel caption',
  keywords: [],
  keywordsAnyMode: true,
  askToFollowEnabled: false,
  isAutoDmEnabled: true,
  dmOpeningMessageEnabled: true,
  dmOpeningMessageVariations: ['Hey!'],
  dmResponses: [{ id: 'r1' }],
  followUpEnabled: false,
};

const ids = (data: EditorSectionData) => getEditorSections(data).map((s) => s.id);

describe('getEditorSections: section order and per-type visibility', () => {
  it('comment-dm shows all four sections in order', () => {
    expect(ids(baseData)).toEqual(['post', 'keyword', 'follow', 'dm']);
  });

  it('reel-dm skips the keyword section (share is the trigger)', () => {
    expect(ids({ ...baseData, type: 'reel-dm' })).toEqual(['post', 'follow', 'dm']);
  });

  it('dm-reply has no post section', () => {
    expect(ids({ ...baseData, type: 'dm-reply', postId: 'all' })).toEqual([
      'keyword',
      'follow',
      'dm',
    ]);
  });

  it('story-reply and story-mention have no post section', () => {
    expect(ids({ ...baseData, type: 'story-reply', postId: 'all' })).toEqual([
      'keyword',
      'follow',
      'dm',
    ]);
    expect(ids({ ...baseData, type: 'story-mention', postId: 'all' })).toEqual([
      'keyword',
      'follow',
      'dm',
    ]);
  });

  it('fb-comment-dm shows post + keyword + DM, no follow section', () => {
    expect(ids({ ...baseData, type: 'fb-comment-dm' })).toEqual(['post', 'keyword', 'dm']);
  });

  it('fb-dm-reply shows keyword + DM only', () => {
    expect(ids({ ...baseData, type: 'fb-dm-reply', postId: 'all' })).toEqual([
      'keyword',
      'dm',
    ]);
  });
});

describe('getEditorSections: header summaries', () => {
  it('post summary shows the caption, or the post scope when there is no thumbnail', () => {
    expect(getEditorSections(baseData)[0]?.summary).toBe('My reel caption');
    expect(
      getEditorSections({ ...baseData, postThumbnailUrl: null, postId: 'all' })[0]?.summary,
    ).toBe('All posts');
    expect(
      getEditorSections({ ...baseData, type: 'reel-dm', postThumbnailUrl: null, postId: null })[0]
        ?.summary,
    ).toBe('Any shared reel');
    expect(
      getEditorSections({ ...baseData, postThumbnailUrl: null, postId: '98765' })[0]?.summary,
    ).toBe('Specific post selected');
  });

  it('keyword summary shows the any-mode label, or the keywords', () => {
    const keyword = (data: EditorSectionData) =>
      getEditorSections(data).find((s) => s.id === 'keyword')?.summary;
    expect(keyword(baseData)).toBe('Any comment');
    expect(
      keyword({ ...baseData, type: 'dm-reply', keywordsAnyMode: false, keywords: ['GUIDE'] }),
    ).toBe('GUIDE');
    expect(
      keyword({
        ...baseData,
        keywordsAnyMode: false,
        keywords: ['A', 'B', 'C', 'D', 'E'],
      }),
    ).toBe('A, B, C +2 more');
  });

  it('follow summary is On/Off', () => {
    const follow = (data: EditorSectionData) =>
      getEditorSections(data).find((s) => s.id === 'follow')?.summary;
    expect(follow(baseData)).toBe('Off');
    expect(follow({ ...baseData, askToFollowEnabled: true })).toBe('On — must follow first');
  });

  it('DM summary shows Auto DM off, or variations + responses + follow-up', () => {
    const dm = (data: EditorSectionData) =>
      getEditorSections(data).find((s) => s.id === 'dm')?.summary;
    expect(dm({ ...baseData, isAutoDmEnabled: false })).toBe('Auto DM off');
    expect(dm(baseData)).toBe('1 opening variation · 1 response');
    expect(
      dm({
        ...baseData,
        dmOpeningMessageVariations: ['a', 'b'],
        dmResponses: [{ id: '1' }, { id: '2' }],
        followUpEnabled: true,
      }),
    ).toBe('2 opening variations · 2 responses · Follow-up on');
  });
});

describe('getEditorSections: done states', () => {
  it('follow is done only when enabled; DM is done only when Auto DM is on with content', () => {
    const done = (data: EditorSectionData) =>
      Object.fromEntries(getEditorSections(data).map((s) => [s.id, s.done]));
    expect(done(baseData)).toEqual({ post: true, keyword: true, follow: false, dm: true });
    expect(done({ ...baseData, askToFollowEnabled: true }).follow).toBe(true);
    expect(done({ ...baseData, isAutoDmEnabled: false }).dm).toBe(false);
    expect(
      done({
        ...baseData,
        dmOpeningMessageEnabled: false,
        dmResponses: [],
      }).dm,
    ).toBe(false);
  });
});

describe('accordion mechanics (source pins)', () => {
  const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');

  it('one open section at a time, driven by a single openSection state', () => {
    expect(step).toContain('const [openSection, setOpenSection] = useState<EditorSectionId>');
    // The header opens its own section; the body only renders when open.
    expect(step).toContain('onToggle={() => setOpenSection(section.id)}');
    expect(step).toContain('open={openSection === section.id}');
    expect(step).toContain('{open && (');
  });

  it('the first visible section opens first (post in edit mode, keyword where there is no post)', () => {
    expect(step).toContain('useState<EditorSectionId>(sections[0]?.id ?? "dm")');
  });

  it('Continue only opens the next section — it never validates or saves', () => {
    expect(step).toContain('onContinue={goToNextSection}');
    expect(step).toContain('setOpenSection(sections[openIndex + 1]!.id)');
    expect(step).toContain('Continue');
    // No validation gate on the Continue path.
    expect(step).not.toContain('onContinue={() =>');
  });

  it('the Name field stays above the accordion, always visible', () => {
    expect(step.indexOf('title="Name"')).toBeLessThan(step.indexOf('Stepped sections — one open'));
    expect(step.indexOf('Stepped sections — one open')).toBeLessThan(
      step.indexOf('Right - phones'),
    );
  });

  it('headers carry the section summary and a done state', () => {
    expect(step).toContain('summary={section.summary}');
    expect(step).toContain('done={section.done}');
    expect(step).toContain('<Check className="w-3 h-3" />');
  });

  it('the scheduled follow-up lives inside the DM section, below the responses', () => {
    expect(step.indexOf('title="Follow-up message"')).toBeGreaterThan(
      step.indexOf('title="Responses"'),
    );
    // And it is inside the DM section content, not a top-level form section.
    expect(step.indexOf('title="Follow-up message"')).toBeGreaterThan(
      step.indexOf('const dmContent'),
    );
    expect(step.indexOf('title="Follow-up message"')).toBeLessThan(
      step.indexOf('const sectionContent'),
    );
  });

  it('the require-follow card lives in its own follow section, not inside Auto DM', () => {
    expect(step.indexOf('Require follow')).toBeGreaterThan(step.indexOf('const followContent'));
    expect(step.indexOf('Require follow')).toBeLessThan(step.indexOf('const dmContent'));
  });
});

describe('no data loss through the re-wrap (source pins)', () => {
  const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');
  const modal = readSrc('components/automations/new-flow/NewAutomationModal.tsx');

  it('every editor field still writes through onUpdate', () => {
    for (const field of [
      'name: e.target.value',
      'keywords: kws',
      'keywordsAnyMode: isAny',
      'aiReplyLanguage: lang',
      'customReplies: data.customReplies.filter',
      'dmOpeningMessageButtonTitle: e.target.value',
      'askToFollowEnabled: !data.askToFollowEnabled',
      'askToFollowMessage: e.target.value',
      'askToFollowVisitProfileButton: e.target.value',
      'askToFollowConfirmButton: e.target.value',
      'followUpEnabled: !data.followUpEnabled',
      'followUpDelayMinutes: Number(e.target.value)',
      'followUpMessage: e.target.value',
      'isAutoDmEnabled: !data.isAutoDmEnabled',
      'dmOpeningMessageEnabled: !data.dmOpeningMessageEnabled',
    ]) {
      expect(step).toContain(field);
    }
  });

  it('the save payload in the modal is untouched', () => {
    expect(modal).toContain('keywords: isReelDm ? ["*ANY*"]');
    expect(modal).toContain('askToFollowEnabled: isFacebook ? false : flowData.askToFollowEnabled');
    expect(modal).toContain('followUpEnabled: isFacebook ? false : flowData.followUpEnabled');
    expect(modal).toContain('dmResponses: flowData.dmResponses');
  });

  it('the second link button and Change post survive the re-wrap', () => {
    expect(step).toContain('Add another link');
    expect(step).toContain('Change post');
  });
});

