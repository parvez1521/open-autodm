-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 — Comment reply reservations (parity row 13), adapted from
-- release-prep by individual review. Owner decision (Phase 6): preserve
-- release-prep's pre-send reservation behaviour.
--
-- Contents:
--   §A  comment_private_reply_reservations + its 4 RPCs — VERBATIM from
--       release-prep 20260731000004_comment_private_reply_reservation.sql.
--   §B  comment_public_reply_reservations + its 4 RPCs — the reservation
--       portion ONLY of release-prep 20260731000005_public_replies_and_ai.sql.
--       That file's other contents are deliberately NOT ported here: its
--       non-AI automation columns were already ported by the candidate's
--       20260730000005_public_reply_gate.sql (Phase 5), and its AI columns
--       / ai_usage_log remain subject to the separate AI decision.
--
-- Table/RPC names and semantics are IDENTICAL to production (which already
-- has them from the release-prep migrations); this file exists for
-- fresh-install parity and is idempotent-safe where release-prep's was.
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── §A: Private reply reservations (release-prep …000004, verbatim) ─────────

-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM - Comment Private Reply Reservation & Global Concurrency Guard
--
-- Guarantees the Meta invariant: AT MOST ONE private reply per comment
-- across ALL automations on the same Instagram account.
--
-- Prevents TOCTOU race conditions where multiple matching automations or
-- concurrent worker sessions simultaneously attempt to private-reply to the
-- same comment.
--
-- SECURITY HARDENED:
-- 1. All RPC functions run with an explicit empty search_path (SET search_path = '')
--    with all tables, views, and built-ins explicitly schema-qualified.
-- 2. Direct table and function execution privileges are revoked from PUBLIC, anon,
--    and authenticated, and granted strictly to service_role (and SELECT to authenticated
--    under RLS).
-- 3. Cross-entity account verification prevents passing mismatched automation IDs.
-- 4. Fail-closed: Stale in-flight reservations transition to failed and never
--    authorize a duplicate send.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.comment_private_reply_reservations (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  comment_id            TEXT        NOT NULL,
  automation_id         UUID        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  status                TEXT        NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'sent', 'failed')),
  reserved_at           TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  sent_at               TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  failure_reason        TEXT,
  CONSTRAINT uq_comment_reservation UNIQUE (instagram_account_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_reservations_acc_status 
  ON public.comment_private_reply_reservations(instagram_account_id, status);

ALTER TABLE public.comment_private_reply_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own comment reservations" ON public.comment_private_reply_reservations;
CREATE POLICY "Users can view own comment reservations"
  ON public.comment_private_reply_reservations FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = comment_private_reply_reservations.automation_id AND a.user_id = auth.uid()));

REVOKE ALL ON TABLE public.comment_private_reply_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.comment_private_reply_reservations TO authenticated;
GRANT ALL ON TABLE public.comment_private_reply_reservations TO service_role;

