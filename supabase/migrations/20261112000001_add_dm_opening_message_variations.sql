-- Restore the opening-message variations column.
--
-- The a091ade builder (Oct 2026) wrote dm_opening_message_variations, but
-- the 985ed5c redesign dropped the field from the API and the editor, so
-- the column was never added to migrations here. This migration is
-- idempotent: safe to apply whether or not the column already exists in
-- the live database (it may, from the a091ade-era API inserts).
--
-- DEPLOY GATE: apply this migration to the live Supabase database BEFORE
-- deploying code that selects/inserts this column, or GET/POST /api/automations
-- will fail with an unknown-column error.
alter table public.automations
  add column if not exists dm_opening_message_variations text[] not null default '{}';

-- Backfill: automations created while the editor had no variations UI get
-- their single opening message as variation 1, so the engine's random pick
-- and the editor's Variation tabs both have something to show.
update public.automations
  set dm_opening_message_variations = array[dm_opening_message]
  where dm_opening_message <> ''
    and (dm_opening_message_variations is null or dm_opening_message_variations = '{}');
