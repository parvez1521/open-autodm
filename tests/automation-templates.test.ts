/**
 * Automation templates (2026-11-17) — src/lib/automation/templates.ts.
 *
 * Covers:
 *  (a) exactly the three approved starters exist: Giveaway, Free guide,
 *      Waitlist — no more, no fewer;
 *  (b) every template has a complete prefill: name, flow type, keyword,
 *      opening message, reveal button, response text + link, and an AI
 *      reply language;
 *  (c) template links are placeholders (example.com), never a live
 *      destination the owner did not choose;
 *  (d) getAutomationTemplate returns undefined for an unknown id.
 */

import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_TEMPLATES,
  getAutomationTemplate,
  type AutomationTemplateId,
} from '@/lib/automation/templates';

describe('automation templates', () => {
  it('has exactly Giveaway, Free guide and Waitlist', () => {
    expect(AUTOMATION_TEMPLATES.map((t) => t.id)).toEqual(['giveaway', 'free-guide', 'waitlist']);
  });

  it('every template has a complete, editable prefill', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.automationName.length).toBeGreaterThan(0);
      expect(template.keyword.length).toBeGreaterThan(0);
      expect(template.openingMessage.length).toBeGreaterThan(0);
      expect(template.revealButton.length).toBeGreaterThan(0);
      expect(template.responseText.length).toBeGreaterThan(0);
      expect(template.responseLink.startsWith('https://')).toBe(true);
      expect(['en', 'hinglish']).toContain(template.aiReplyLanguage);
    }
  });

  it('template links are placeholders, never live destinations', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.responseLink).toContain('example.com');
    }
  });

  it('the Giveaway template is a comment trigger on GIVEAWAY', () => {
    const giveaway = getAutomationTemplate('giveaway')!;
    expect(giveaway.flowType).toBe('comment-dm');
    expect(giveaway.keyword).toBe('GIVEAWAY');
    expect(giveaway.openingMessage).toContain('{username}');
  });

  it('the Free guide template is a comment trigger on GUIDE', () => {
    const guide = getAutomationTemplate('free-guide')!;
    expect(guide.flowType).toBe('comment-dm');
    expect(guide.keyword).toBe('GUIDE');
  });

  it('the Waitlist template is a DM trigger on WAITLIST', () => {
    const waitlist = getAutomationTemplate('waitlist')!;
    expect(waitlist.flowType).toBe('dm-reply');
    expect(waitlist.keyword).toBe('WAITLIST');
  });

  it('returns undefined for an unknown template id', () => {
    expect(getAutomationTemplate('not-a-template' as AutomationTemplateId)).toBeUndefined();
  });
});
