-- ═══════════════════════════════════════════════════════════════════════════
-- Facebook Page automation (owner decision 2026-11-19).
--
-- Mirrors the Instagram system for Facebook Pages, via Meta's official
-- Graph API (Pages only — personal profiles and Groups have no
-- automation path). Core mechanic: comment on a Page post → ONE private
-- Messenger reply per comment (7-day window) + optional public reply;
-- Messenger DMs to the Page → keyword / any-message auto-reply inside
-- the 24-hour standard messaging window.
--
-- DATA MODEL (least-invasive fit): the `automations` table is REUSED.
-- A `channel` discriminator ('instagram' | 'facebook') plus a nullable
-- `facebook_page_id` tell the two channels apart, and
-- `instagram_account_id` becomes nullable. New enum values
-- 'fb_comment_dm' / 'fb_dm_reply' keep every existing Instagram query
-- (which filters on type) exactly correct — no IG row can ever match a
-- Facebook query and vice versa. A separate facebook_automations table
-- was rejected: it would duplicate every automation column and force
-- the UI, API and engine to merge two tables for every list/send.
--
-- Additive only, idempotent (IF NOT EXISTS throughout). No data deleted,
-- no constraint narrowed. Instagram rows are untouched: channel defaults
-- to 'instagram' and the XOR check below holds for every existing row
-- (instagram_account_id set, facebook_page_id NULL).
--
-- DEPLOY GATE: apply this migration to the live Supabase database BEFORE
-- deploying code that reads/writes facebook_pages / fb_* automation
-- types, or Page connect + FB automation create will fail with
-- unknown-table / unknown-enum-value errors.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Facebook Pages (mirrors instagram_accounts, minus Traffic Guard) -----
CREATE TABLE IF NOT EXISTS public.facebook_pages (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  workspace_id            UUID        REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connected_by_user_id    UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,

  facebook_page_id        TEXT        NOT NULL,  -- Meta Page ID (entry.id on webhooks)
  name                    TEXT        NOT NULL,  -- Page display name
  username                TEXT,                  -- Page vanity username, when set
  profile_picture_url     TEXT,

  -- AES-256-GCM encrypted. Format: iv_hex:ciphertext_hex:authtag_hex. NEVER logged.
  -- Page access tokens obtained via a long-lived user token do not expire;
  -- token_expires_at stays NULL for those (mirrors IG's nullable expiry).
  access_token_encrypted  TEXT        NOT NULL,
  token_expires_at        TIMESTAMPTZ,

  is_active               BOOLEAN     NOT NULL DEFAULT true,

  -- Soft-disconnect (mirrors the 2026-11-15 preserve-on-disconnect
  -- contract): disconnecting pauses automations, never deletes them.
  disconnected_at         TIMESTAMPTZ,

  -- Safety circuit breaker: when Meta returns a policy/spam block for
  -- this Page, the engine pauses all sends until this timestamp.
  paused_until            TIMESTAMPTZ,
  pause_reason            TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One Page belongs to exactly one user on this instance (mirrors the
-- global UNIQUE on instagram_accounts.instagram_user_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_pages_page_id
  ON public.facebook_pages (facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_facebook_pages_user_id
  ON public.facebook_pages (user_id);
CREATE INDEX IF NOT EXISTS idx_facebook_pages_is_active
  ON public.facebook_pages (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_facebook_pages_workspace
  ON public.facebook_pages (workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'facebook_pages_updated_at'
  ) THEN
    CREATE TRIGGER facebook_pages_updated_at
      BEFORE UPDATE ON public.facebook_pages
      FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
  END IF;
END $$;

ALTER TABLE public.facebook_pages ENABLE ROW LEVEL SECURITY;

-- 2. Automations: channel discriminator + Facebook page link ----------------
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'instagram';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.automations'::regclass
      AND conname = 'automations_channel_check'
  ) THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_channel_check
      CHECK (channel IN ('instagram', 'facebook'));
  END IF;
END $$;

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;

-- Exactly one of the two account links is set (XOR). Every pre-existing
-- Instagram row satisfies this (instagram_account_id set, facebook_page_id NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.automations'::regclass
      AND conname = 'automations_account_link_check'
  ) THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_account_link_check
      CHECK ((instagram_account_id IS NULL) <> (facebook_page_id IS NULL));
  END IF;
END $$;

ALTER TABLE public.automations ALTER COLUMN instagram_account_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automations_facebook_page
  ON public.automations (facebook_page_id);
CREATE INDEX IF NOT EXISTS idx_automations_channel
  ON public.automations (channel);

ALTER TYPE public.automation_type ADD VALUE IF NOT EXISTS 'fb_comment_dm';
ALTER TYPE public.automation_type ADD VALUE IF NOT EXISTS 'fb_dm_reply';

-- 3. Job / dedupe / session tables: the account link becomes channel-aware --
-- dm_sent_log: per-(automation, comment) dedupe is what enforces Meta's
-- "one private reply per comment" rule for Facebook (no per-user dedupe
-- on FB: a second comment by the same person CAN still trigger).
ALTER TABLE public.dm_sent_log ALTER COLUMN instagram_account_id DROP NOT NULL;
ALTER TABLE public.dm_sent_log
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dm_sent_log_facebook_page
  ON public.dm_sent_log (facebook_page_id);

ALTER TABLE public.dm_jobs ALTER COLUMN instagram_account_id DROP NOT NULL;
ALTER TABLE public.dm_jobs
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dm_jobs_facebook_page
  ON public.dm_jobs (facebook_page_id);

ALTER TABLE public.automation_sessions ALTER COLUMN instagram_account_id DROP NOT NULL;
ALTER TABLE public.automation_sessions
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_automation_sessions_facebook_page
  ON public.automation_sessions (facebook_page_id);

-- 4. Per-Page rate limiter (mirrors check_and_record_dm_rate_limit) --------
-- dm_rate_events.instagram_account_id has a NOT NULL FK to
-- instagram_accounts, so a Facebook Page id cannot reuse that bucket.
ALTER TABLE public.dm_rate_events ALTER COLUMN instagram_account_id DROP NOT NULL;
ALTER TABLE public.dm_rate_events
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dm_rate_events_fb_window
  ON public.dm_rate_events (facebook_page_id, sent_at DESC);

-- 180 sends/hour rolling window per Page (same 20-send buffer under
-- Meta's 200/hour as the Instagram limiter; the private-reply allowance
-- is separately 750/hour per Page).
CREATE OR REPLACE FUNCTION public.check_and_record_fb_dm_rate_limit(
  p_page_id UUID,
  p_limit   INTEGER DEFAULT 180
)
RETURNS TABLE (allowed BOOLEAN, current_count INTEGER, retry_after_seconds INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count  INTEGER;
  v_oldest TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_page_id::text));

  DELETE FROM public.dm_rate_events
  WHERE facebook_page_id = p_page_id AND sent_at < NOW() - INTERVAL '1 hour';

  SELECT COUNT(*) INTO v_count
  FROM public.dm_rate_events
  WHERE facebook_page_id = p_page_id AND sent_at > NOW() - INTERVAL '1 hour';

  IF v_count >= p_limit THEN
    SELECT MIN(sent_at) INTO v_oldest
    FROM public.dm_rate_events
    WHERE facebook_page_id = p_page_id AND sent_at > NOW() - INTERVAL '1 hour';

    RETURN QUERY SELECT
      false,
      v_count,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_oldest + INTERVAL '1 hour' - NOW())))::INTEGER + 1);
    RETURN;
  END IF;

  INSERT INTO public.dm_rate_events (facebook_page_id) VALUES (p_page_id);

  RETURN QUERY SELECT true, v_count + 1, 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_and_record_fb_dm_rate_limit(UUID, INTEGER) TO service_role;

