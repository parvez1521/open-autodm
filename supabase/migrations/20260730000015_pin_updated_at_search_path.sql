-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 (Workstream 2) — DB hardening parity (row 31).
--
-- Ported from release-prep 20261028122007_pin_updated_at_search_path.sql, reviewed individually.
-- Production already has this (RP applied it); this file exists for
-- fresh-install parity and is idempotent-safe.
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

-- Pin the trigger helper's search_path and schema-qualify the clock function.
-- The helper runs only as a table trigger and does not need caller-controlled resolution.
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;
