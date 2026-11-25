/**
 * Automations channel tabs (2026-11-20).
 *
 * Regression: /automations showed Instagram and Facebook automations
 * mixed in one list. The owner asked for them separate — an Instagram /
 * Facebook option at the top, each channel on its own. The list now
 * filters by the selected channel (persisted in localStorage, Instagram
 * by default), the empty state says plainly when the selected channel
 * has no account connected, and New automation opens the trigger
 * picker on the selected channel. If any of these pins break, the two
 * channels mix again or the empty state hides the real reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const readSrc = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

describe('channel toggle on the automations page', () => {
  const page = readSrc('app/(main)/automations/page.tsx');

  it('renders an Instagram / Facebook toggle in the same pill style as the tabs', () => {
    expect(page).toContain('ariaLabel="Automation channel"');
    // Shared PillToggle treatment (UI polish 2026-11-25): the pill
    // classes now live in the component, not inline in the page.
    expect(page).toContain('PillToggle');
    // md is the component default — the page relies on it.
    expect(readSrc('components/ui/PillToggle.tsx')).toContain('size = "md"');
    expect(page).toContain('InstagramGlyph');
    expect(page).toContain('FacebookGlyph');
    expect(page).toContain('"Instagram"');
    expect(page).toContain('"Facebook"');
  });

  it('defaults to Instagram and persists the choice in localStorage', () => {
    expect(page).toContain('opendm-automations-channel');
    expect(page).toContain('useState<ChannelTab>(() => {');
    expect(page).toContain('localStorage.getItem(CHANNEL_STORAGE_KEY)');
    expect(page).toContain('localStorage.setItem(CHANNEL_STORAGE_KEY, channelTab)');
    // Instagram is the default: first visit and any stored value that
    // is not "facebook" both resolve to it.
    expect(page).toContain('return "instagram"');
    expect(page).toContain('=== "facebook" ? "facebook" : "instagram"');
  });

  it('filters the list by the selected channel before the account filter', () => {
    expect(page).toContain('channelTab === "facebook"');
    expect(page).toContain('a.channel === "facebook" && activeFacebookPageId !== null && a.facebook_page_id === activeFacebookPageId');
    expect(page).toContain('a.channel !== "facebook" && a.instagram_account_id === accountId');
  });

  it('passes channel-aware empty copy and the channel to the create flow', () => {
    expect(page).toContain('emptyTitle={channelEmptyCopy.title}');
    expect(page).toContain('emptyMessage={channelEmptyCopy.message}');
    expect(page).toContain('initialChannel={channelTab}');
    expect(page).toContain('No Facebook Page connected');
    expect(page).toContain('Connect a Facebook Page in Settings');
    expect(page).toContain('No Instagram account selected');
  });
});

describe('AutomationsList channel-aware empty state', () => {
  const list = readSrc('components/automations/AutomationsList.tsx');

  it('accepts optional emptyTitle/emptyMessage and uses them in the empty state', () => {
    expect(list).toContain('emptyTitle?: string');
    expect(list).toContain('emptyMessage?: string');
    expect(list).toContain('emptyTitle ?? "No automations yet"');
    expect(list).toContain('emptyMessage ?? "Create one to reply to comments, DMs, or story replies automatically."');
  });
});

describe('create flow opens on the selected channel', () => {
  const modal = readSrc('components/automations/new-flow/NewAutomationModal.tsx');
  const step = readSrc('components/automations/new-flow/steps/SelectTypeStep.tsx');

  it('the modal takes an optional initialChannel and passes it to the trigger picker in create mode only', () => {
    expect(modal).toContain('initialChannel?: "instagram" | "facebook"');
    expect(modal).toContain('channelFilter={!isEditMode ? initialChannel : undefined}');
  });

  it('the trigger picker filters to the channel and hides IG-only templates for Facebook', () => {
    expect(step).toContain('channelFilter?: "instagram" | "facebook"');
    expect(step).toContain('if (channelFilter !== undefined && channel !== channelFilter) return false;');
    expect(step).toContain('onTemplateSelect && channelFilter !== "facebook"');
  });

  it('an empty filtered trigger list says why instead of rendering a blank grid', () => {
    expect(step).toContain('No triggers for this channel yet');
    expect(step).toContain('connect a Facebook Page in Settings first');
  });
});
