-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 — AI usage log (owner-approved mixed scope, drafting only).
-- Adapted from §7 of release-prep
-- 20260731000005_public_replies_and_ai.sql: that file's ai_usage_log
-- section ONLY. Nothing else from …000005 is ported here — its non-AI
-- public-reply columns were already ported by the candidate's
-- 20260730000005_public_reply_gate.sql (Phase 5), its reservation tables
-- by 20260730000020_comment_reply_reservations.sql (Phase 6), and its
-- runtime AI columns are deliberately NOT created (runtime AI stays
-- deferred, phase6-ai-mixed-proposal.md §7).
--
-- Fix F-1 (proposal §2): the feature CHECK is release-prep's four values
-- PLUS 'follow_up_draft' PLUS 'response_draft' (six values). Release-prep's
-- CHECK rejected 'follow_up_draft' even though its own route logs it, so
-- every follow-up drafting call's usage row failed. The original four are
-- retained because production rows may already hold them.
--
-- The CHECK replacement below is idempotent across both database shapes:
--   * Fresh database: CREATE TABLE IF NOT EXISTS creates the table with
--     the extended CHECK already in place; the DO block then finds the
--     CHECK already correct and changes nothing.
--   * Production shape (table exists with release-prep's old CHECK):
--     the DO block drops any feature CHECK whose definition lacks
--     'follow_up_draft' (the old constraint, whatever its name) and
--     re-adds the extended one. CREATE TABLE IF NOT EXISTS alone would
--     silently leave the defect in place, so the replacement must not
--     rely on it.
--
-- FILE ONLY — never applied by the readiness work. Applying it anywhere
-- is a separate deploy-gate step, not part of the Phase 7 approval.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instagram_account_id  UUID        REFERENCES public.instagram_accounts(id) ON DELETE SET NULL,
  automation_id         UUID        REFERENCES public.automations(id) ON DELETE SET NULL,
  feature               TEXT        NOT NULL CHECK (feature IN ('opening_variations', 'runtime_response', 'public_reply_draft', 'public_reply_runtime', 'follow_up_draft', 'response_draft')),
  model                 TEXT        NOT NULL,
  prompt_tokens         INTEGER,
  completion_tokens     INTEGER,
  status                TEXT        NOT NULL CHECK (status IN ('success', 'error', 'fallback')),
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON public.ai_usage_log(user_id, created_at DESC);

-- F-1, second half: replace a pre-existing narrow feature CHECK (the
-- production shape) with the extended one. A feature CHECK that already
-- accepts 'follow_up_draft' is left untouched. Matching is by constraint
-- definition, not by name, so it works regardless of how the old
-- constraint was named.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.ai_usage_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%feature%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%follow_up_draft%'
  LOOP
    EXECUTE format('ALTER TABLE public.ai_usage_log DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.ai_usage_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%feature%'
  ) THEN
    ALTER TABLE public.ai_usage_log
      ADD CONSTRAINT ai_usage_log_feature_check
      CHECK (feature IN ('opening_variations', 'runtime_response', 'public_reply_draft', 'public_reply_runtime', 'follow_up_draft', 'response_draft'));
  END IF;
END $$;

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own AI usage" ON public.ai_usage_log;
CREATE POLICY "Users can view own AI usage"
  ON public.ai_usage_log FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.ai_usage_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ai_usage_log TO authenticated;
GRANT ALL ON TABLE public.ai_usage_log TO service_role;
