-- ═══════════════════════════════════════════════════════════════════════════
-- Phase B / Programme 16 (productization COPY ONLY) — Add the 'viewer'
-- role to the workspace_role enum (Programme 16 role model:
-- owner / admin / member / viewer; viewer = read-only).
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. That list is UNCHANGED:
-- 000021 required; 000002/000003 conditional; 000022/000023
-- candidate-only; …000024–…000029 are Phase 13/14 copy-only artifacts.
-- This file (…000030) is likewise NOT on the frozen apply-list and must
-- never be applied to production under the release gates. ***
--
-- This file contains ONLY the enum addition (plus comments) on purpose:
-- in PostgreSQL a newly added enum value cannot be USED in the same
-- transaction that adds it, so every statement that references 'viewer'
-- (policies, RPCs, checks) lives in …000031 or later files.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'viewer';