-- ── 1: Atomic Reservation RPC ────────────────────────────────────────────────
-- Returns JSONB { authorized: boolean, status: string, reason: string }
CREATE OR REPLACE FUNCTION public.reserve_comment_private_reply(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_automation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_res RECORD;
  v_stale_interval INTERVAL := INTERVAL '10 minutes';
BEGIN
  -- Strict cross-entity validation: automation must belong to the specified instagram account
  IF NOT EXISTS (
    SELECT 1 FROM public.automations
    WHERE id = p_automation_id AND instagram_account_id = p_instagram_account_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'authorized', false,
      'status', 'error',
      'reason', 'invalid_automation_account_pair'
    );
  END IF;

  -- Attempt initial insert
  INSERT INTO public.comment_private_reply_reservations (
    instagram_account_id,
    comment_id,
    automation_id,
    status,
    reserved_at
  )
  VALUES (
    p_instagram_account_id,
    p_comment_id,
    p_automation_id,
    'reserved',
    pg_catalog.now()
  )
  ON CONFLICT (instagram_account_id, comment_id) DO NOTHING
  RETURNING * INTO v_res;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('authorized', true, 'status', 'reserved', 'reason', 'new_reservation');
  END IF;

  -- Conflict occurred: inspect existing reservation
  SELECT * INTO v_res
  FROM public.comment_private_reply_reservations
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id;

  -- Case 1: Already sent by any automation
  IF v_res.status = 'sent' THEN
    RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', 'sent', 'reason', 'already_sent');
  END IF;

  -- Case 2: Permanent failure recorded
  IF v_res.status = 'failed' THEN
    RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', 'failed', 'reason', 'previously_failed');
  END IF;

  -- Case 3: In-flight reservation that went stale (> 10 mins without confirm)
  -- FAIL CLOSED: Under Meta policy, an unconfirmed in-flight reservation may have delivered
  -- the DM before the worker crashed/timed out. Blindly re-authorizing a second send is unsafe.
  -- Transition stale reservation to 'failed' (stale_unconfirmed_abandoned) and return authorized: false.
  IF v_res.status = 'reserved' AND v_res.reserved_at < (pg_catalog.now() - v_stale_interval) THEN
    UPDATE public.comment_private_reply_reservations
    SET status = 'failed',
        failed_at = pg_catalog.now(),
        failure_reason = 'stale_unconfirmed_abandoned'
    WHERE id = v_res.id AND status = 'reserved';

    RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', 'failed', 'reason', 'stale_unconfirmed_abandoned');
  END IF;

  -- Case 4: In-flight reservation still active (< 10 mins)
  RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', v_res.status, 'reason', 'reserved_by_other_or_active');
END;
$$;

-- ── 2: Confirm Send RPC ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_comment_private_reply_sent(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_automation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.comment_private_reply_reservations
  SET status = 'sent', sent_at = pg_catalog.now()
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id
    AND automation_id = p_automation_id
    AND status = 'reserved';
END;
$$;

-- ── 3: Release Reservation RPC (for pre-send delays / rate-limits) ────────────
CREATE OR REPLACE FUNCTION public.release_comment_private_reply(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_automation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.comment_private_reply_reservations
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id
    AND automation_id = p_automation_id
    AND status = 'reserved';
END;
$$;

-- ── 4: Mark Failed RPC (permanent error) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_comment_private_reply_failed(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_automation_id UUID,
  p_failure_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.comment_private_reply_reservations
  SET status = 'failed', failed_at = pg_catalog.now(), failure_reason = p_failure_reason
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id
    AND automation_id = p_automation_id
    AND status = 'reserved';
END;
$$;

-- ── 5: Strict RPC Execution Privileges ───────────────────────────────────────
REVOKE ALL ON FUNCTION public.reserve_comment_private_reply(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_comment_private_reply(UUID, TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_comment_private_reply_sent(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_comment_private_reply_sent(UUID, TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.release_comment_private_reply(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_comment_private_reply(UUID, TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.mark_comment_private_reply_failed(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_comment_private_reply_failed(UUID, TEXT, UUID, TEXT) TO service_role;

-- ── §B: Public reply reservations (release-prep …000005 §2–§6, verbatim) ──

-- ── 2: Comment Public Reply Reservations Table ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.comment_public_reply_reservations (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  comment_id            TEXT        NOT NULL,
  automation_id         UUID        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  status                TEXT        NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'sent', 'failed')),
  reply_comment_id      TEXT,
  reserved_at           TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  sent_at               TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  failure_reason        TEXT,
  CONSTRAINT uq_comment_public_reply UNIQUE (instagram_account_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_pub_reservations_acc_status 
  ON public.comment_public_reply_reservations(instagram_account_id, status);

ALTER TABLE public.comment_public_reply_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own comment public reservations" ON public.comment_public_reply_reservations;
CREATE POLICY "Users can view own comment public reservations"
  ON public.comment_public_reply_reservations FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = comment_public_reply_reservations.automation_id AND a.user_id = auth.uid()));

REVOKE ALL ON TABLE public.comment_public_reply_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.comment_public_reply_reservations TO authenticated;
GRANT ALL ON TABLE public.comment_public_reply_reservations TO service_role;

-- ── 3: Atomic Public Reply Reservation RPC ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.reserve_comment_public_reply(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_automation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_res RECORD;
  v_stale_interval INTERVAL := INTERVAL '10 minutes';
BEGIN
  -- Strict cross-entity validation: automation must belong to the specified instagram account
  IF NOT EXISTS (
    SELECT 1 FROM public.automations
    WHERE id = p_automation_id AND instagram_account_id = p_instagram_account_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'authorized', false,
      'status', 'error',
      'reason', 'invalid_automation_account_pair'
    );
  END IF;

  -- Attempt initial insert
  INSERT INTO public.comment_public_reply_reservations (
    instagram_account_id,
    comment_id,
    automation_id,
    status,
    reserved_at
  )
  VALUES (
    p_instagram_account_id,
    p_comment_id,
    p_automation_id,
    'reserved',
    pg_catalog.now()
  )
  ON CONFLICT (instagram_account_id, comment_id) DO NOTHING
  RETURNING * INTO v_res;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('authorized', true, 'status', 'reserved', 'reason', 'new_reservation');
  END IF;

  -- Conflict occurred: inspect existing reservation
  SELECT * INTO v_res
  FROM public.comment_public_reply_reservations
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id;

  -- Case 1: Already sent
  IF v_res.status = 'sent' THEN
    RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', 'sent', 'reason', 'already_sent');
  END IF;

  -- Case 2: Permanent failure recorded
  IF v_res.status = 'failed' THEN
    RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', 'failed', 'reason', 'previously_failed');
  END IF;

  -- Case 3: In-flight reservation that went stale (> 10 mins without confirm)
  -- Transition stale reservation to 'failed' and fail closed.
  IF v_res.status = 'reserved' AND v_res.reserved_at < (pg_catalog.now() - v_stale_interval) THEN
    UPDATE public.comment_public_reply_reservations
    SET status = 'failed',
        failed_at = pg_catalog.now(),
        failure_reason = 'stale_unconfirmed_abandoned'
    WHERE instagram_account_id = p_instagram_account_id
      AND comment_id = p_comment_id
      AND status = 'reserved';

    RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', 'failed', 'reason', 'stale_unconfirmed_abandoned');
  END IF;

  -- Case 4: In-flight active reservation held by another worker
  RETURN pg_catalog.jsonb_build_object('authorized', false, 'status', 'reserved', 'reason', 'in_flight');
END;
$$;

-- ── 4: Confirm Public Reply Sent RPC ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.confirm_comment_public_reply_sent(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_reply_comment_id TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.comment_public_reply_reservations
  SET status = 'sent',
      sent_at = pg_catalog.now(),
      reply_comment_id = p_reply_comment_id
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id
    AND status = 'reserved';
END;
$$;

-- ── 5: Release Public Reply Reservation RPC ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.release_comment_public_reply(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_automation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.comment_public_reply_reservations
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id
    AND automation_id = p_automation_id
    AND status = 'reserved';
END;
$$;

-- ── 6: Mark Public Reply Failed RPC ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_comment_public_reply_failed(
  p_instagram_account_id UUID,
  p_comment_id TEXT,
  p_failure_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.comment_public_reply_reservations
  SET status = 'failed',
      failed_at = pg_catalog.now(),
      failure_reason = p_failure_reason
  WHERE instagram_account_id = p_instagram_account_id
    AND comment_id = p_comment_id;
END;
$$;

-- Revoke execute from public/anon/authenticated and grant strictly to service_role
REVOKE ALL ON FUNCTION public.reserve_comment_public_reply(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_comment_public_reply(UUID, TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_comment_public_reply_sent(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_comment_public_reply_sent(UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.release_comment_public_reply(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_comment_public_reply(UUID, TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.mark_comment_public_reply_failed(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_comment_public_reply_failed(UUID, TEXT, TEXT) TO service_role;
