/**
 * Facebook Login OAuth helpers for connecting a Facebook Page.
 *
 * Uses facebook.com/dialog/oauth — NOT Instagram's authorize endpoint.
 * The flow yields a User Access Token; the Page itself is then read
 * from /me/accounts (only Pages the user admins appear there), and the
 * Page Access Token from that list is what the engine stores and sends
 * with. A Page token obtained via a long-lived user token does not
 * expire, so no refresh loop is needed (unlike Instagram's 60-day
 * long-lived tokens).
 *
 * Hard-won facts (same family as the Instagram flow):
 *  - The code→token exchange is a plain GET with query params (Meta's
 *    docs use GET here; the Instagram flow's multipart FormData
 *    requirement does NOT apply).
 *  - The long-lived exchange is grant_type=fb_exchange_token.
 *  - Scopes are the Facebook Page permission names below; the app must
 *    pass App Review for them before anyone but app admins/testers can
 *    connect (Development mode until then).
 *  - business_management is REQUIRED, not optional: a Page owned by a
 *    Business Portfolio (e.g. "Tech Hacks AI", owned by portfolio
 *    "tech_hacks___") does NOT appear in /me/accounts for a token
 *    without it — the endpoint returns {"data": []} even though the
 *    dialog shows the Page selected and a direct /{page-id} lookup
 *    returns it with an access token. Proven live 2026-11-19: adding
 *    business_management made /me/accounts return the Page.
 */

import { FB_GRAPH_BASE } from '@/lib/facebook/api';
import type { FbShortLivedTokenResponse, FbLongLivedTokenResponse, FbPageAccount } from '@/lib/types';

const FB_OAUTH_URL = 'https://www.facebook.com/v23.0/dialog/oauth';
const FB_TOKEN_URL = `${FB_GRAPH_BASE}/oauth/access_token`;

/** Scopes required for Page automation (Facebook permission names).
 * business_management is required so Pages owned by a Business
 * Portfolio appear in /me/accounts (see header note above). */
export const FB_REQUIRED_SCOPES = [
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_manage_engagement',
].join(',');

export function buildFacebookOAuthUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: FB_REQUIRED_SCOPES,
    response_type: 'code',
    state,
  });
  return `${FB_OAUTH_URL}?${params.toString()}`;
}

export async function exchangeFacebookCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string
): Promise<FbShortLivedTokenResponse> {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    client_secret: appSecret,
    code,
  });
  const res = await fetch(`${FB_TOKEN_URL}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook token exchange failed: ${res.status} ${body} | redirect_uri="${redirectUri}".`);
  }
  const json = (await res.json()) as FbShortLivedTokenResponse;
  if (!json?.access_token) {
    throw new Error(`Facebook token exchange returned no access_token: ${JSON.stringify(json)}`);
  }
  return json;
}

export async function exchangeFacebookForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string
): Promise<FbLongLivedTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });
  const res = await fetch(`${FB_TOKEN_URL}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook long-lived token exchange failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as FbLongLivedTokenResponse;
  if (!json?.access_token) {
    throw new Error(`Facebook long-lived exchange returned no access_token: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Pages the user admins, with a Page access token for each. */
export async function listManagedFacebookPages(userAccessToken: string): Promise<FbPageAccount[]> {
  const params = new URLSearchParams({
    fields: 'id,name,category,username,access_token,picture{url}',
    limit: '100',
    access_token: userAccessToken,
  });
  const res = await fetch(`${FB_GRAPH_BASE}/me/accounts?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook /me/accounts fetch failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { data?: FbPageAccount[] };
  return (json.data ?? []).filter((p) => p.id && p.access_token);
}

/** Fetches a Page's public profile fields with its Page token. */
export async function getFacebookPageProfile(
  pageId: string,
  pageAccessToken: string
): Promise<{ id: string; name: string; username?: string; picture?: { data?: { url?: string } } } | null> {
  const params = new URLSearchParams({
    fields: 'id,name,username,picture{url}',
    access_token: pageAccessToken,
  });
  const res = await fetch(`${FB_GRAPH_BASE}/${encodeURIComponent(pageId)}?${params.toString()}`);
  if (!res.ok) return null;
  return (await res.json()) as { id: string; name: string; username?: string; picture?: { data?: { url?: string } } };
}
