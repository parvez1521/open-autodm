/**
 * Automation templates (2026-11-17) — one-click starters in the New
 * automation modal.
 *
 * A template only PREFILLS the builder (name, type, trigger, opening
 * message, reveal button, link response). Nothing is auto-created: the
 * owner reviews and edits everything, then saves like any other
 * automation. The link in each template is a placeholder the owner
 * replaces with their own destination.
 */

import type { AiReplyLanguage } from '@/lib/types';

export type AutomationTemplateId = 'giveaway' | 'free-guide' | 'waitlist';

export interface AutomationTemplate {
  id: AutomationTemplateId;
  /** English UI label shown on the template card. */
  name: string;
  description: string;
  /** Flow type the template prefills. */
  flowType: 'comment-dm' | 'dm-reply' | 'story-reply' | 'reel-dm' | 'story-mention';
  /** Prefilled automation name (editable before saving). */
  automationName: string;
  /** Keyword that triggers the flow (empty = any comment/message). */
  keyword: string;
  /** Opening DM message, with {username} where natural. */
  openingMessage: string;
  /** Reveal button label for the 2-step flow. */
  revealButton: string;
  /** The link response text + destination placeholder. */
  responseText: string;
  responseLink: string;
  /** AI reply language for the prefilled drafts. */
  aiReplyLanguage: AiReplyLanguage;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'giveaway',
    name: 'Giveaway',
    description: 'Someone comments to enter, you DM them the entry link.',
    flowType: 'comment-dm',
    automationName: 'Giveaway entry',
    keyword: 'GIVEAWAY',
    openingMessage: "Hey {username}! You're in — thanks for joining the giveaway 🙌",
    revealButton: 'Send me the link',
    responseText: "Here's your giveaway entry link — good luck!",
    responseLink: 'https://example.com/giveaway',
    aiReplyLanguage: 'en',
  },
  {
    id: 'free-guide',
    name: 'Free guide',
    description: 'Share a free guide or resource when someone asks for it.',
    flowType: 'comment-dm',
    automationName: 'Free guide',
    keyword: 'GUIDE',
    openingMessage: "Hey {username}! Here's your free guide 🙌",
    revealButton: 'Send me the link',
    responseText: "Here's your free guide — enjoy!",
    responseLink: 'https://example.com/free-guide',
    aiReplyLanguage: 'en',
  },
  {
    id: 'waitlist',
    name: 'Waitlist',
    description: 'Collect interested people on a waitlist via DM.',
    flowType: 'dm-reply',
    automationName: 'Waitlist',
    keyword: 'WAITLIST',
    openingMessage: "Hey {username}! You're on the waitlist — I'll DM you as soon as it's open 🙌",
    revealButton: 'Send me the link',
    responseText: "You're on the waitlist! Here's what happens next:",
    responseLink: 'https://example.com/waitlist',
    aiReplyLanguage: 'en',
  },
];

export function getAutomationTemplate(id: AutomationTemplateId): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((t) => t.id === id);
}
