/**
 * Phase 10.3 E2E (Area 5) — keyword matching at ingestion, comment + DM.
 *
 * tests/keyword-match.test.ts proves the matcher function itself and
 * tests/parity-webhook.test.ts proves the comment path (empty/null
 * never fire, *ANY* opt-in, excluded veto, exact-standalone comments).
 * This file EXTENDS coverage to the paths those files do not drive:
 * the DM / story-reply ingestion matrix (whole-word DM semantics —
 * deliberately DIFFERENT from comment exact-standalone), routing
 * isolation between dm_reply and story_reply automations, the excluded
 * veto on the DM path, and the flow-graph wildcard opt-in form at
 * webhook level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeSupabase, type FakeRow } from '../helpers/fakeSupabase';
import {
  accountRow,
  automationRow,
  commentWebhookBody,
  dmWebhookBody,
  storyReplyWebhookBody,
  E2E,
} from './fixtures/payloads';

const fake = new FakeSupabase();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake }));
vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));

import { processWebhookPayload } from '@/lib/automation/processWebhook';

function dmAutomation(overrides: FakeRow = {}): FakeRow {
  return automationRow({ type: 'dm_reply', keywords: ['LINK'], ...overrides });
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearRpcHandlers();
  fake.replaceRows('instagram_accounts', [accountRow()]);
  fake.replaceRows('automations', []);
  fake.replaceRows('job_queue', []);
  fake.replaceRows('recipient_opt_outs', []);
  fake.replaceRows('automation_follow_ups', []);
});

describe('DM-path matching (whole-word, NOT exact-standalone)', () => {
  it('a keyword inside a sentence FIRES a DM automation (unlike the comment funnel)', async () => {
    fake.seed('automations', [dmAutomation()]);
    expect(await processWebhookPayload(dmWebhookBody('please send LINK now'))).toBe(1);
    expect(fake.rows('job_queue')).toHaveLength(1);
  });

  it('case-insensitive: lowercase text matches an uppercase keyword', async () => {
    fake.seed('automations', [dmAutomation()]);
    expect(await processWebhookPayload(dmWebhookBody('link please'))).toBe(1);
  });

  it('a substring inside a larger word does NOT fire (whole-word boundary)', async () => {
    fake.seed('automations', [dmAutomation()]);
    expect(await processWebhookPayload(dmWebhookBody('check my hyperlink'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('excluded keyword vetoes the DM path even when the trigger matches', async () => {
    fake.seed('automations', [
      dmAutomation({ trigger_config: { excluded_keywords: ['spamword'] } }),
    ]);
    expect(await processWebhookPayload(dmWebhookBody('LINK spamword'))).toBe(0);
    // Control: the same automation fires without the excluded word.
    expect(await processWebhookPayload(dmWebhookBody('LINK', 'mid-e2e-2'))).toBe(1);
  });

  it('NULL and EMPTY keyword lists NEVER fire on the DM path either', async () => {
    fake.seed('automations', [dmAutomation({ id: 'auto-null', keywords: null })]);
    expect(await processWebhookPayload(dmWebhookBody('LINK'))).toBe(0);
    fake.replaceRows('automations', [dmAutomation({ id: 'auto-empty', keywords: [] })]);
    expect(await processWebhookPayload(dmWebhookBody('LINK', 'mid-e2e-3'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });
});

describe('routing isolation: one event fires only its own automation type', () => {
  it('a story reply fires ONLY the story_reply automation; a plain DM fires ONLY dm_reply', async () => {
    fake.seed('automations', [
      dmAutomation({ id: 'auto-dm' }),
      dmAutomation({ id: 'auto-story', type: 'story_reply' }),
    ]);

    expect(await processWebhookPayload(storyReplyWebhookBody('LINK'))).toBe(1);
    let jobs = fake.rows('job_queue');
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!['payload'] as FakeRow)['automationId']).toBe('auto-story');

    fake.replaceRows('job_queue', []);
    expect(await processWebhookPayload(dmWebhookBody('LINK', 'mid-e2e-plain'))).toBe(1);
    jobs = fake.rows('job_queue');
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!['payload'] as FakeRow)['automationId']).toBe('auto-dm');
  });
});

describe('wildcard opt-in forms at webhook level', () => {
  it('flow-graph trigger node with keywordsAnyMode=true opts a comment automation in (null keywords)', async () => {
    fake.seed('automations', [
      automationRow({
        keywords: null,
        flow_graph: { nodes: [{ type: 'trigger', data: { keywordsAnyMode: true } }] },
      }),
    ]);
    expect(await processWebhookPayload(commentWebhookBody('totally unrelated words'))).toBe(1);
  });

  it('a flow-graph whose SEND node (not trigger) carries the flag does NOT opt in', async () => {
    fake.seed('automations', [
      automationRow({
        keywords: null,
        flow_graph: { nodes: [{ type: 'send_dm', data: { keywordsAnyMode: true } }] },
      }),
    ]);
    expect(await processWebhookPayload(commentWebhookBody('totally unrelated words'))).toBe(0);
    expect(fake.rows('job_queue')).toHaveLength(0);
  });

  it('comment funnel recap (hardened core): exact standalone fires, sentence does not, *ANY* token fires', async () => {
    fake.seed('automations', [automationRow()]);
    expect(await processWebhookPayload(commentWebhookBody('send LINK please', 'cmt-x1'))).toBe(0);
    expect(await processWebhookPayload(commentWebhookBody('link', 'cmt-x2'))).toBe(1);

    fake.replaceRows('automations', [automationRow({ keywords: ['*ANY*'] })]);
    fake.replaceRows('job_queue', []);
    expect(await processWebhookPayload(commentWebhookBody('anything at all', 'cmt-x3'))).toBe(1);
    expect(E2E.automationId).toBeTruthy();
  });
});
