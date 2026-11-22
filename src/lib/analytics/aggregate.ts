/**
 * Analytics aggregation — the pure half of GET /api/analytics.
 *
 * Extracted 2026-11-22: the legacy and workspace-mode branches ran
 * byte-identical aggregation over their rows (totals, zero-filled
 * daily series, per-automation breakdown). Both branches now fetch
 * their rows (with their own scoping — SQL-side date filters in the
 * legacy branch, JS inRange filtering in workspace mode) and hand
 * the already-scoped rows here, so a metric definition can never
 * drift between the two paths. Channel filtering happens BEFORE this
 * helper runs: the caller hands it only the rows of the requested
 * channel (Instagram rows keyed by instagram_account_id, Facebook
 * rows by facebook_page_id), and the automationMeta list already
 * filtered to that channel.
 */

export const ANALYTICS_ROW_LIMIT = 20000;
export const ANALYTICS_MAX_DAYS = 400;

export interface AnalyticsJobRow {
  trigger_type: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  automation_id: string;
}

export interface AnalyticsSessionRow {
  automation_id: string;
  current_step: number;
  completed: boolean;
  started_at: string;
}

export interface AnalyticsContactRow {
  first_interaction_at: string;
  follows_business: boolean | null;
  last_automation_id: string | null;
}

export interface AnalyticsAutomationMeta {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  instagram_account_id: string | null;
  channel?: string;
  facebook_page_id?: string | null;
}

export interface AnalyticsTotals {
  triggers: number;
  comments: number;
  dmKeywords: number;
  storyReplies: number;
  delivered: number;
  failed: number;
  flowsStarted: number;
  flowsCompleted: number;
  askToFollowShown: number;
  followsGained: number;
  newContacts: number;
  newContactFollowers: number;
}

export interface AnalyticsDailyRow {
  date: string;
  comments: number;
  dms: number;
  stories: number;
  delivered: number;
  contacts: number;
}

export interface AnalyticsPerAutomationRow {
  id: string;
  name: string;
  type: string;
  channel: string;
  isActive: boolean;
  triggers: number;
  delivered: number;
  failed: number;
  flowsCompleted: number;
  follows: number;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function aggregateAnalytics(input: {
  jobs: AnalyticsJobRow[];
  sessions: AnalyticsSessionRow[];
  contacts: AnalyticsContactRow[];
  automationMeta: AnalyticsAutomationMeta[];
  automationId: string;
  from: Date;
  to: Date;
}): {
  totals: AnalyticsTotals;
  daily: AnalyticsDailyRow[];
  perAutomation: AnalyticsPerAutomationRow[];
  automations: { id: string; name: string; type: string; channel: string }[];
  truncated: boolean;
} {
  const { jobs, sessions, contacts, automationMeta, automationId, from, to } = input;

  const triggerTypes = ['comment', 'dm', 'story_reply'];
  const totals: AnalyticsTotals = {
    triggers: jobs.filter((j) => triggerTypes.includes(j.trigger_type)).length,
    comments: jobs.filter((j) => j.trigger_type === 'comment').length,
    dmKeywords: jobs.filter((j) => j.trigger_type === 'dm').length,
    storyReplies: jobs.filter((j) => j.trigger_type === 'story_reply').length,
    delivered: jobs.filter((j) => j.status === 'sent').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    flowsStarted: sessions.length,
    flowsCompleted: sessions.filter((s) => s.completed).length,
    askToFollowShown: sessions.filter((s) => s.current_step >= 2).length,
    followsGained: sessions.filter((s) => s.current_step >= 2 && s.completed).length,
    newContacts: contacts.length,
    newContactFollowers: contacts.filter((c) => c.follows_business === true).length,
  };

  const days: Record<string, AnalyticsDailyRow> = {};
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  let guard = 0;
  while (cursor <= end && guard < ANALYTICS_MAX_DAYS) {
    const key = cursor.toISOString().slice(0, 10);
    days[key] = { date: key, comments: 0, dms: 0, stories: 0, delivered: 0, contacts: 0 };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  for (const j of jobs) {
    const d = days[dayKey(j.created_at)];
    if (!d) continue;
    if (j.trigger_type === 'comment') d.comments += 1;
    else if (j.trigger_type === 'dm') d.dms += 1;
    else if (j.trigger_type === 'story_reply') d.stories += 1;
    if (j.status === 'sent') {
      const sd = days[dayKey(j.sent_at ?? j.created_at)];
      if (sd) sd.delivered += 1;
    }
  }
  for (const c of contacts) {
    const d = days[dayKey(c.first_interaction_at)];
    if (d) d.contacts += 1;
  }

  const byAutomation = new Map<string, { triggers: number; delivered: number; failed: number; flowsCompleted: number; follows: number }>();
  for (const j of jobs) {
    const row = byAutomation.get(j.automation_id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 };
    if (triggerTypes.includes(j.trigger_type)) row.triggers += 1;
    if (j.status === 'sent') row.delivered += 1;
    if (j.status === 'failed') row.failed += 1;
    byAutomation.set(j.automation_id, row);
  }
  for (const s of sessions) {
    const row = byAutomation.get(s.automation_id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 };
    if (s.completed) row.flowsCompleted += 1;
    if (s.current_step >= 2 && s.completed) row.follows += 1;
    byAutomation.set(s.automation_id, row);
  }

  const perAutomation: AnalyticsPerAutomationRow[] = automationMeta
    .filter((a) => automationId === 'all' || a.id === automationId)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      channel: a.channel ?? 'instagram',
      isActive: a.is_active,
      ...(byAutomation.get(a.id) ?? { triggers: 0, delivered: 0, failed: 0, flowsCompleted: 0, follows: 0 }),
    }))
    .sort((a, b) => b.triggers - a.triggers);

  return {
    totals,
    daily: Object.values(days),
    perAutomation,
    automations: automationMeta.map((a) => ({ id: a.id, name: a.name, type: a.type, channel: a.channel ?? 'instagram' })),
    truncated:
      jobs.length >= ANALYTICS_ROW_LIMIT ||
      sessions.length >= ANALYTICS_ROW_LIMIT ||
      contacts.length >= ANALYTICS_ROW_LIMIT,
  };
}
