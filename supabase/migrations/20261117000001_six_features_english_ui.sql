-- ═══════════════════════════════════════════════════════════════════════════
-- Six-feature batch + English-only UI sweep (owner decisions 2026-11-17).
--
--   1. Story Mention trigger: 'story_mention' on the automation_type enum.
--   2. Lead form capture: lead_submissions + pending_lead_captures tables.
--   3. Link click tracking: tracked_links + link_clicks tables.
--   4. AI reply language: automations.ai_reply_language ('en' | 'hinglish').
--   5. dm_jobs.trigger_type CHECK extended: 'reel_dm' was never in the
--      list, so every reel_dm job's dm_jobs upsert has been failing the
--      CHECK (swallowed as a warning in markJobStatus) since reel_dm
--      shipped; 'story_mention' joins it here.
--
-- Additive only, idempotent (IF NOT EXISTS throughout). No data deleted,
-- no constraint narrowed.
--
-- DEPLOY GATE: apply this migration to the live Supabase database BEFORE
-- deploying code that reads/writes these tables/columns, or the
-- story-mention create, lead capture, and link-click paths will fail
-- with unknown-column / unknown-table errors.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Story Mention trigger type -------------------------------------------
ALTER TYPE public.automation_type ADD VALUE IF NOT EXISTS 'story_mention';

-- 2. dm_jobs trigger_type CHECK: add 'reel_dm' + 'story_mention' ----------
-- The CHECK was created inline in the core schema, so its name is the
-- Postgres default ({table}_{column}_check); drop by definition match so
-- this stays idempotent on any database where it was already widened.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'dm_jobs'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%trigger_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.dm_jobs DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE public.dm_jobs
    ADD CONSTRAINT dm_jobs_trigger_type_check
    CHECK (trigger_type IN ('comment', 'dm', 'story_reply', 'dm_reply_followup', 'reel_dm', 'story_mention'));
END $$;

-- 3. AI reply language per automation --------------------------------------
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS ai_reply_language TEXT NOT NULL DEFAULT 'en';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.automations'::regclass
      AND conname = 'automations_ai_reply_language_check'
  ) THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_ai_reply_language_check
      CHECK (ai_reply_language IN ('en', 'hinglish'));
  END IF;
END $$;

COMMENT ON COLUMN public.automations.ai_reply_language IS
  'Language for AI-generated drafts/replies on this automation: en (English) or hinglish (Hindi in Roman script). UI labels stay English either way.';

-- 4. Link click tracking ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tracked_links (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  TEXT        NOT NULL UNIQUE,
  automation_id         UUID        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  destination_url       TEXT        NOT NULL,
  click_count           INTEGER     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_links_automation_url
  ON public.tracked_links (automation_id, destination_url);
CREATE INDEX IF NOT EXISTS idx_tracked_links_code
  ON public.tracked_links (code);
CREATE INDEX IF NOT EXISTS idx_tracked_links_automation
  ON public.tracked_links (automation_id);

ALTER TABLE public.tracked_links ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tracked_links'
      AND policyname = 'Users can view own tracked links'
  ) THEN
    CREATE POLICY "Users can view own tracked links"
      ON public.tracked_links FOR SELECT
      USING (automation_id IN (SELECT id FROM public.automations WHERE user_id = auth.uid()));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.link_clicks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_link_id UUID        NOT NULL REFERENCES public.tracked_links(id) ON DELETE CASCADE,
  clicked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_clicks_link
  ON public.link_clicks (tracked_link_id, clicked_at DESC);

-- Atomic click counter (mirrors increment_automation_dms_sent).
CREATE OR REPLACE FUNCTION public.increment_tracked_link_clicks(p_tracked_link_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.tracked_links SET click_count = click_count + 1 WHERE id = p_tracked_link_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_tracked_link_clicks(UUID) TO service_role;

ALTER TABLE public.link_clicks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'link_clicks'
      AND policyname = 'Users can view own link clicks'
  ) THEN
    CREATE POLICY "Users can view own link clicks"
      ON public.link_clicks FOR SELECT
      USING (tracked_link_id IN (
        SELECT id FROM public.tracked_links
        WHERE automation_id IN (SELECT id FROM public.automations WHERE user_id = auth.uid())
      ));
  END IF;
END $$;

-- 5. Lead form capture -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_submissions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id         UUID        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  audience_ig_user_id   TEXT        NOT NULL,
  username              TEXT,
  field                 TEXT        NOT NULL CHECK (field IN ('email', 'phone')),
  value                 TEXT        NOT NULL,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_submissions_automation
  ON public.lead_submissions (automation_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_submissions_account
  ON public.lead_submissions (instagram_account_id, submitted_at DESC);

ALTER TABLE public.lead_submissions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lead_submissions'
      AND policyname = 'Users can view own lead submissions'
  ) THEN
    CREATE POLICY "Users can view own lead submissions"
      ON public.lead_submissions FOR SELECT
      USING (automation_id IN (SELECT id FROM public.automations WHERE user_id = auth.uid()));
  END IF;
END $$;

-- One pending ask per (automation, audience member): a lead-form ask is
-- answered by the audience member's next free-text DM; the row is deleted
-- once the answer is captured (or expires after 24h, Meta's DM window).
CREATE TABLE IF NOT EXISTS public.pending_lead_captures (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id         UUID        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  audience_ig_user_id   TEXT        NOT NULL,
  fields                TEXT[]      NOT NULL DEFAULT ARRAY['email'],
  response_id           TEXT,
  asked_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_lead_captures_user
  ON public.pending_lead_captures (automation_id, audience_ig_user_id);
CREATE INDEX IF NOT EXISTS idx_pending_lead_captures_audience
  ON public.pending_lead_captures (instagram_account_id, audience_ig_user_id, expires_at);

ALTER TABLE public.pending_lead_captures ENABLE ROW LEVEL SECURITY;