-- 5. Contacts: Facebook commenters / messengers land in the same table -----
ALTER TABLE public.contacts ALTER COLUMN instagram_account_id DROP NOT NULL;
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_contacts_facebook_page
  ON public.contacts (facebook_page_id);

-- One row per unique (Page, audience member) — mirrors
-- uq_contacts_account_audience. (Postgres treats NULLs as distinct, so
-- the Instagram unique index can never dedupe Facebook rows.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_fb_page_audience
  ON public.contacts (facebook_page_id, audience_ig_user_id);

-- Users see contacts captured by their own connected Pages (permissive
-- SELECT policies OR together, so the Instagram policy above still
-- applies unchanged to IG rows).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'contacts'
      AND policyname = 'Users can view own facebook contacts'
  ) THEN
    CREATE POLICY "Users can view own facebook contacts"
      ON public.contacts FOR SELECT
      USING (
        facebook_page_id IN (
          SELECT id FROM public.facebook_pages WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Facebook twin of record_contact_interaction (atomic upsert + counter).
CREATE OR REPLACE FUNCTION public.record_fb_contact_interaction(
  p_page_id       UUID,
  p_audience_id   TEXT,
  p_username      TEXT,
  p_trigger_type  TEXT,
  p_automation_id UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.contacts (
    facebook_page_id, audience_ig_user_id, username,
    last_trigger_type, last_automation_id
  )
  VALUES (p_page_id, p_audience_id, NULLIF(TRIM(p_username), ''), p_trigger_type, p_automation_id)
  ON CONFLICT (facebook_page_id, audience_ig_user_id) DO UPDATE SET
    last_interaction_at = NOW(),
    last_trigger_type   = EXCLUDED.last_trigger_type,
    last_automation_id  = COALESCE(EXCLUDED.last_automation_id, contacts.last_automation_id),
    username            = COALESCE(EXCLUDED.username, contacts.username),
    total_triggers      = contacts.total_triggers + 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_fb_contact_interaction(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;

-- Facebook twin of update_contact_profile (username enrichment from the
-- Messenger profile API; follows_business is not applicable — Facebook
-- has no "follows the Page" signal in the profile response, so it stays
-- untouched for FB rows).
CREATE OR REPLACE FUNCTION public.update_fb_contact_profile(
  p_page_id     UUID,
  p_audience_id TEXT,
  p_username    TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.contacts SET
    username = COALESCE(NULLIF(TRIM(p_username), ''), username)
  WHERE facebook_page_id = p_page_id AND audience_ig_user_id = p_audience_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_fb_contact_profile(UUID, TEXT, TEXT) TO service_role;

-- 6. Opt-out suppression: Facebook recipients suppress per Page -----------
ALTER TABLE public.recipient_opt_outs ALTER COLUMN instagram_account_id DROP NOT NULL;
ALTER TABLE public.recipient_opt_outs
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_recipient_opt_outs_fb_lookup
  ON public.recipient_opt_outs (facebook_page_id, recipient_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fb_recipient_opt_out
  ON public.recipient_opt_outs (facebook_page_id, recipient_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'recipient_opt_outs'
      AND policyname = 'Users can view own facebook recipient opt outs'
  ) THEN
    CREATE POLICY "Users can view own facebook recipient opt outs"
      ON public.recipient_opt_outs FOR SELECT
      TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.facebook_pages p
        WHERE p.id = recipient_opt_outs.facebook_page_id AND p.user_id = auth.uid()
      ));
  END IF;
END $$;

-- 7. dm_sent_log dedupe, channel-aware --------------------------------------
-- Instagram's "once per user per automation" guarantee lives in
-- uq_dm_sent_log_automation_user. Facebook deliberately does NOT have
-- it (a second comment by the same person CAN still trigger), so the
-- index becomes partial to Instagram rows only — every existing row
-- has facebook_page_id NULL, so IG semantics are byte-for-byte kept.
DROP INDEX IF EXISTS uq_dm_sent_log_automation_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_sent_log_automation_user_ig
  ON public.dm_sent_log (automation_id, trigger_user_id)
  WHERE facebook_page_id IS NULL;

-- Cross-automation claim for Facebook's "one private reply per comment":
-- the FB job processor inserts the claim row BEFORE sending; a second
-- automation (or a retried job) hitting the same comment gets a
-- conflict and skips. The index is scoped to trigger_type = 'comment'
-- so Messenger DM claims (one row per automation per message, like
-- Instagram) are NOT blocked across automations. Comment ids are
-- channel-scoped (FB composite "{storyId}_{commentId}" vs IG bare ids),
-- so the partial index cannot collide with Instagram rows.
ALTER TABLE public.dm_sent_log
  ADD COLUMN IF NOT EXISTS trigger_type TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_sent_log_fb_event
  ON public.dm_sent_log (trigger_event_id)
  WHERE facebook_page_id IS NOT NULL AND trigger_type = 'comment';

-- 8. Link click tracking: tracked links can belong to a Page -----------------
-- tracked_links.instagram_account_id is NOT NULL FK to instagram_accounts,
-- so a Facebook Page id could never be stored there. Make the Instagram
-- link nullable and add the Facebook twin (one of the two is always set).
ALTER TABLE public.tracked_links ALTER COLUMN instagram_account_id DROP NOT NULL;
ALTER TABLE public.tracked_links
  ADD COLUMN IF NOT EXISTS facebook_page_id UUID REFERENCES public.facebook_pages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_tracked_links_facebook_page
  ON public.tracked_links (facebook_page_id);
