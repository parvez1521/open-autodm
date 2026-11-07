-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 (Workstream 1) — Public reply gate columns (row 6).
--
-- Adapted from release-prep 20260731000005_public_replies_and_ai.sql,
-- reviewed individually. ONLY the two non-AI columns the restored gate
-- needs are ported:
--   public_reply_enabled  — the ON/OFF gate the engine now honours
--   public_reply_options  — preferred reply pool (falls back to
--                           comment_reply_options in the engine)
--
-- DELIBERATELY NOT PORTED from …000005 (AI / reservation scope):
--   public_reply_mode, public_reply_ai_instructions, ai_runtime_*,
--   ai_model, dm_opening_message_variations, ai_usage_log, and the
--   comment_public_reply_reservations table + RPCs (row 13 was classified
--   REPLACED BY DIFFERENT IMPLEMENTATION — the candidate's dedupe design
--   stays). AI features are a separate pending owner decision.
--
-- Production already has these columns (RP …000005); this file exists for
-- fresh-install parity and is idempotent-safe.
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS public_reply_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_reply_options TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill the preferred pool from the legacy pool where one exists
-- (same backfill release-prep performed).
UPDATE public.automations
SET public_reply_options = comment_reply_options
WHERE pg_catalog.array_length(comment_reply_options, 1) > 0
  AND (pg_catalog.array_length(public_reply_options, 1) IS NULL
       OR pg_catalog.array_length(public_reply_options, 1) = 0);
