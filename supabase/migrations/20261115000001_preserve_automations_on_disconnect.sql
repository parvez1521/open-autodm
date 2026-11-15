-- Preserve automations on Instagram disconnect (owner decision 2026-11-15).
--
-- Before this change, disconnecting an Instagram account deleted the
-- instagram_accounts row, and the FK ON DELETE CASCADE wiped every
-- automation (plus jobs, logs and sessions) attached to it. The owner
-- had to disconnect @beyond_the.feed to fix a dead Meta token
-- (OAuthException 190) and would have lost 4 live automations.
--
-- After this change, disconnect is a SOFT disconnect: the account row
-- stays (is_active=false, disconnected_at set) and its automations are
-- auto-paused, not deleted. Reconnecting the SAME Instagram account
-- (matched by instagram_user_id, which is globally unique) reactivates
-- exactly the automations the disconnect paused. Automations the user
-- had paused manually keep paused_by_disconnect=false and stay paused
-- after a reconnect.
--
-- This migration is additive only: two new columns, no data deleted,
-- no constraint changed. Idempotent (IF NOT EXISTS).
--
-- DEPLOY GATE: apply this migration to the live Supabase database BEFORE
-- deploying code that selects/updates these columns, or the disconnect
-- and reconnect paths will fail with an unknown-column error.

alter table public.automations
  add column if not exists paused_by_disconnect boolean not null default false;

comment on column public.automations.paused_by_disconnect is
  'True when the automation was auto-paused by an Instagram disconnect (2026-11-15 preserve-on-disconnect). Reconnecting the same IG account reactivates exactly these automations; manually-paused automations keep this false.';

alter table public.instagram_accounts
  add column if not exists disconnected_at timestamptz;

comment on column public.instagram_accounts.disconnected_at is
  'When the account was soft-disconnected. The row is kept so its automations survive; a reconnect clears this.';
