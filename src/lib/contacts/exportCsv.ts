/**
 * Contacts CSV export (owner decision, 2026-11-17): a backup/list
 * download of the caller's own captured contacts. Export only —
 * there is deliberately no bulk-DM / outreach action built on top
 * of it: Meta forbids cold-DMing exported contacts.
 *
 * Columns (in order): username, audience_ig_user_id,
 * follows_business, first_interaction_at, last_interaction_at,
 * last_trigger_type, total_triggers.
 */

/** One contact row as the export route selects it from the DB. */
export interface ContactExportRow {
  username: string | null;
  audience_ig_user_id: string;
  follows_business: boolean | null;
  first_interaction_at: string | null;
  last_interaction_at: string | null;
  last_trigger_type: string | null;
  total_triggers: number;
}

export const CONTACT_EXPORT_COLUMNS: readonly string[] = [
  'username',
  'audience_ig_user_id',
  'follows_business',
  'first_interaction_at',
  'last_interaction_at',
  'last_trigger_type',
  'total_triggers',
] as const;

/**
 * RFC 4180 field escaping: empty for null/undefined; booleans as
 * "true"/"false"; anything containing a comma, double quote, CR or
 * LF is wrapped in double quotes with inner quotes doubled.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Header + one line per row, CRLF-separated, no trailing newline. */
export function contactsToCsv(rows: readonly ContactExportRow[]): string {
  const lines = [CONTACT_EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.username),
        csvEscape(row.audience_ig_user_id),
        csvEscape(row.follows_business),
        csvEscape(row.first_interaction_at),
        csvEscape(row.last_interaction_at),
        csvEscape(row.last_trigger_type),
        csvEscape(row.total_triggers),
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

/** Dated download filename, e.g. contacts-2026-11-17.csv. */
export function contactsExportFilename(now: Date = new Date()): string {
  return `contacts-${now.toISOString().slice(0, 10)}.csv`;
}
