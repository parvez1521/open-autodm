-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 10.4 Workstream C — S-07: inbound webhook rate limiting store.
--
-- Backs src/lib/automation/inboundRateLimit.ts. One row per DISTINCT
-- verified webhook event, keyed on the payload's entry id (the IG account
-- IGSID taken from the HMAC-verified body — never an IP or client header).
-- The UNIQUE (ig_account_id, event_key) constraint is the duplicate
-- detector: a Meta retry of an already-seen event is classified, never
-- re-counted. Rows with decision='admitted' inside the rolling window are
-- the rate-limit count; decision='shed' rows exist so an excess event is
-- RECORDED (observable, idempotent on retry) instead of silently dropped.
--
-- ig_account_id is TEXT with NO foreign key on purpose: admission runs
-- BEFORE the instagram_accounts lookup (and must also bound work for
-- entries that resolve to no connected account), so it keys on the
-- verified payload identity exactly as delivered.
--
-- FILE ONLY — never applied by the readiness work. NOT part of the
-- approved deploy apply-list (000002 + 000003 + 000021): applying this
-- migration requires its OWN explicit owner approval. Until it is
-- applied, the check_and_record_inbound_event RPC is absent and the
-- TypeScript limiter fails OPEN (verified ingestion proceeds exactly as
-- before this change; the job_queue dedupe + outbound DM limiter still
-- protect the account).
--
-- Idempotent by construction (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP-free grants), so a re-run is safe — verified in the Phase 10.4
-- local rehearsal.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.inbound_webhook_events (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ig_account_id TEXT        NOT NULL,
  event_key     TEXT        NOT NULL,
  decision      TEXT        NOT NULL CHECK (decision IN ('admitted', 'shed')),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inbound_webhook_events_account_event UNIQUE (ig_account_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_window
  ON public.inbound_webhook_events (ig_account_id, received_at DESC);

-- Service-role only (the app's data path; mirrors dm_rate_events).
ALTER TABLE public.inbound_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inbound_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inbound_webhook_events TO service_role;

-- ── RPC: atomic duplicate-check + sliding-window admission ─────────────────
-- Single transaction with a per-account advisory lock (the same pattern as
-- check_and_record_dm_rate_limit), so concurrent serverless invocations
-- can neither double-admit one event nor overshoot the window limit.
--
-- Returns:
--   decision     'admitted'  — first sight of this event, inside the limit;
--                              the caller may process it.
--                'duplicate' — this event was already admitted before
--                              (Meta retry); the caller must NOT process it
--                              again and it consumed NO additional quota.
--                'shed'      — first sight of this event but the account is
--                              at its window limit (or a retry of an event
--                              previously shed); recorded, not processed.
--   window_count admitted events for the account inside the window AFTER
--                this call (for a 'shed'/'duplicate' result: unchanged).
CREATE OR REPLACE FUNCTION public.check_and_record_inbound_event(
  p_ig_account_id  TEXT,
  p_event_key      TEXT,
  p_limit          INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE (decision TEXT, window_count INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing TEXT;
  v_count    INTEGER;
BEGIN
  -- Serialize concurrent checks for the same account within this transaction
  PERFORM pg_advisory_xact_lock(hashtext(p_ig_account_id));

  -- Opportunistic cleanup of expired window entries for this account
  DELETE FROM public.inbound_webhook_events
  WHERE ig_account_id = p_ig_account_id
    AND received_at < NOW() - make_interval(secs => p_window_seconds);

  SELECT e.decision INTO v_existing
  FROM public.inbound_webhook_events e
  WHERE e.ig_account_id = p_ig_account_id AND e.event_key = p_event_key;

  SELECT COUNT(*) INTO v_count
  FROM public.inbound_webhook_events e
  WHERE e.ig_account_id = p_ig_account_id
    AND e.decision = 'admitted'
    AND e.received_at > NOW() - make_interval(secs => p_window_seconds);

  IF v_existing IS NOT NULL THEN
    -- A retry never consumes quota and never changes its classification:
    -- admitted -> duplicate (cheap ack), shed -> shed (idempotent shed).
    RETURN QUERY SELECT
      CASE WHEN v_existing = 'admitted' THEN 'duplicate' ELSE 'shed' END::TEXT,
      v_count;
    RETURN;
  END IF;

  IF v_count >= p_limit THEN
    INSERT INTO public.inbound_webhook_events (ig_account_id, event_key, decision)
    VALUES (p_ig_account_id, p_event_key, 'shed');
    RETURN QUERY SELECT 'shed'::TEXT, v_count;
    RETURN;
  END IF;

  INSERT INTO public.inbound_webhook_events (ig_account_id, event_key, decision)
  VALUES (p_ig_account_id, p_event_key, 'admitted');
  RETURN QUERY SELECT 'admitted'::TEXT, v_count + 1;
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_record_inbound_event(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_record_inbound_event(TEXT, TEXT, INTEGER, INTEGER) TO service_role;

-- ── Cleanup integration ────────────────────────────────────────────────────
-- Preserves the current cleanup_old_rows() body (20260730000007, itself the
-- 20260729000003 body + comment_traffic_events pruning) verbatim and only
-- ADDS pruning of inbound_webhook_events. Retention is 2 hours: the
-- admission window is 1 hour, so dedupe memory outlives the window (a
-- retry arriving just after window expiry is still recognised while its
-- row survives; after pruning it would be treated as a new event, which
-- the downstream job_queue dedupe_key UNIQUE still catches for 7 days).
CREATE OR REPLACE FUNCTION public.cleanup_old_rows()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.debug_events WHERE created_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.job_queue WHERE status IN ('done', 'failed') AND updated_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.dm_rate_events WHERE sent_at < NOW() - INTERVAL '2 hours';
  DELETE FROM public.automation_sessions WHERE completed = TRUE AND last_activity_at < NOW() - INTERVAL '30 days';
  DELETE FROM public.comment_traffic_events WHERE received_at < NOW() - INTERVAL '1 hour';
  DELETE FROM public.inbound_webhook_events WHERE received_at < NOW() - INTERVAL '2 hours';
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_rows() TO service_role;
