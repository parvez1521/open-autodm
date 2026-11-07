-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 (Workstream 2) — Flow graph + Reel trigger (row 19).
--
-- Adapted from release-prep 20260731000009_flow_graph_and_reel_trigger.sql,
-- reviewed individually. The trigger_config column from that migration was
-- already ported by the safety workstream (candidate …000004), so only the
-- two remaining pieces are added here:
--   1. the 'reel_dm' value on the automation_type enum (shared-Reel DM
--      trigger), and
--   2. the automations.flow_graph JSONB column (canonical visual flow
--      builder graph executed by src/lib/automation/flowEngine.ts).
--
-- Production already has both (RP …000009); this file exists for
-- fresh-install parity and is idempotent-safe (IF NOT EXISTS throughout;
-- the enum ADD VALUE is a no-op when the value is already present).
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Forward-only enum extension for incoming shared-Reel DM trigger
ALTER TYPE public.automation_type ADD VALUE IF NOT EXISTS 'reel_dm';

-- 2. Add canonical flow_graph JSONB column to automations table
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS flow_graph JSONB DEFAULT NULL;

COMMENT ON COLUMN public.automations.flow_graph IS 'Canonical visual flow builder graph (nodes, edges, positions, version)';
