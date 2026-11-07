-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 (Workstream 1) — trigger_config for keyword hardening (row 8).
--
-- Adapted from release-prep 20260731000009_flow_graph_and_reel_trigger.sql,
-- reviewed individually. ONLY the trigger_config column is ported: the
-- webhook reads trigger_config.excluded_keywords from it, and the hardened
-- keyword matcher's explicit-wildcard check reads trigger_mode /
-- keywords_any_mode from it.
--
-- DELIBERATELY NOT PORTED from …000009: the flow_graph column and the
-- 'reel_dm' automation_type enum value — the flow-graph engine (row 19) is
-- out of scope for this workstream.
--
-- Production already has this column (RP …000009); this file exists for
-- fresh-install parity and is idempotent-safe.
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS trigger_config JSONB DEFAULT '{}'::JSONB;

COMMENT ON COLUMN public.automations.trigger_config IS
  'Extended trigger parameters (excluded_keywords, trigger_mode/keywords_any_mode explicit-wildcard opt-in)';
