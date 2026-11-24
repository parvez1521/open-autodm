/**
 * UI-bugs round 2 fixes (2026-11-24, audit of opendm.in).
 *
 * Seven fixes plus a billing-copy fix. Findings 8 (DM preview bubble
 * icon) and 9b (homepage "137 vs 180" numbers) were verified
 * not-reproduced and are deliberately untouched — no pins for them
 * here. The pins below are a mix of unit tests and source-text pins
 * in the repo's usual style: if one breaks, the fix it guards
 * regressed.
 *
 *  #1  Picker scrim: the caption sat over a weak gradient (black/85
 *      via black/40) and was hard to read on bright thumbnails.
 *      Stronger scrim (black/95 via black/70, pt-12) + text shadow
 *      on the caption.
 *  #2  Mid-word truncation: captions were cut with slice() and no
 *      ellipsis, so text just stopped. Shared truncateWithEllipsis
 *      helper now marks the cut, with title={full text} tooltips.
 *  #3  Dashboard phantom skeleton: TrafficGuardCard rendered a
 *      two-bar skeleton while loading, then vanished when the fetch
 *      resolved with no data. It returns null while loading now.
 *  #4  Contacts blank on load: all 500 rows were motion.tr with a
 *      staggered entrance (delay capped at 0.4s), so the table
 *      appeared empty, then filled in. Plain <tr> now (LeadsPanel
 *      in the same file already used plain <tr>).
 *  #5  Editor AI fields clipped: the AI prompt was a single-line
 *      input, and the opening-message textarea's absolute …/1000
 *      counter overlapped its last line. AI prompt is a 2-row
 *      textarea now; textareas auto-grow (field-sizing-content)
 *      with bottom padding so the counter clears the text.
 *  #6  Step indicator: Follow showed the grey step number when
 *      Off while the other steps showed checks. Off is a complete
 *      binary choice, so Follow is done whenever it renders.
 *  #7  Oversized dialogs: the modal panel was h-full on every step,
 *      so the type picker and post picker stretched tall with an
 *      empty band. h-full applies only to the editor (step 2) now;
 *      the flex areas size to content, capped by max-h-[92vh].
 *  #9a Billing copy: the current-plan card showed the owner's
 *      effective (unlimited) limits while the Free plan card below
 *      showed the catalogue's (1 account). The current plan card
 *      renders the effective limits when the owner is viewing it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { truncateWithEllipsis } from '@/lib/utils';
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

describe('#2 — truncateWithEllipsis', () => {
  it('returns short text unchanged, with no ellipsis', () => {
    expect(truncateWithEllipsis('Short caption', 44)).toBe('Short caption');
    expect(truncateWithEllipsis('Exactly forty-four characters long text here', 44)).toBe(
      'Exactly forty-four characters long text here'
    );
  });

  it('marks a cut with an ellipsis and keeps at most max characters before it', () => {
    const long = 'A very long caption that keeps going past the limit';
    const cut = truncateWithEllipsis(long, 44);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.slice(0, -1).length).toBeLessThanOrEqual(44);
    expect(cut).toBe('A very long caption that keeps going past th…');
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(truncateWithEllipsis('word word word word', 10)).toBe('word word…');
  });
});

describe('#2 + #6 — getEditorSections summaries and follow done-state', () => {
  it('post summary is ellipsised at 70 chars and summaryTitle carries the full caption', () => {
    const caption = 'A caption far longer than seventy characters, so the header summary has to cut it somewhere visible.';
    const sections = getEditorSections({ ...baseData, postCaption: caption });
    const post = sections.find((s) => s.id === 'post');
    expect(post?.summary.endsWith('…')).toBe(true);
    expect(post?.summary.slice(0, -1).length).toBeLessThanOrEqual(70);
    expect(post?.summaryTitle).toBe(caption);
  });

  it('follow is done when Off and when On — Off is a complete choice, not unfinished', () => {
    const off = getEditorSections({ ...baseData, askToFollowEnabled: false }).find((s) => s.id === 'follow');
    const on = getEditorSections({ ...baseData, askToFollowEnabled: true }).find((s) => s.id === 'follow');
    expect(off?.summary).toBe('Off');
    expect(off?.done).toBe(true);
    expect(on?.summary).toBe('On — must follow first');
    expect(on?.done).toBe(true);
  });
});

describe('#1 — picker scrim is strong enough to read captions over', () => {
  const picker = readSrc('components/automations/new-flow/steps/SelectPostStep.tsx');

  it('uses a near-opaque scrim with a taller top pad', () => {
    // Padding changed in the 2026-11-25 stats-row fix (p-2.5 ->
    // px-2.5 pb-3) to lift the stats row off the tile bottom edge;
    // the gradient itself is unchanged.
    expect(picker).toContain('from-black/95 via-black/70 to-transparent px-2.5 pb-3 pt-12');
    expect(picker).not.toContain('from-black/85 via-black/40');
  });

  it('gives the caption a text shadow', () => {
    expect(picker).toContain('[text-shadow:0_1px_3px_rgba(0,0,0,0.9)]');
  });

  it('tile click behaviour is untouched', () => {
    expect(picker).toContain('onClick={() => onSelect(post.id, flowName, thumbUrl ?? null, post.caption ?? "")}');
  });
});

describe('#2 — truncation is ellipsised with full-text tooltips in the UI', () => {
  it('list rows use the helper and carry the full caption as a tooltip', () => {
    const list = readSrc('components/automations/AutomationsList.tsx');
    expect(list).toContain('truncateWithEllipsis(automation.post_caption, 44)');
    expect(list).toContain('title={hasPost ? (automation.post_caption ?? undefined) : undefined}');
    expect(list).not.toContain('automation.post_caption.slice(0, 44)');
  });

  it('editor Selected-post row uses the helper with a full-caption tooltip', () => {
    const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');
    expect(step).toContain('truncateWithEllipsis(data.postCaption, 70)');
    expect(step).toContain('title={data.postCaption ?? undefined}');
  });

  it('accordion header summary carries the full text as a tooltip', () => {
    const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');
    expect(step).toContain('title={summaryTitle ?? summary}');
    expect(step).toContain('summaryTitle={section.summaryTitle}');
  });
});

describe('#3 — TrafficGuardCard returns null while loading, no phantom skeleton', () => {
  const card = readSrc('components/dashboard/TrafficGuardCard.tsx');

  it('has no loading skeleton markup and returns null while loading', () => {
    // The pulsing ShieldWarning icon in the high-traffic alert state
    // (line ~87) is intentional and stays — pin the skeleton bars.
    expect(card).not.toContain('h-5 w-44 bg-muted rounded mb-3');
    expect(card).not.toContain('h-16 bg-muted/60 rounded');
    expect(card).toContain('if (!accountId || isLoading) return null;');
    expect(card).toContain('if (!guard) return null;');
  });
});

describe('#4 — ContactsList rows are plain <tr>, no staggered entrance', () => {
  const list = readSrc('components/automations/ContactsList.tsx');

  it('has no motion rows and no motion/ease imports left', () => {
    expect(list).not.toContain('motion.tr');
    expect(list).not.toContain('</motion.tr>');
    expect(list).not.toContain('from "motion/react"');
    expect(list).not.toContain('EASE_OUT');
    expect(list).toContain('<tr');
  });
});

describe('#5 — editor AI fields: prompt textarea + auto-growing textareas', () => {
  const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');

  it('textareaCls auto-grows and leaves room for the character counter', () => {
    expect(step).toContain('field-sizing-content');
    expect(step).toContain('pt-2 pb-6');
  });

  it('AI prompt is a 2-row textarea with Enter still submitting', () => {
    expect(step).toContain('<textarea');
    expect(step).toContain('rows={2}');
    expect(step).toContain('onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); generate(); } }}');
    expect(step).toContain('flex items-start gap-1.5');
  });

  it('inputCls is unchanged (shared by name and button inputs)', () => {
    expect(step).toContain(
      'const inputCls = "w-full min-w-0 text-[13px] bg-background border border-border rounded-lg px-3 py-2 outline-none focus:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30 transition-colors";'
    );
  });
});

describe('#7 — dialog sizing: tall panel only for the editor step', () => {
  const modal = readSrc('components/automations/new-flow/NewAutomationModal.tsx');
  const picker = readSrc('components/automations/new-flow/steps/SelectPostStep.tsx');
  const step = readSrc('components/automations/new-flow/steps/ConfigureStep.tsx');

  it('panel is h-full only on step 2', () => {
    expect(modal).toContain('step === 2 ? "h-full" : ""');
    expect(modal).toContain('max-h-[92vh]');
  });

  it('content wrapper and picker grid size to content with min-h-0', () => {
    expect(modal).toContain('<div className="flex-auto min-h-0 overflow-hidden">');
    expect(picker).toContain('<div className="flex-auto min-h-0 overflow-y-auto p-5 custom-scrollbar">');
    expect(modal).not.toContain('<div className="flex-1 overflow-hidden">');
  });

  it('ConfigureStep keeps its tall scroll area exactly as before', () => {
    expect(step).toContain('flex flex-col h-full overflow-hidden');
  });
});

describe('#9a — billing plan card shows effective limits for the owner', () => {
  const panel = readSrc('components/billing/BillingPanel.tsx');

  it('current plan card renders entitlement limits when the owner is viewing it', () => {
    expect(panel).toContain(
      'const shownLimits = status.entitlement.ownerFree && isCurrent ? status.entitlement.limits : plan.limits;'
    );
    expect(panel).toContain('{shownLimits.instagramAccounts === null ? "Unlimited" : shownLimits.instagramAccounts} Instagram account(s)');
    expect(panel).toContain('{shownLimits.dmsPerMonth === null ? "Unlimited" : shownLimits.dmsPerMonth.toLocaleString("en-IN")} auto DMs / month');
  });

  it('non-owner plan cards still render the catalogue limits', () => {
    expect(panel).toContain('status.entitlement.limits : plan.limits');
  });
});
