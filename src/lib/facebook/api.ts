/**
 * Meta Graph API client for Facebook Page messaging.
 *
 * Mirrors src/lib/instagram/api.ts, but against graph.facebook.com for
 * Facebook Pages (NOT Instagram). Key facts this module encodes:
 *
 *  - All calls use a PAGE access token (from /me/accounts after Facebook
 *    Login), never a user token and never an Instagram token.
 *  - Sends go to POST /{page-id}/messages with messaging_type RESPONSE.
 *  - A PRIVATE REPLY to a comment is the same Send API call with
 *    recipient { comment_id } instead of { id }: Meta's purpose-built
 *    comment-to-Messenger channel — one reply per comment, valid for
 *    7 days after the comment, 750 private replies/hour per Page. Always
 *    prefer this for comment-triggered opening DMs.
 *  - Free-form sends to a PSID ({ id }) only work inside the 24-hour
 *    standard messaging window; outside it Meta fails with error 10
 *    (subcodes 2018278 / 2534022) — classified NonRetryable, never retried.
 *  - Button templates (postback buttons) work on Messenger with the same
 *    "SESSION_{uuid}_STEP_{n}" payload routing as Instagram.
 *  - Public replies go to POST /{comment-id}/comments.
 *  - Access tokens are decrypted at call time and never logged.
 */

import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { classifyMetaError } from '@/lib/instagram/errors';

const logger = createLogger('facebook');

export const FB_GRAPH_BASE = 'https://graph.facebook.com/v23.0';

interface MetaSendMessageResponse {
  recipient_id: string;
  message_id: string;
}

