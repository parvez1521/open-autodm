-- pg_net is non-relocatable. Recreate it in the extensions schema to clear
-- Supabase's extension_in_public warning while preserving the net.* API.
--
-- Safety prerequisites for environments applying this migration:
-- 1. Disable all active pg_cron jobs that call net.http_*.
-- 2. Wait for those runs to finish and ensure net.http_request_queue is empty.
-- 3. After applying, verify net.http_post and then re-enable the saved jobs.
-- This migration deliberately aborts if those prerequisites are not met.

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'pg_cron must be enabled before moving pg_net';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM cron.job
    WHERE active = true
      AND command ILIKE '%net.http_%'
  ) THEN
    RAISE EXCEPTION
      'Pause active pg_cron jobs that call net.http_* before moving pg_net';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM cron.job_run_details d
    JOIN cron.job j USING (jobid)
    WHERE j.command ILIKE '%net.http_%'
      AND d.status = 'running'
  ) THEN
    RAISE EXCEPTION
      'Wait for in-flight pg_cron jobs calling net.http_* to finish before moving pg_net';
  END IF;

  IF to_regclass('net.http_request_queue') IS NOT NULL
     AND EXISTS (SELECT 1 FROM net.http_request_queue) THEN
    RAISE EXCEPTION
      'Drain net.http_request_queue before moving pg_net';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS extensions;
DROP EXTENSION pg_net;
CREATE EXTENSION pg_net WITH SCHEMA extensions;
