/**
 * Facebook OAuth scopes (2026-11-19) — business_management is required.
 *
 * Regression: the Page connect failed with facebook_error=no_pages even
 * though the login dialog showed "Tech Hacks AI" selected. Live Graph
 * API Explorer tests proved /me/accounts returns {"data": []} for a
 * token with only the 5 page permissions, because the Page is an owned
 * Page of Business Portfolio "tech_hacks___". Adding business_management
 * to the token made /me/accounts return the Page. If this scope is ever
 * dropped from FB_REQUIRED_SCOPES, Pages owned by a Business Portfolio
 * silently stop connecting (the callback sees no Pages at all).
 */

import { describe, it, expect } from 'vitest';
import { FB_REQUIRED_SCOPES, buildFacebookOAuthUrl } from '@/lib/facebook/oauth';

describe('FB_REQUIRED_SCOPES', () => {
  it('includes business_management plus the 5 page permissions', () => {
    expect(FB_REQUIRED_SCOPES.split(',')).toEqual([
      'business_management',
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_metadata',
      'pages_messaging',
      'pages_manage_engagement',
    ]);
  });

  it('has no duplicate scopes', () => {
    const scopes = FB_REQUIRED_SCOPES.split(',');
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

describe('buildFacebookOAuthUrl', () => {
  it('requests business_management in the dialog scope', () => {
    const url = new URL(
      buildFacebookOAuthUrl('1586956306036999', 'https://opendm.in/api/facebook/callback', 'state-token')
    );
    expect(url.hostname).toBe('www.facebook.com');
    expect(url.searchParams.get('client_id')).toBe('1586956306036999');
    expect(url.searchParams.get('redirect_uri')).toBe('https://opendm.in/api/facebook/callback');
    const scopes = (url.searchParams.get('scope') ?? '').split(',');
    expect(scopes).toContain('business_management');
    expect(scopes).toContain('pages_messaging');
  });
});