interface MetaErrorResponse {
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface FbQuickReply {
  /** Visible button label - Meta limit: 20 characters */
  title: string;
  /** Hidden payload: "SESSION_{uuid}_STEP_{n}". The routing key. */
  payload: string;
}

/**
 * Who receives the message.
 *
 *  - { id }        → a Messenger user by Page-scoped ID (requires the
 *                    24h engagement window)
 *  - { commentId } → a PRIVATE REPLY to a comment (7-day window, one per
 *                    comment, 750/hour per Page — always prefer this for
 *                    comment-triggered opening DMs)
 */
export type FbRecipient = { id: string } | { commentId: string };

function recipientJson(recipient: FbRecipient): Record<string, string> {
  return 'commentId' in recipient ? { comment_id: recipient.commentId } : { id: recipient.id };
}

function recipientLabel(recipient: FbRecipient): string {
  return 'commentId' in recipient ? `comment ${recipient.commentId} (private reply)` : recipient.id;
}

function throwFromMetaResponse(context: string, status: number, body: MetaErrorResponse): never {
  const code = body.error?.code;
  const subcode = body.error?.error_subcode;
  const message = body.error?.message ?? `Unknown Meta API error (${context}, HTTP ${status})`;
  throw classifyMetaError(message, code, subcode);
}

/** Sends a text Messenger message (optionally with a postback button via button template). */
export async function sendFacebookMessage(
  pageId: string,
  recipient: FbRecipient,
  messageText: string,
  accessToken: string,
  quickReply?: FbQuickReply
): Promise<string> {
  let messageBody: Record<string, unknown>;
  if (quickReply?.title.trim()) {
    messageBody = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: messageText.slice(0, 640), // button template text limit
          buttons: [
            {
              type: 'postback',
              title: quickReply.title.trim().slice(0, 20),
              payload: quickReply.payload,
            },
          ],
        },
      },
    };
  } else {
    messageBody = { text: messageText };
  }

  const to = recipientLabel(recipient);
  debugLog('facebook', 'info', 'fb_message_send_attempt', 'processing', `Sending Messenger message to ${to}`, {
    pageId,
    recipient: to,
    hasQuickReply: !!quickReply,
    // Metadata only: never persist message content in debug_events.
    messageLength: messageText.length,
  });

  const res = await fetch(`${FB_GRAPH_BASE}/${pageId}/messages?access_token=${accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_type: 'RESPONSE',
      recipient: recipientJson(recipient),
      message: messageBody,
    }),
  });

  const data = (await res.json()) as MetaSendMessageResponse & MetaErrorResponse;

  if (!res.ok) {
    logger.error(
      { pageId, recipient: to, status: res.status, metaCode: data.error?.code, metaMessage: data.error?.message },
      'Messenger send failed'
    );
    debugLog('facebook', 'error', 'fb_message_send_failed', 'error',
      `Messenger message to ${to} FAILED - Meta error ${data.error?.code}: ${data.error?.message ?? 'unknown'}`,
      { pageId, recipient: to, httpStatus: res.status, metaErrorCode: data.error?.code, fbtrace_id: data.error?.fbtrace_id });
    throwFromMetaResponse('sendFacebookMessage', res.status, data);
  }

  debugLog('facebook', 'info', 'fb_message_sent', 'ok', `Messenger message sent to ${to} - messageId=${data.message_id}`, {
    pageId,
    recipient: to,
    messageId: data.message_id,
  });
  return data.message_id;
}

export interface FbLinkButtonConfig {
  title: string;
  url: string;
}

/**
 * Sends a Messenger message as a button template with one or more tappable
 * web_url LINK buttons (up to Meta's 3-button limit).
 *
 * Supports both:
 *  - sendFacebookLinkButtonMessage(pageId, recipient, messageText, buttonTitle, url, accessToken)
 *  - sendFacebookLinkButtonMessage(pageId, recipient, messageText, buttonsArray, accessToken)
 *
 * Meta occasionally rejects button templates for certain recipients/URL
 * combinations. Callers should catch MetaApiError and fall back to
 * sendFacebookMessage with the link inline.
 */
export async function sendFacebookLinkButtonMessage(
  pageId: string,
  recipient: FbRecipient,
  messageText: string,
  buttonOrButtons: string | FbLinkButtonConfig[],
  urlOrToken: string,
  maybeAccessToken?: string
): Promise<string> {
  let buttons: FbLinkButtonConfig[];
  let accessToken: string;

  if (Array.isArray(buttonOrButtons)) {
    buttons = buttonOrButtons;
    accessToken = urlOrToken;
  } else {
    buttons = [{ title: buttonOrButtons, url: urlOrToken }];
    accessToken = maybeAccessToken!;
  }

  const to = recipientLabel(recipient);
  const metaButtons = buttons.slice(0, 3).map((b) => ({
    type: 'web_url',
    url: b.url,
    title: b.title.trim().slice(0, 20) || 'Open link',
  }));

  debugLog('facebook', 'info', 'fb_link_button_attempt', 'processing', `Sending link-button message to ${to}`, {
    pageId,
    recipient: to,
    buttonCount: metaButtons.length,
  });

  const res = await fetch(`${FB_GRAPH_BASE}/${pageId}/messages?access_token=${accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_type: 'RESPONSE',
      recipient: recipientJson(recipient),
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: messageText.slice(0, 640),
            buttons: metaButtons,
          },
        },
      },
    }),
  });

  const data = (await res.json()) as MetaSendMessageResponse & MetaErrorResponse;
  if (!res.ok) {
    debugLog('facebook', 'warn', 'fb_link_button_failed', 'error',
      `Link-button message to ${to} rejected - ${data.error?.code}: ${data.error?.message ?? 'unknown'} (caller falls back to inline link)`,
      { pageId, recipient: to, httpStatus: res.status, metaErrorCode: data.error?.code });
    throwFromMetaResponse('sendFacebookLinkButtonMessage', res.status, data);
  }
  debugLog('facebook', 'info', 'fb_link_button_sent', 'ok', `Link-button message sent to ${to} - messageId=${data.message_id}`, {
    pageId,
    recipient: to,
    messageId: data.message_id,
  });
  return data.message_id;
}

