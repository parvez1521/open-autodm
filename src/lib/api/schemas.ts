/**
 * Shared Zod schemas + helpers used across API routes.
 * (Route files may only export HTTP handlers - shared pieces live here.)
 */

import { z } from 'zod';

/**
 * Max responses per automation flow. Every response is its own Meta API send;
 * a long burst to one person both eats the hourly send budget and looks like
 * bot behavior to Instagram's spam heuristics. 5 is in line with what
 * commercial automation tools deliver per flow.
 */
export const MAX_DM_RESPONSES = 5;

/**
 * Max opening-message variations per automation. The editor shows them
 * as tabs (Variation 1/2/3…) and the engine picks one at random for
 * each DM, so repeat commenters do not get the identical message every
 * time. Restored 2026-11-12: the 985ed5c redesign dropped the
 * dmOpeningMessageVariations field the a091ade builder had.
 */
export const MAX_DM_OPENING_VARIATIONS = 5;

export const DMResponseSchema = z.object({
  id: z.string(),
  type: z.enum(['text', 'card', 'ask_follow', 'lead_form']),
  content: z.string(),
  buttonTitle: z.string().optional(),
  buttonLink: z.string().optional(),
  /** Text responses: link buttons, max 2 per step (2026-11-22). The
   *  legacy buttonTitle/buttonLink above are still the first button. */
  buttons: z.array(z.object({ id: z.string(), title: z.string(), link: z.string() })).max(2).optional(),
  cardImage: z.string().optional(),
  cardTitle: z.string().optional(),
  cardSubtitle: z.string().optional(),
  cardButtons: z.array(z.object({ id: z.string(), title: z.string(), link: z.string() })).optional(),
  /** Lead-form responses: which contact fields the ask collects (1-2 of email/phone). */
  leadFields: z.array(z.enum(['email', 'phone'])).min(1).max(2).optional(),
});

/** Language for AI-generated drafts/replies (2026-11-17): English or Hinglish (Hindi in Roman script). */
export const AiReplyLanguageSchema = z.enum(['en', 'hinglish']);

/**
 * Create-automation payload (moved here 2026-11-22 from
 * src/app/api/automations/route.ts — route files may only export HTTP
 * handlers, and the duplicate endpoint reuses this exact validation).
 * Exactly one of instagramAccountId / facebookPageId must be set, and
 * fb_* types require facebookPageId.
 */
export const CreateAutomationSchema = z.object({
  instagramAccountId: z.string().uuid('instagramAccountId must be a UUID').nullable().optional(),
  /** Facebook Page automations (2026-11-19): the facebook_pages row id.
   *  Exactly one of instagramAccountId / facebookPageId must be set. */
  facebookPageId: z.string().uuid('facebookPageId must be a UUID').nullable().optional(),
  name: z.string().min(1, 'name is required').max(200),
  type: z.enum(['comment_dm', 'dm_reply', 'story_reply', 'reel_dm', 'story_mention', 'fb_comment_dm', 'fb_dm_reply']),
  isActive: z.boolean().default(true),
  /** AI reply language (2026-11-17): 'en' or 'hinglish'. Defaults to English. */
  aiReplyLanguage: z.enum(['en', 'hinglish']).default('en'),
  postId: z.string().nullable().optional(),
  postThumbnailUrl: z.string().nullable().optional(),
  postCaption: z.string().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  commentReplyOptions: z.array(z.string()).default([]),
  dmOpeningMessageEnabled: z.boolean().default(true),
  dmOpeningMessage: z.string().default(''),
  dmOpeningMessageVariations: z.array(z.string()).max(MAX_DM_OPENING_VARIATIONS, `Max ${MAX_DM_OPENING_VARIATIONS} opening-message variations per automation`).default([]),
  dmOpeningMessageButtonTitle: z.string().nullable().optional(),
  dmOpeningMessageButtonLink: z.string().nullable().optional(),
  askToFollowEnabled: z.boolean().default(false),
  askToFollowMessage: z.string().default(''),
  askToFollowVisitProfileButton: z.string().default('Visit Profile'),
  askToFollowConfirmButton: z.string().default("I'm following ✅"),
  dmResponses: z.array(DMResponseSchema).max(MAX_DM_RESPONSES, `Max ${MAX_DM_RESPONSES} responses per automation`).default([]),
  // Public reply gate (Phase 5): when omitted, derived from whether any
  // comment reply options were configured (preserves the builder's promise
  // that configured replies are posted; the engine never posts when false).
  publicReplyEnabled: z.boolean().optional(),
  publicReplyOptions: z.array(z.string()).optional(),
  // Scheduled follow-ups (Phase 5): stored message text only, no AI.
  followUpEnabled: z.boolean().default(false),
  followUpDelayMinutes: z.number().int().refine((v) => [10, 20, 60, 120].includes(v), 'followUpDelayMinutes must be one of 10, 20, 60, 120').default(60),
  followUpMessage: z.string().default(''),
  // Flow graph + trigger config (Phase 5, row 19): optional; a supplied
  // graph is structurally validated before storage. The candidate's own
  // builder does not send these yet — they exist so flow automations can be
  // created/managed through the API without losing their graph.
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  flowGraph: z.unknown().optional(),
}).refine(
  (v) => Boolean(v.instagramAccountId) !== Boolean(v.facebookPageId),
  { message: 'Exactly one of instagramAccountId / facebookPageId must be set' }
).refine(
  (v) => {
    const isFbType = v.type === 'fb_comment_dm' || v.type === 'fb_dm_reply';
    return isFbType === Boolean(v.facebookPageId);
  },
  { message: 'fb_* types require facebookPageId; Instagram types require instagramAccountId' }
);

export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>;

export type TokenStatus = 'ok' | 'expiring' | 'expired';

const EXPIRY_WARNING_DAYS = 10;

export function computeTokenStatus(expiresAt: string | null): { status: TokenStatus; daysRemaining: number | null } {
  if (!expiresAt) return { status: 'ok', daysRemaining: null };
  const msRemaining = new Date(expiresAt).getTime() - Date.now();
  const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));
  if (daysRemaining <= 0) return { status: 'expired', daysRemaining: 0 };
  if (daysRemaining <= EXPIRY_WARNING_DAYS) return { status: 'expiring', daysRemaining };
  return { status: 'ok', daysRemaining };
}
