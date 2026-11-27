-- "Save contacts" toggle (owner request, 2026-11-27).
--
-- The Contacts page gets an ON/OFF switch for whether people who
-- trigger an automation are saved as contacts. The setting lives on
-- profiles (one row per user, auto-created by the handle_new_user
-- trigger), NOT NULL DEFAULT true so existing behaviour is unchanged
-- and no backfill is needed: ON means "save contacts", exactly as
-- the engine has always done. The engine reads it in
-- src/lib/automation/contacts.ts (shouldSaveContacts) and skips the
-- record_*_contact_interaction RPC when the owner turned it OFF.
-- DMs still send normally; only the contact capture is skipped.
-- Must be applied to the STAGING DB via the Supabase dashboard SQL
-- editor (same route as the 2026-11-27 migrations).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS save_contacts BOOLEAN NOT NULL DEFAULT true;