/** Posts a public reply under a Facebook comment. Non-fatal - the private reply still sends on failure. */
export async function replyToFacebookComment(commentId: string, replyText: string, accessToken: string): Promise<void> {
  debugLog('facebook', 'info', 'fb_comment_reply_attempt', 'processing', `Replying to Facebook comment ${commentId}`, {
    commentId,
    replyLength: replyText.length,
  });

  const res = await fetch(`${FB_GRAPH_BASE}/${commentId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: replyText, access_token: accessToken }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as MetaErrorResponse;
    logger.warn({ commentId, status: res.status, metaCode: body.error?.code }, 'Facebook comment reply failed - continuing');
    debugLog('facebook', 'warn', 'fb_comment_reply_failed', 'error',
      `Comment reply to ${commentId} failed - ${body.error?.code}: ${body.error?.message ?? 'unknown'} (private reply will still send)`,
      { commentId, httpStatus: res.status });
  } else {
    debugLog('facebook', 'info', 'fb_comment_reply_sent', 'ok', `Public reply posted to Facebook comment ${commentId}`, { commentId });
  }
}

/** Sends a card (generic template) Messenger message with image/title/subtitle/URL buttons. */
export async function sendFacebookCardMessage(
  pageId: string,
  recipientId: string,
  accessToken: string,
  card: { imageUrl?: string; title?: string; subtitle?: string; buttons?: { title: string; url: string }[] }
): Promise<string> {
  const element: Record<string, unknown> = {
    title: (card.title ?? '').slice(0, 80) || ' ',
  };
  if (card.subtitle) element['subtitle'] = card.subtitle.slice(0, 80);
  if (card.imageUrl) element['image_url'] = card.imageUrl;
  if (card.buttons?.length) {
    element['buttons'] = card.buttons.slice(0, 3).map((btn) => ({
      type: 'web_url',
      url: btn.url,
      title: btn.title.slice(0, 20),
    }));
  }

  const res = await fetch(`${FB_GRAPH_BASE}/${pageId}/messages?access_token=${accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_type: 'RESPONSE',
      recipient: { id: recipientId },
      message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [element] } } },
    }),
  });

  const data = (await res.json()) as MetaSendMessageResponse & MetaErrorResponse;
  if (!res.ok) {
    debugLog('facebook', 'error', 'fb_card_failed', 'error',
      `Card message to ${recipientId} FAILED - ${data.error?.code}: ${data.error?.message ?? 'unknown'}`,
      { pageId, recipientId, httpStatus: res.status });
    throwFromMetaResponse('sendFacebookCardMessage', res.status, data);
  }
  debugLog('facebook', 'info', 'fb_card_sent', 'ok', `Card message sent to ${recipientId}`, {
    pageId,
    recipientId,
    messageId: data.message_id,
  });
  return data.message_id;
}

/**
 * Messenger User Profile API - available for anyone who has messaged the
 * Page. Exposes first/last name and profile picture (no follow signal:
 * Facebook has no "follows the Page" field in the profile response, so
 * require-follow gates are not offered for Facebook automations).
 */
export interface FacebookUserProfile {
  firstName: string | null;
  lastName: string | null;
  profilePic: string | null;
}

export async function getFacebookUserProfile(
  psid: string,
  accessToken: string
): Promise<FacebookUserProfile | null> {
  try {
    const res = await fetch(
      `${FB_GRAPH_BASE}/${psid}?fields=first_name,last_name,profile_pic&access_token=${accessToken}`
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as MetaErrorResponse;
      debugLog('facebook', 'warn', 'fb_profile_fetch_failed', 'error',
        `Profile fetch for ${psid} failed - ${body.error?.code}: ${body.error?.message ?? `HTTP ${res.status}`}`,
        { psid, httpStatus: res.status });
      return null;
    }
    const data = (await res.json()) as { first_name?: string; last_name?: string; profile_pic?: string };
    return {
      firstName: data.first_name ?? null,
      lastName: data.last_name ?? null,
      profilePic: data.profile_pic ?? null,
    };
  } catch (err) {
    logger.warn({ psid, err }, 'Facebook profile fetch network error');
    return null;
  }
}

/**
 * Subscribes a Page to webhook fields. Meta requires this per-Page call
 * in addition to the app-level webhook URL - without it, NO events fire.
 * The same endpoint also lets the app check the current subscription
 * (GET) — see getSubscribedPageFields.
 */
export const FB_WEBHOOK_SUBSCRIBED_FIELDS = 'feed,messages,messaging_postbacks';

