-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 (Workstream 1) — Smart Comment Traffic Guard, adapted from
-- release-prep migrations (each reviewed individually):
--   20260731000006_comment_traffic_guard.sql        (base system)
--   20261028144525_harden_traffic_guard_rpcs.sql    (grant tightening +
--                                                    incident validation)
--   20261101102107_harden_traffic_guard_resume.sql  (resume replay guard)
--   20261101102552_separate_traffic_guard_pause_incident.sql
--                                                    (pause-origin incident)
-- They are replayed in production order; every statement is CREATE OR
-- REPLACE / IF NOT EXISTS, so the file is idempotent-safe and its end state
-- matches production exactly. Production already has all of this — the file
-- exists for fresh-install parity.
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════
-- Migration: 20260731000006_comment_traffic_guard.sql
--
-- Smart Comment Traffic Guard:
--  1. comment_traffic_events: Rolling-window unique comment reception tracking.
--     Deduplicated per (instagram_account_id, comment_id) with server timestamp.
--  2. comment_traffic_incidents: Durable state machine for traffic spikes (normal,
--     high_traffic, recovered) with configurable thresholds and pause tracking.
--  3. traffic_guard_notifications: Persistent owner notifications with strict
--     per-incident uniqueness (zero alert storm or duplicate alerts).
--  4. Schema additions:
--     - automations: is_traffic_guard_paused, traffic_guard_paused_at, traffic_guard_incident_id
--     - instagram_accounts: traffic_guard_status, traffic_guard_paused, traffic_guard_incident_id, traffic_guard_settings
--     - job_queue: check constraint updated to allow 'held' status
--  5. Hardened RPCs with pinned search_path ('') and owner/service-role isolation:
--     - record_comment_traffic_events
--     - evaluate_traffic_guard_state
--     - traffic_guard_pause_account
--     - traffic_guard_resume_account
--     - get_traffic_guard_status
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. comment_traffic_events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.comment_traffic_events (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  comment_id            TEXT        NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_comment_traffic_events UNIQUE (instagram_account_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_traffic_events_window
  ON public.comment_traffic_events (instagram_account_id, received_at DESC);

ALTER TABLE public.comment_traffic_events ENABLE ROW LEVEL SECURITY;

-- Deny all client mutations directly on comment_traffic_events
REVOKE ALL ON TABLE public.comment_traffic_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.comment_traffic_events TO service_role;


-- ── 2. comment_traffic_incidents ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.comment_traffic_incidents (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_account_id        UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  user_id                     UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status                      TEXT        NOT NULL DEFAULT 'high_traffic'
                                          CHECK (status IN ('high_traffic', 'recovered', 'dismissed')),
  peak_comments_per_minute    INTEGER     NOT NULL DEFAULT 20,
  threshold_high              INTEGER     NOT NULL DEFAULT 20,
  threshold_recovery          INTEGER     NOT NULL DEFAULT 5,
  recovery_duration_seconds   INTEGER     NOT NULL DEFAULT 300,
  opened_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_spike_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recovered_at                TIMESTAMPTZ,
  paused_at                   TIMESTAMPTZ,
  paused_automation_ids       UUID[]      DEFAULT ARRAY[]::UUID[],
  resumed_at                  TIMESTAMPTZ,
  dismissed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_traffic_incidents_acc_status
  ON public.comment_traffic_incidents (instagram_account_id, status);

ALTER TABLE public.comment_traffic_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own traffic incidents" ON public.comment_traffic_incidents;
CREATE POLICY "Users can read own traffic incidents"
  ON public.comment_traffic_incidents
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own traffic incidents" ON public.comment_traffic_incidents;
CREATE POLICY "Users can update own traffic incidents"
  ON public.comment_traffic_incidents
  FOR UPDATE
  USING (auth.uid() = user_id);

GRANT SELECT, UPDATE ON TABLE public.comment_traffic_incidents TO authenticated;
GRANT ALL ON TABLE public.comment_traffic_incidents TO service_role;


-- ── 3. traffic_guard_notifications ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.traffic_guard_notifications (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  incident_id           UUID        NOT NULL REFERENCES public.comment_traffic_incidents(id) ON DELETE CASCADE,
  type                  TEXT        NOT NULL CHECK (type IN ('high_traffic', 'recovered')),
  title                 TEXT        NOT NULL,
  message               TEXT        NOT NULL,
  is_read               BOOLEAN     NOT NULL DEFAULT false,
  read_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_traffic_guard_notif UNIQUE (incident_id, type)
);

CREATE INDEX IF NOT EXISTS idx_traffic_notif_user_unread
  ON public.traffic_guard_notifications (user_id, is_read, created_at DESC);

ALTER TABLE public.traffic_guard_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own traffic notifications" ON public.traffic_guard_notifications;
CREATE POLICY "Users can read own traffic notifications"
  ON public.traffic_guard_notifications
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own traffic notifications" ON public.traffic_guard_notifications;
CREATE POLICY "Users can update own traffic notifications"
  ON public.traffic_guard_notifications
  FOR UPDATE
  USING (auth.uid() = user_id);

GRANT SELECT, UPDATE ON TABLE public.traffic_guard_notifications TO authenticated;
GRANT ALL ON TABLE public.traffic_guard_notifications TO service_role;


-- ── 4. Extend existing tables ────────────────────────────────────────────────

-- Automations tracking
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS is_traffic_guard_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS traffic_guard_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS traffic_guard_incident_id UUID REFERENCES public.comment_traffic_incidents(id) ON DELETE SET NULL;

-- Account tracking
ALTER TABLE public.instagram_accounts
  ADD COLUMN IF NOT EXISTS traffic_guard_status TEXT NOT NULL DEFAULT 'normal'
    CHECK (traffic_guard_status IN ('normal', 'high_traffic', 'recovered')),
  ADD COLUMN IF NOT EXISTS traffic_guard_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS traffic_guard_incident_id UUID REFERENCES public.comment_traffic_incidents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS traffic_guard_settings JSONB NOT NULL DEFAULT
    '{"high_traffic_threshold": 20, "recovery_threshold": 5, "recovery_duration_seconds": 300, "window_seconds": 60}'::jsonb;

-- Job queue: expand status check to support 'held' state
ALTER TABLE public.job_queue
  DROP CONSTRAINT IF EXISTS job_queue_status_check;

ALTER TABLE public.job_queue
  ADD CONSTRAINT job_queue_status_check
  CHECK (status IN ('pending', 'processing', 'done', 'failed', 'held'));


-- ── 5. RPC Functions ─────────────────────────────────────────────────────────

-- 5a. Record unique comment reception events
CREATE OR REPLACE FUNCTION public.record_comment_traffic_events(
  p_instagram_account_id UUID,
  p_comment_ids          TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted_count INTEGER := 0;
  v_current_count  INTEGER := 0;
BEGIN
  IF p_comment_ids IS NOT NULL AND pg_catalog.array_length(p_comment_ids, 1) > 0 THEN
    WITH inserted AS (
      INSERT INTO public.comment_traffic_events (instagram_account_id, comment_id, received_at)
      SELECT p_instagram_account_id, cid, pg_catalog.now()
      FROM pg_catalog.unnest(p_comment_ids) AS cid
      WHERE cid IS NOT NULL AND cid <> ''
      ON CONFLICT (instagram_account_id, comment_id) DO NOTHING
      RETURNING 1
    )
    SELECT pg_catalog.count(*) INTO v_inserted_count FROM inserted;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_current_count
  FROM public.comment_traffic_events
  WHERE instagram_account_id = p_instagram_account_id
    AND received_at >= pg_catalog.now() - INTERVAL '60 seconds';

  RETURN pg_catalog.jsonb_build_object(
    'inserted_count', v_inserted_count,
    'current_60s_count', v_current_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_comment_traffic_events(UUID, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_comment_traffic_events(UUID, TEXT[]) TO service_role;


-- 5b. Evaluate traffic guard state machine for an account
CREATE OR REPLACE FUNCTION public.evaluate_traffic_guard_state(
  p_instagram_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account                 RECORD;
  v_settings                JSONB;
  v_thresh_high             INTEGER;
  v_thresh_rec              INTEGER;
  v_rec_sec                 INTEGER;
  v_window_sec              INTEGER;
  v_count_window            INTEGER := 0;
  v_open_incident           RECORD;
  v_incident_id             UUID;
  v_notification_emitted    TEXT := NULL;
  v_state                   TEXT;
BEGIN
  -- Race safety: advisory lock per account serializes concurrent webhook evaluations
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('traffic_guard_' || p_instagram_account_id::text));

  SELECT id, user_id, traffic_guard_status, traffic_guard_settings
  INTO v_account
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('error', 'Account not found');
  END IF;

  v_settings := COALESCE(
    v_account.traffic_guard_settings,
    '{"high_traffic_threshold": 20, "recovery_threshold": 5, "recovery_duration_seconds": 300, "window_seconds": 60}'::jsonb
  );

  v_thresh_high := COALESCE((v_settings->>'high_traffic_threshold')::INTEGER, 20);
  v_thresh_rec  := COALESCE((v_settings->>'recovery_threshold')::INTEGER, 5);
  v_rec_sec     := COALESCE((v_settings->>'recovery_duration_seconds')::INTEGER, 300);
  v_window_sec  := COALESCE((v_settings->>'window_seconds')::INTEGER, 60);

  -- Count unique comment events in the rolling window
  SELECT pg_catalog.count(*)
  INTO v_count_window
  FROM public.comment_traffic_events
  WHERE instagram_account_id = p_instagram_account_id
    AND received_at >= pg_catalog.now() - (v_window_sec * INTERVAL '1 second');

  -- Find any currently open high_traffic incident for this account
  SELECT * INTO v_open_incident
  FROM public.comment_traffic_incidents
  WHERE instagram_account_id = p_instagram_account_id
    AND status = 'high_traffic'
  ORDER BY opened_at DESC
  LIMIT 1;

  IF v_count_window >= v_thresh_high THEN
    v_state := 'high_traffic';

    IF v_open_incident.id IS NULL THEN
      -- Case 1: Transition normal/recovered -> high_traffic. Open new incident.
      INSERT INTO public.comment_traffic_incidents (
        instagram_account_id,
        user_id,
        status,
        peak_comments_per_minute,
        threshold_high,
        threshold_recovery,
        recovery_duration_seconds,
        opened_at,
        last_spike_at
      ) VALUES (
        p_instagram_account_id,
        v_account.user_id,
        'high_traffic',
        v_count_window,
        v_thresh_high,
        v_thresh_rec,
        v_rec_sec,
        pg_catalog.now(),
        pg_catalog.now()
      )
      RETURNING id INTO v_incident_id;

      -- Create persistent owner notification
      INSERT INTO public.traffic_guard_notifications (
        user_id,
        instagram_account_id,
        incident_id,
        type,
        title,
        message
      ) VALUES (
        v_account.user_id,
        p_instagram_account_id,
        v_incident_id,
        'high_traffic',
        'Unusually high Instagram comment traffic',
        'This account received 20+ unique comments within 60 seconds. Consider pausing its automations to reduce operational and Meta rate-limit risk.'
      )
      ON CONFLICT (incident_id, type) DO NOTHING;

      UPDATE public.instagram_accounts
      SET traffic_guard_status = 'high_traffic',
          traffic_guard_incident_id = v_incident_id,
          updated_at = pg_catalog.now()
      WHERE id = p_instagram_account_id;

      v_notification_emitted := 'high_traffic';
    ELSE
      -- Incident already open: update peak rate and reset last_spike_at
      v_incident_id := v_open_incident.id;
      UPDATE public.comment_traffic_incidents
      SET peak_comments_per_minute = GREATEST(peak_comments_per_minute, v_count_window),
          last_spike_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      WHERE id = v_open_incident.id;
    END IF;

  ELSE
    -- Rate is below high threshold (< 20)
    IF v_open_incident.id IS NOT NULL THEN
      v_incident_id := v_open_incident.id;

      IF v_count_window >= v_thresh_rec THEN
        -- Traffic is fluctuating (e.g. 5-19 comments/60s). Reset recovery timer.
        UPDATE public.comment_traffic_incidents
        SET last_spike_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
        WHERE id = v_open_incident.id;
        v_state := 'high_traffic';
      ELSE
        -- Traffic is below recovery threshold (< 5)
        IF pg_catalog.now() - v_open_incident.last_spike_at >= (v_rec_sec * INTERVAL '1 second') THEN
          -- Traffic has remained below recovery threshold for 5 consecutive minutes: NORMALIZED!
          UPDATE public.comment_traffic_incidents
          SET status = 'recovered',
              recovered_at = pg_catalog.now(),
              updated_at = pg_catalog.now()
          WHERE id = v_open_incident.id;

          UPDATE public.instagram_accounts
          SET traffic_guard_status = 'recovered',
              updated_at = pg_catalog.now()
          WHERE id = p_instagram_account_id;

          INSERT INTO public.traffic_guard_notifications (
            user_id,
            instagram_account_id,
            incident_id,
            type,
            title,
            message
          ) VALUES (
            v_account.user_id,
            p_instagram_account_id,
            v_open_incident.id,
            'recovered',
            'Instagram comment traffic has normalized',
            'Comment volume has remained below the recovery threshold. Review whether previously paused automations are ready to resume.'
          )
          ON CONFLICT (incident_id, type) DO NOTHING;

          v_state := 'recovered';
          v_notification_emitted := 'recovered';
        ELSE
          v_state := 'high_traffic';
        END IF;
      END IF;
    ELSE
      v_state := v_account.traffic_guard_status;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'state', v_state,
    'current_60s_count', v_count_window,
    'incident_id', v_incident_id,
    'notification_emitted', v_notification_emitted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_traffic_guard_state(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_traffic_guard_state(UUID) TO service_role;


-- 5c. Safe pause account automations
CREATE OR REPLACE FUNCTION public.traffic_guard_pause_account(
  p_instagram_account_id UUID,
  p_incident_id          UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_user_id   UUID;
  v_paused_ids        UUID[] := ARRAY[]::UUID[];
  v_held_jobs_count   INTEGER := 0;
BEGIN
  -- Strict owner authentication
  SELECT user_id INTO v_account_user_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot pause automations for another user account';
  END IF;

  -- 1. Identify active automations that belong to this account
  SELECT COALESCE(pg_catalog.array_agg(id), ARRAY[]::UUID[])
  INTO v_paused_ids
  FROM public.automations
  WHERE instagram_account_id = p_instagram_account_id
    AND is_active = true;

  -- 2. Pause ONLY the active automations, recording traffic guard metadata
  IF pg_catalog.array_length(v_paused_ids, 1) > 0 THEN
    UPDATE public.automations
    SET is_active = false,
        is_traffic_guard_paused = true,
        traffic_guard_paused_at = pg_catalog.now(),
        traffic_guard_incident_id = p_incident_id,
        updated_at = pg_catalog.now()
    WHERE id = ANY(v_paused_ids);
  END IF;

  -- 3. Record paused automation IDs on the incident
  UPDATE public.comment_traffic_incidents
  SET paused_at = pg_catalog.now(),
      paused_automation_ids = v_paused_ids,
      updated_at = pg_catalog.now()
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id;

  -- 4. Mark account as paused by Traffic Guard
  UPDATE public.instagram_accounts
  SET traffic_guard_paused = true,
      traffic_guard_incident_id = p_incident_id,
      updated_at = pg_catalog.now()
  WHERE id = p_instagram_account_id;

  -- 5. Safe handling of queued jobs: hold all pending jobs for this account so they
  -- cannot continue sending unexpectedly after pause
  WITH held AS (
    UPDATE public.job_queue
    SET status = 'held',
        last_error = 'Held by Traffic Guard pause',
        updated_at = pg_catalog.now()
    WHERE status = 'pending'
      AND payload->>'instagramAccountId' = p_instagram_account_id::text
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_held_jobs_count FROM held;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'paused_automation_ids', v_paused_ids,
    'held_jobs_count', v_held_jobs_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.traffic_guard_pause_account(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.traffic_guard_pause_account(UUID, UUID) TO authenticated, service_role;


-- 5d. Safe resume account automations
CREATE OR REPLACE FUNCTION public.traffic_guard_resume_account(
  p_instagram_account_id UUID,
  p_incident_id          UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_user_id   UUID;
  v_incident          RECORD;
  v_resumed_ids       UUID[] := ARRAY[]::UUID[];
  v_resumed_jobs_cnt  INTEGER := 0;
BEGIN
  -- Strict owner authentication
  SELECT user_id INTO v_account_user_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot resume automations for another user account';
  END IF;

  SELECT * INTO v_incident
  FROM public.comment_traffic_incidents
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident not found';
  END IF;

  -- Resume ONLY automations that this feature itself paused for that incident,
  -- and that have NOT been modified/reconfigured manually since the pause
  SELECT COALESCE(pg_catalog.array_agg(id), ARRAY[]::UUID[])
  INTO v_resumed_ids
  FROM public.automations
  WHERE id = ANY(v_incident.paused_automation_ids)
    AND is_traffic_guard_paused = true
    AND traffic_guard_incident_id = p_incident_id
    AND updated_at <= v_incident.paused_at + INTERVAL '5 seconds';

  IF pg_catalog.array_length(v_resumed_ids, 1) > 0 THEN
    UPDATE public.automations
    SET is_active = true,
        is_traffic_guard_paused = false,
        traffic_guard_paused_at = NULL,
        traffic_guard_incident_id = NULL,
        updated_at = pg_catalog.now()
    WHERE id = ANY(v_resumed_ids);
  END IF;

  -- Record resumed timestamp on the incident
  UPDATE public.comment_traffic_incidents
  SET resumed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_incident_id;

  -- Reset account pause status
  UPDATE public.instagram_accounts
  SET traffic_guard_paused = false,
      traffic_guard_incident_id = NULL,
      updated_at = pg_catalog.now()
  WHERE id = p_instagram_account_id;

  -- Resume held jobs for this account back to pending
  WITH resumed AS (
    UPDATE public.job_queue
    SET status = 'pending',
        run_after = pg_catalog.now(),
        last_error = NULL,
        updated_at = pg_catalog.now()
    WHERE status = 'held'
      AND last_error = 'Held by Traffic Guard pause'
      AND payload->>'instagramAccountId' = p_instagram_account_id::text
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_resumed_jobs_cnt FROM resumed;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'resumed_automation_ids', v_resumed_ids,
    'resumed_jobs_count', v_resumed_jobs_cnt
  );
END;
$$;

REVOKE ALL ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) TO authenticated, service_role;


-- 5e. Get traffic guard status and metrics
CREATE OR REPLACE FUNCTION public.get_traffic_guard_status(
  p_instagram_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account             RECORD;
  v_current_count       INTEGER := 0;
  v_latest_incident     RECORD;
  v_paused_count        INTEGER := 0;
  v_active_count        INTEGER := 0;
  v_held_jobs_count     INTEGER := 0;
  v_settings            JSONB;
BEGIN
  SELECT id, user_id, traffic_guard_status, traffic_guard_paused, traffic_guard_incident_id, traffic_guard_settings
  INTO v_account
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('error', 'Account not found');
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account.user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot view traffic guard status for another user account';
  END IF;

  v_settings := COALESCE(
    v_account.traffic_guard_settings,
    '{"high_traffic_threshold": 20, "recovery_threshold": 5, "recovery_duration_seconds": 300, "window_seconds": 60}'::jsonb
  );

  SELECT pg_catalog.count(*)
  INTO v_current_count
  FROM public.comment_traffic_events
  WHERE instagram_account_id = p_instagram_account_id
    AND received_at >= pg_catalog.now() - INTERVAL '60 seconds';

  SELECT * INTO v_latest_incident
  FROM public.comment_traffic_incidents
  WHERE instagram_account_id = p_instagram_account_id
  ORDER BY opened_at DESC
  LIMIT 1;

  SELECT
    pg_catalog.count(*) FILTER (WHERE is_active = true),
    pg_catalog.count(*) FILTER (WHERE is_traffic_guard_paused = true)
  INTO v_active_count, v_paused_count
  FROM public.automations
  WHERE instagram_account_id = p_instagram_account_id;

  SELECT pg_catalog.count(*)
  INTO v_held_jobs_count
  FROM public.job_queue
  WHERE status = 'held'
    AND payload->>'instagramAccountId' = p_instagram_account_id::text;

  RETURN pg_catalog.jsonb_build_object(
    'account_id', p_instagram_account_id,
    'traffic_status', v_account.traffic_guard_status,
    'is_paused', v_account.traffic_guard_paused,
    'current_60s_count', v_current_count,
    'settings', v_settings,
    'active_automations_count', v_active_count,
    'paused_by_guard_count', v_paused_count,
    'held_jobs_count', v_held_jobs_count,
    'incident', CASE WHEN v_latest_incident.id IS NOT NULL THEN
      pg_catalog.jsonb_build_object(
        'id', v_latest_incident.id,
        'status', v_latest_incident.status,
        'peak_rate', v_latest_incident.peak_comments_per_minute,
        'opened_at', v_latest_incident.opened_at,
        'last_spike_at', v_latest_incident.last_spike_at,
        'recovered_at', v_latest_incident.recovered_at,
        'paused_at', v_latest_incident.paused_at,
        'paused_automation_ids', v_latest_incident.paused_automation_ids,
        'resumed_at', v_latest_incident.resumed_at
      ) ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_traffic_guard_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_traffic_guard_status(UUID) TO authenticated, service_role;



-- ── Hardening 1/3: 20261028144525_harden_traffic_guard_rpcs.sql (verbatim) ──

-- Harden Traffic Guard privileged RPCs and reject mismatched incidents before mutation.
--
-- These RPCs are invoked by authenticated application routes through the
-- service-role client. The routes enforce user/account ownership; direct
-- execution by client roles is unnecessary and expands the public API surface.

CREATE OR REPLACE FUNCTION public.traffic_guard_pause_account(
  p_instagram_account_id UUID,
  p_incident_id          UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_user_id   UUID;
  v_paused_ids        UUID[] := ARRAY[]::UUID[];
  v_held_jobs_count   INTEGER := 0;
BEGIN
  SELECT user_id INTO v_account_user_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot pause automations for another user account';
  END IF;

  -- Fail closed before changing automation or queue state. Without this guard,
  -- an invalid incident ID could still pause the account while leaving no
  -- valid incident record for the normal resume RPC to recover from.
  PERFORM 1
  FROM public.comment_traffic_incidents
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident not found for Instagram account';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(id), ARRAY[]::UUID[])
  INTO v_paused_ids
  FROM public.automations
  WHERE instagram_account_id = p_instagram_account_id
    AND is_active = true;

  IF pg_catalog.array_length(v_paused_ids, 1) > 0 THEN
    UPDATE public.automations
    SET is_active = false,
        is_traffic_guard_paused = true,
        traffic_guard_paused_at = pg_catalog.now(),
        traffic_guard_incident_id = p_incident_id,
        updated_at = pg_catalog.now()
    WHERE id = ANY(v_paused_ids);
  END IF;

  UPDATE public.comment_traffic_incidents
  SET paused_at = pg_catalog.now(),
      paused_automation_ids = v_paused_ids,
      updated_at = pg_catalog.now()
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id;

  UPDATE public.instagram_accounts
  SET traffic_guard_paused = true,
      traffic_guard_incident_id = p_incident_id,
      updated_at = pg_catalog.now()
  WHERE id = p_instagram_account_id;

  WITH held AS (
    UPDATE public.job_queue
    SET status = 'held',
        last_error = 'Held by Traffic Guard pause',
        updated_at = pg_catalog.now()
    WHERE status = 'pending'
      AND payload->>'instagramAccountId' = p_instagram_account_id::text
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_held_jobs_count FROM held;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'paused_automation_ids', v_paused_ids,
    'held_jobs_count', v_held_jobs_count
  );
END;
$$;

-- These functions are invoked by server-side routes with the service role.
-- Revoke default PUBLIC/client execution, retaining only the backend grant.
REVOKE ALL ON FUNCTION public.get_traffic_guard_status(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_traffic_guard_status(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.traffic_guard_pause_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.traffic_guard_pause_account(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) TO service_role;

-- ── Hardening 2/3: 20261101102107_harden_traffic_guard_resume.sql (verbatim) ──

-- Prevent stale or replayed Traffic Guard resume requests from unpausing an account.
--
-- A previous incident can remain visible in an open dashboard tab after the
-- account has moved on to a newer incident. Resume must only apply to the
-- currently-paused incident, and only once. The application route checks this
-- too, but the SECURITY DEFINER RPC enforces the invariant for every caller.

CREATE OR REPLACE FUNCTION public.traffic_guard_resume_account(
  p_instagram_account_id UUID,
  p_incident_id          UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_user_id       UUID;
  v_account_paused        BOOLEAN;
  v_current_incident_id   UUID;
  v_incident              RECORD;
  v_resumed_ids           UUID[] := ARRAY[]::UUID[];
  v_resumed_jobs_cnt      INTEGER := 0;
BEGIN
  SELECT user_id, traffic_guard_paused, traffic_guard_incident_id
  INTO v_account_user_id, v_account_paused, v_current_incident_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot resume automations for another user account';
  END IF;

  -- Lock and validate the incident first, matching the pause RPC lock order.
  SELECT *
  INTO v_incident
  FROM public.comment_traffic_incidents
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id
    AND paused_at IS NOT NULL
    AND resumed_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident is not an active paused incident for this account';
  END IF;

  -- Lock the account only after the incident to avoid inverting the pause
  -- RPC's incident -> account lock order. Re-read the state under the lock:
  -- a newer incident may have replaced this one since the first read.
  SELECT user_id, traffic_guard_paused, traffic_guard_incident_id
  INTO v_account_user_id, v_account_paused, v_current_incident_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot resume automations for another user account';
  END IF;

  IF v_account_paused IS DISTINCT FROM true
     OR v_current_incident_id IS DISTINCT FROM p_incident_id THEN
    RAISE EXCEPTION 'Incident is no longer the active paused incident for this account';
  END IF;

  -- Resume ONLY automations this incident paused, and do not overwrite
  -- automations that an owner manually edited/reconfigured since the pause.
  SELECT COALESCE(pg_catalog.array_agg(id), ARRAY[]::UUID[])
  INTO v_resumed_ids
  FROM public.automations
  WHERE id = ANY(v_incident.paused_automation_ids)
    AND is_traffic_guard_paused = true
    AND traffic_guard_incident_id = p_incident_id
    AND updated_at <= v_incident.paused_at + INTERVAL '5 seconds';

  IF pg_catalog.array_length(v_resumed_ids, 1) > 0 THEN
    UPDATE public.automations
    SET is_active = true,
        is_traffic_guard_paused = false,
        traffic_guard_paused_at = NULL,
        traffic_guard_incident_id = NULL,
        updated_at = pg_catalog.now()
    WHERE id = ANY(v_resumed_ids);
  END IF;

  UPDATE public.comment_traffic_incidents
  SET resumed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id;

  UPDATE public.instagram_accounts
  SET traffic_guard_paused = false,
      traffic_guard_incident_id = NULL,
      updated_at = pg_catalog.now()
  WHERE id = p_instagram_account_id;

  -- Only jobs explicitly held by this guard are released.
  WITH resumed AS (
    UPDATE public.job_queue
    SET status = 'pending',
        run_after = pg_catalog.now(),
        last_error = NULL,
        updated_at = pg_catalog.now()
    WHERE status = 'held'
      AND last_error = 'Held by Traffic Guard pause'
      AND payload->>'instagramAccountId' = p_instagram_account_id::text
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_resumed_jobs_cnt FROM resumed;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'resumed_automation_ids', v_resumed_ids,
    'resumed_jobs_count', v_resumed_jobs_cnt
  );
END;
$$;

REVOKE ALL ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) TO service_role;

-- ── Hardening 3/3: 20261101102552_separate_traffic_guard_pause_incident.sql (verbatim) ──

-- Track the incident that owns an account pause separately from the latest
-- traffic incident. New spikes can arrive while automations remain paused;
-- those spikes must not steal the resume token from the incident that paused
-- the automations and held their jobs.

ALTER TABLE public.instagram_accounts
  ADD COLUMN IF NOT EXISTS traffic_guard_paused_incident_id UUID
  REFERENCES public.comment_traffic_incidents(id) ON DELETE SET NULL;

-- Backfill only unambiguous legacy pauses where the account's current incident
-- is itself an active paused incident. Do not guess when the pointer has moved.
UPDATE public.instagram_accounts AS a
SET traffic_guard_paused_incident_id = a.traffic_guard_incident_id
WHERE a.traffic_guard_paused = true
  AND a.traffic_guard_paused_incident_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.comment_traffic_incidents AS i
    WHERE i.id = a.traffic_guard_incident_id
      AND i.instagram_account_id = a.id
      AND i.paused_at IS NOT NULL
      AND i.resumed_at IS NULL
  );

CREATE OR REPLACE FUNCTION public.traffic_guard_pause_account(
  p_instagram_account_id UUID,
  p_incident_id          UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_user_id       UUID;
  v_account_paused        BOOLEAN;
  v_current_incident_id   UUID;
  v_paused_ids            UUID[] := ARRAY[]::UUID[];
  v_held_jobs_count       INTEGER := 0;
BEGIN
  SELECT user_id, traffic_guard_paused, traffic_guard_incident_id
  INTO v_account_user_id, v_account_paused, v_current_incident_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot pause automations for another user account';
  END IF;

  IF v_account_paused IS TRUE THEN
    RAISE EXCEPTION 'Account is already paused by Traffic Guard';
  END IF;

  -- Lock the incident first; resume uses the same incident -> account order.
  PERFORM 1
  FROM public.comment_traffic_incidents
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id
    AND paused_at IS NULL
    AND resumed_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident is not the current resumable traffic incident for this account';
  END IF;

  -- Re-read account state under lock so a newer incident cannot race this pause.
  SELECT user_id, traffic_guard_paused, traffic_guard_incident_id
  INTO v_account_user_id, v_account_paused, v_current_incident_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot pause automations for another user account';
  END IF;

  IF v_account_paused IS TRUE THEN
    RAISE EXCEPTION 'Account is already paused by Traffic Guard';
  END IF;

  IF v_current_incident_id IS DISTINCT FROM p_incident_id THEN
    RAISE EXCEPTION 'Incident is no longer the current traffic incident for this account';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(id), ARRAY[]::UUID[])
  INTO v_paused_ids
  FROM public.automations
  WHERE instagram_account_id = p_instagram_account_id
    AND is_active = true;

  IF pg_catalog.array_length(v_paused_ids, 1) > 0 THEN
    UPDATE public.automations
    SET is_active = false,
        is_traffic_guard_paused = true,
        traffic_guard_paused_at = pg_catalog.now(),
        traffic_guard_incident_id = p_incident_id,
        updated_at = pg_catalog.now()
    WHERE id = ANY(v_paused_ids);
  END IF;

  UPDATE public.comment_traffic_incidents
  SET paused_at = pg_catalog.now(),
      paused_automation_ids = v_paused_ids,
      updated_at = pg_catalog.now()
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id;

  UPDATE public.instagram_accounts
  SET traffic_guard_paused = true,
      traffic_guard_paused_incident_id = p_incident_id,
      updated_at = pg_catalog.now()
  WHERE id = p_instagram_account_id;

  WITH held AS (
    UPDATE public.job_queue
    SET status = 'held',
        last_error = 'Held by Traffic Guard pause',
        updated_at = pg_catalog.now()
    WHERE status = 'pending'
      AND payload->>'instagramAccountId' = p_instagram_account_id::text
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_held_jobs_count FROM held;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'paused_automation_ids', v_paused_ids,
    'held_jobs_count', v_held_jobs_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.traffic_guard_resume_account(
  p_instagram_account_id UUID,
  p_incident_id          UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_user_id       UUID;
  v_account_paused        BOOLEAN;
  v_paused_incident_id    UUID;
  v_incident              RECORD;
  v_resumed_ids           UUID[] := ARRAY[]::UUID[];
  v_resumed_jobs_cnt      INTEGER := 0;
BEGIN
  SELECT user_id, traffic_guard_paused, traffic_guard_paused_incident_id
  INTO v_account_user_id, v_account_paused, v_paused_incident_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot resume automations for another user account';
  END IF;

  -- The pause-origin incident may no longer be the latest traffic incident.
  -- It must still be the one recorded as owning this account's active pause.
  SELECT *
  INTO v_incident
  FROM public.comment_traffic_incidents
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id
    AND paused_at IS NOT NULL
    AND resumed_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident is not an active paused incident for this account';
  END IF;

  -- Re-read the pause identity under an account row lock. This prevents a
  -- stale or concurrent resume from releasing another incident's held jobs.
  SELECT user_id, traffic_guard_paused, traffic_guard_paused_incident_id
  INTO v_account_user_id, v_account_paused, v_paused_incident_id
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account not found';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account_user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot resume automations for another user account';
  END IF;

  IF v_account_paused IS DISTINCT FROM true
     OR v_paused_incident_id IS DISTINCT FROM p_incident_id THEN
    RAISE EXCEPTION 'Incident is no longer the active paused incident for this account';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(id), ARRAY[]::UUID[])
  INTO v_resumed_ids
  FROM public.automations
  WHERE id = ANY(v_incident.paused_automation_ids)
    AND is_traffic_guard_paused = true
    AND traffic_guard_incident_id = p_incident_id
    AND updated_at <= v_incident.paused_at + INTERVAL '5 seconds';

  IF pg_catalog.array_length(v_resumed_ids, 1) > 0 THEN
    UPDATE public.automations
    SET is_active = true,
        is_traffic_guard_paused = false,
        traffic_guard_paused_at = NULL,
        traffic_guard_incident_id = NULL,
        updated_at = pg_catalog.now()
    WHERE id = ANY(v_resumed_ids);
  END IF;

  UPDATE public.comment_traffic_incidents
  SET resumed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_incident_id
    AND instagram_account_id = p_instagram_account_id;

  -- Keep traffic_guard_incident_id pointing at the latest traffic incident.
  -- Only clear the separate pause-origin incident reference.
  UPDATE public.instagram_accounts
  SET traffic_guard_paused = false,
      traffic_guard_paused_incident_id = NULL,
      updated_at = pg_catalog.now()
  WHERE id = p_instagram_account_id;

  WITH resumed AS (
    UPDATE public.job_queue
    SET status = 'pending',
        run_after = pg_catalog.now(),
        last_error = NULL,
        updated_at = pg_catalog.now()
    WHERE status = 'held'
      AND last_error = 'Held by Traffic Guard pause'
      AND payload->>'instagramAccountId' = p_instagram_account_id::text
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_resumed_jobs_cnt FROM resumed;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'resumed_automation_ids', v_resumed_ids,
    'resumed_jobs_count', v_resumed_jobs_cnt
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_traffic_guard_status(
  p_instagram_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account             RECORD;
  v_current_count       INTEGER := 0;
  v_latest_incident     RECORD;
  v_paused_count        INTEGER := 0;
  v_active_count        INTEGER := 0;
  v_held_jobs_count     INTEGER := 0;
  v_settings            JSONB;
BEGIN
  SELECT id, user_id, traffic_guard_status, traffic_guard_paused,
         traffic_guard_incident_id, traffic_guard_paused_incident_id,
         traffic_guard_settings
  INTO v_account
  FROM public.instagram_accounts
  WHERE id = p_instagram_account_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('error', 'Account not found');
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_account.user_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot view traffic guard status for another user account';
  END IF;

  v_settings := COALESCE(
    v_account.traffic_guard_settings,
    '{"high_traffic_threshold": 20, "recovery_threshold": 5, "recovery_duration_seconds": 300, "window_seconds": 60}'::jsonb
  );

  SELECT pg_catalog.count(*)
  INTO v_current_count
  FROM public.comment_traffic_events
  WHERE instagram_account_id = p_instagram_account_id
    AND received_at >= pg_catalog.now() - INTERVAL '60 seconds';

  SELECT * INTO v_latest_incident
  FROM public.comment_traffic_incidents
  WHERE instagram_account_id = p_instagram_account_id
  ORDER BY opened_at DESC
  LIMIT 1;

  SELECT
    pg_catalog.count(*) FILTER (WHERE is_active = true),
    pg_catalog.count(*) FILTER (WHERE is_traffic_guard_paused = true)
  INTO v_active_count, v_paused_count
  FROM public.automations
  WHERE instagram_account_id = p_instagram_account_id;

  SELECT pg_catalog.count(*)
  INTO v_held_jobs_count
  FROM public.job_queue
  WHERE status = 'held'
    AND payload->>'instagramAccountId' = p_instagram_account_id::text;

  RETURN pg_catalog.jsonb_build_object(
    'account_id', p_instagram_account_id,
    'traffic_status', v_account.traffic_guard_status,
    'is_paused', v_account.traffic_guard_paused,
    'paused_incident_id', v_account.traffic_guard_paused_incident_id,
    'current_60s_count', v_current_count,
    'settings', v_settings,
    'active_automations_count', v_active_count,
    'paused_by_guard_count', v_paused_count,
    'held_jobs_count', v_held_jobs_count,
    'incident', CASE WHEN v_latest_incident.id IS NOT NULL THEN
      pg_catalog.jsonb_build_object(
        'id', v_latest_incident.id,
        'status', v_latest_incident.status,
        'peak_rate', v_latest_incident.peak_comments_per_minute,
        'opened_at', v_latest_incident.opened_at,
        'last_spike_at', v_latest_incident.last_spike_at,
        'recovered_at', v_latest_incident.recovered_at,
        'paused_at', v_latest_incident.paused_at,
        'paused_automation_ids', v_latest_incident.paused_automation_ids,
        'resumed_at', v_latest_incident.resumed_at
      ) ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.traffic_guard_pause_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.traffic_guard_pause_account(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.traffic_guard_resume_account(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.get_traffic_guard_status(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_traffic_guard_status(UUID) TO service_role;

-- ── Cleanup integration (ADAPTED, not copied from release-prep) ─────────────
-- Release-prep's 000006 replaced cleanup_old_rows() with a version that DROPS
-- the candidate's automation_sessions pruning. This version preserves the
-- candidate's existing body (20260729000003) verbatim and only ADDS pruning
-- of the rolling traffic-event window (events are useless after 1 hour).
CREATE OR REPLACE FUNCTION public.cleanup_old_rows()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.debug_events WHERE created_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.job_queue WHERE status IN ('done', 'failed') AND updated_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.dm_rate_events WHERE sent_at < NOW() - INTERVAL '2 hours';
  DELETE FROM public.automation_sessions WHERE completed = TRUE AND last_activity_at < NOW() - INTERVAL '30 days';
  DELETE FROM public.comment_traffic_events WHERE received_at < NOW() - INTERVAL '1 hour';
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_rows() TO service_role;
