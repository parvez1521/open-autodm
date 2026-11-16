/**
 * Contacts CSV export — pure builder tests (owner decision,
 * 2026-11-17). Pins the exact column set/order, RFC 4180 escaping
 * for hostile usernames, and null/boolean rendering.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTACT_EXPORT_COLUMNS,
  contactsToCsv,
  contactsExportFilename,
  csvEscape,
  type ContactExportRow,
} from '@/lib/contacts/exportCsv';

const BASE_ROW: ContactExportRow = {
  username: 'a-friend',
  audience_ig_user_id: '17841400008460056',
  follows_business: true,
  first_interaction_at: '2026-11-05T09:00:00Z',
  last_interaction_at: '2026-11-05T10:00:00Z',
  last_trigger_type: 'comment',
  total_triggers: 3,
};

describe('contacts CSV export: columns', () => {
  it('emits exactly the seven columns in order', () => {
    expect(CONTACT_EXPORT_COLUMNS).toEqual([
      'username',
      'audience_ig_user_id',
      'follows_business',
      'first_interaction_at',
      'last_interaction_at',
      'last_trigger_type',
      'total_triggers',
    ]);
  });

  it('header-only CSV for an empty list', () => {
    expect(contactsToCsv([])).toBe(
      'username,audience_ig_user_id,follows_business,first_interaction_at,last_interaction_at,last_trigger_type,total_triggers',
    );
  });

  it('renders one plain row verbatim', () => {
    const lines = contactsToCsv([BASE_ROW]).split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      'a-friend,17841400008460056,true,2026-11-05T09:00:00Z,2026-11-05T10:00:00Z,comment,3',
    );
  });
});

describe('contacts CSV export: escaping', () => {
  it('quotes fields with commas, quotes and newlines (RFC 4180)', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('a\rb')).toBe('"a\rb"');
  });

  it('escapes a hostile username inside a row', () => {
    const row: ContactExportRow = {
      ...BASE_ROW,
      username: 'weird, "name"\nsecond line',
    };
    // The embedded newline is a bare LF inside the quoted field,
    // so splitting on the CRLF row separator still yields exactly
    // header + one row — the newline never breaks the row.
    const lines = contactsToCsv([row]).split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '"weird, ""name""\nsecond line",17841400008460056,true,2026-11-05T09:00:00Z,2026-11-05T10:00:00Z,comment,3',
    );
  });

  it('renders nulls as empty and booleans as true/false', () => {
    const row: ContactExportRow = {
      username: null,
      audience_ig_user_id: '999',
      follows_business: false,
      first_interaction_at: null,
      last_interaction_at: '2026-11-05T10:00:00Z',
      last_trigger_type: null,
      total_triggers: 1,
    };
    expect(contactsToCsv([row]).split('\r\n')[1]).toBe(
      ',999,false,,2026-11-05T10:00:00Z,,1',
    );
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(true)).toBe('true');
    expect(csvEscape(false)).toBe('false');
    expect(csvEscape(0)).toBe('0');
  });
});

describe('contacts CSV export: filename', () => {
  it('uses a dated contacts-YYYY-MM-DD.csv name', () => {
    expect(contactsExportFilename(new Date('2026-11-17T05:30:00Z'))).toBe('contacts-2026-11-17.csv');
    expect(contactsExportFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