export async function subscribePageToWebhookFields(pageId: string, accessToken: string): Promise<{ ok: boolean; body: string }> {
  const params = new URLSearchParams({ subscribed_fields: FB_WEBHOOK_SUBSCRIBED_FIELDS, access_token: accessToken });
  const res = await fetch(`${FB_GRAPH_BASE}/${pageId}/subscribed_apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = await res.text();
  if (!res.ok) {
    let metaCode: number | undefined;
    try {
      metaCode = (JSON.parse(body) as MetaErrorResponse).error?.code;
    } catch {
      /* non-JSON upstream body — length + status still logged */
    }
    logger.warn(
      { pageId, status: res.status, bodyLength: body.length, metaCode },
      'Facebook webhook field subscription failed'
    );
  } else {
    debugLog('facebook', 'info', 'fb_webhook_subscribe', 'ok', `Webhook fields subscribed for Page ${pageId}`, {
      fields: FB_WEBHOOK_SUBSCRIBED_FIELDS,
    });
  }
  return { ok: res.ok, body };
}

export async function getSubscribedPageFields(pageId: string, accessToken: string): Promise<{ ok: boolean; fields: string[]; raw: string }> {
  const res = await fetch(`${FB_GRAPH_BASE}/${pageId}/subscribed_apps?access_token=${accessToken}`);
  const raw = await res.text();
  if (!res.ok) return { ok: false, fields: [], raw };
  type SubscribedAppsResponse = { data?: Array<{ subscribed_fields?: string[] }>; subscribed_fields?: string[] };
  let parsed: SubscribedAppsResponse = {};
  try {
    parsed = JSON.parse(raw) as SubscribedAppsResponse;
  } catch {
    /* ignore */
  }
  const fields = parsed.data?.[0]?.subscribed_fields ?? parsed.subscribed_fields ?? [];
  return { ok: true, fields, raw };
}

// ── Page posts (for the post picker) ─────────────────────────────────────────

export interface FacebookPost {
  id: string; // "{pageId}_{storyId}" composite — the same format feed webhooks report in post_id
  message?: string;
  story?: string;
  created_time?: string;
  full_picture?: string;
  permalink_url?: string;
  like_count?: number;
  comment_count?: number;
}

export interface FacebookPostsPage {
  posts: FacebookPost[];
  nextCursor: string | null;
}

const POST_FIELDS = 'id,message,story,created_time,full_picture,permalink_url,likes.summary(true),comments.summary(true)';

function mapFacebookPost(raw: Record<string, unknown>): FacebookPost {
  const likes = raw['likes'] as { summary?: { total_count?: number } } | undefined;
  const comments = raw['comments'] as { summary?: { total_count?: number } } | undefined;
  return {
    id: String(raw['id'] ?? ''),
    message: typeof raw['message'] === 'string' ? (raw['message'] as string) : undefined,
    story: typeof raw['story'] === 'string' ? (raw['story'] as string) : undefined,
    created_time: typeof raw['created_time'] === 'string' ? (raw['created_time'] as string) : undefined,
    full_picture: typeof raw['full_picture'] === 'string' ? (raw['full_picture'] as string) : undefined,
    permalink_url: typeof raw['permalink_url'] === 'string' ? (raw['permalink_url'] as string) : undefined,
    like_count: likes?.summary?.total_count,
    comment_count: comments?.summary?.total_count,
  };
}

/** Lists a Page's posts, newest first. `after` is the paging cursor; null first page. */
export async function listFacebookPosts(
  pageId: string,
  accessToken: string,
  limit = 20,
  after?: string | null
): Promise<FacebookPostsPage> {
  const params = new URLSearchParams({
    fields: POST_FIELDS,
    limit: String(Math.min(limit, 50)),
    access_token: accessToken,
  });
  if (after) params.set('after', after);
  const res = await fetch(`${FB_GRAPH_BASE}/${pageId}/posts?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as MetaErrorResponse;
    throw classifyMetaError(
      body.error?.message ?? `Facebook posts fetch failed (HTTP ${res.status})`,
      body.error?.code,
      body.error?.error_subcode
    );
  }
  const data = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    paging?: { cursors?: { after?: string }; next?: string };
  };
  return {
    posts: (data.data ?? []).map(mapFacebookPost).filter((p) => p.id),
    nextCursor: data.paging?.next ? (data.paging.cursors?.after ?? null) : null,
  };
}

/** Fetches a single Page post by its composite id ("{pageId}_{storyId}"). */
export async function getFacebookPost(postId: string, accessToken: string): Promise<FacebookPost | null> {
  const res = await fetch(`${FB_GRAPH_BASE}/${encodeURIComponent(postId)}?fields=${encodeURIComponent(POST_FIELDS)}&access_token=${accessToken}`);
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  if (!data['id']) return null;
  return mapFacebookPost(data);
}
