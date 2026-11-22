/**
 * Duplicate automation (2026-11-22).
 *
 * Copies a stored automation row into a create payload and an insert
 * row. The copy is always created INACTIVE (is_active false) so it can
 * never double-send DMs until the owner activates it himself, and its
 * counters restart at zero. Everything else — channel, type, post,
 * keywords, public replies, opening variations, reveal/follow-up,
 * responses (including both link buttons), require-follow, lead form,
 * trigger config, flow graph — is copied verbatim.
 *
 * The copy is validated with the exact create schema
 * (CreateAutomationSchema) before insert, so a duplicate can never
 * store a config the create endpoint would reject.
 */

import { randomUUID } from 'node:crypto';
import type { CreateAutomationInput } from '@/lib/api/schemas';

/** The stored automation row, as read back from the database. */
export type AutomationSourceRow = Record<string, unknown>;

/** "Copy of <name>", kept inside the 200-char name limit. */
export function duplicateName(name: string): string {
  return `Copy of ${name}`.slice(0, 200);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as string[]) : [];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Maps a stored row (snake_case columns) to a create payload.
 * Responses missing an `id` (rows written before response ids were
 * enforced) get one minted, so the create schema's id requirement
 * never blocks duplicating an old automation.
 */
export function sourceRowToCreateBody(source: AutomationSourceRow): CreateAutomationInput {
  const responses = Array.isArray(source['dm_responses'])
    ? (source['dm_responses'] as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        id: typeof r['id'] === 'string' && r['id'].length > 0 ? r['id'] : randomUUID(),
      }))
    : [];
  return {
    instagramAccountId: asNullableString(source['instagram_account_id']),
    facebookPageId: asNullableString(source['facebook_page_id']),
    name: duplicateName(asString(source['name'], 'Untitled')),
    type: source['type'] as CreateAutomationInput['type'],
    isActive: false,
    aiReplyLanguage: source['ai_reply_language'] === 'hinglish' ? 'hinglish' : 'en',
    postId: asNullableString(source['post_id']),
    postThumbnailUrl: asNullableString(source['post_thumbnail_url']),
    postCaption: asNullableString(source['post_caption']),
    keywords: Array.isArray(source['keywords']) ? (source['keywords'] as string[]) : null,
    commentReplyOptions: asStringArray(source['comment_reply_options']),
    dmOpeningMessageEnabled: source['dm_opening_message_enabled'] !== false,
    dmOpeningMessage: asString(source['dm_opening_message'], ''),
    dmOpeningMessageVariations: asStringArray(source['dm_opening_message_variations']),
    dmOpeningMessageButtonTitle: asNullableString(source['dm_opening_message_button_title']),
    dmOpeningMessageButtonLink: asNullableString(source['dm_opening_message_button_link']),
    askToFollowEnabled: source['ask_to_follow_enabled'] === true,
    askToFollowMessage: asString(source['ask_to_follow_message'], ''),
    askToFollowVisitProfileButton: asString(source['ask_to_follow_visit_profile_button'], 'Visit Profile'),
    askToFollowConfirmButton: asString(source['ask_to_follow_confirm_button'], "I'm following ✅"),
    dmResponses: responses as CreateAutomationInput['dmResponses'],
    publicReplyEnabled:
      typeof source['public_reply_enabled'] === 'boolean' ? (source['public_reply_enabled'] as boolean) : undefined,
    publicReplyOptions: Array.isArray(source['public_reply_options'])
      ? (source['public_reply_options'] as string[])
      : undefined,
    followUpEnabled: source['follow_up_enabled'] === true,
    followUpDelayMinutes:
      typeof source['follow_up_delay_minutes'] === 'number' ? (source['follow_up_delay_minutes'] as number) : 60,
    followUpMessage: asString(source['follow_up_message'], ''),
    triggerConfig:
      source['trigger_config'] && typeof source['trigger_config'] === 'object'
        ? (source['trigger_config'] as Record<string, unknown>)
        : undefined,
    flowGraph: source['flow_graph'] ?? undefined,
  };
}

/**
 * The insert row for a validated create payload — the same shape the
 * create endpoint inserts (legacy + workspace branches), with the
 * duplicate's own id minted up front so the workspace branch (whose
 * repository insert returns the stamped payload, not a re-read row)
 * can return a row that already carries its id.
 */
export function buildDuplicateInsertRow(
  data: CreateAutomationInput,
  userId: string,
  id: string,
  /** Validated flow graph (null for linear/Facebook automations). */
  flowGraph: unknown,
): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    instagram_account_id: data.facebookPageId ? null : data.instagramAccountId,
    facebook_page_id: data.facebookPageId ? data.facebookPageId : null,
    channel: data.facebookPageId ? 'facebook' : 'instagram',
    name: data.name,
    type: data.type,
    post_id: data.postId ?? null,
    post_thumbnail_url: data.postThumbnailUrl ?? null,
    post_caption: data.postCaption ?? null,
    keywords: data.keywords ?? null,
    comment_reply_options: data.commentReplyOptions,
    public_reply_enabled: data.publicReplyEnabled ?? data.commentReplyOptions.length > 0,
    public_reply_options: data.publicReplyOptions ?? data.commentReplyOptions,
    follow_up_enabled: data.followUpEnabled,
    follow_up_delay_minutes: data.followUpDelayMinutes,
    follow_up_message: data.followUpMessage,
    dm_opening_message_enabled: data.dmOpeningMessageEnabled,
    // Variation 1 stays mirrored into the legacy single-message column
    // so older engine paths and the "opening off" check keep working.
    dm_opening_message: data.dmOpeningMessageVariations[0] ?? data.dmOpeningMessage,
    dm_opening_message_variations: data.dmOpeningMessageVariations,
    dm_opening_message_button_title: data.dmOpeningMessageButtonTitle ?? null,
    dm_opening_message_button_link: data.dmOpeningMessageButtonLink ?? null,
    ask_to_follow_enabled: data.askToFollowEnabled,
    ask_to_follow_message: data.askToFollowMessage,
    ask_to_follow_visit_profile_button: data.askToFollowVisitProfileButton,
    ask_to_follow_confirm_button: data.askToFollowConfirmButton,
    dm_responses: data.dmResponses,
    trigger_config: data.triggerConfig ?? {},
    flow_graph: flowGraph,
    is_active: false,
    paused_by_disconnect: false,
    ai_reply_language: data.aiReplyLanguage,
    total_dms_sent: 0,
  };
}
