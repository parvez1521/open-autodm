-- ═══════════════════════════════════════════════════════════════════════════
-- Phase C / Programme 16 (productization COPY ONLY) — Tenant data
-- isolation for the pre-tenancy core tables: nullable workspace_id +
-- backfill from the owning Instagram account, composite tenant-integrity
-- foreign keys, and membership-based RLS in a DUAL-POLICY TRANSITION
-- WINDOW (Phase 11 §B.8).
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. That list is UNCHANGED:
-- 000021 required; 000002/000003 conditional; 000022/000023
-- candidate-only; …000024–…000031 are copy-only artifacts.
-- This file (…000032) is likewise NOT on the frozen apply-list and must
-- never be applied to production under the release gates. ***
--
-- TRANSITIONAL SEMANTICS (deliberate, Phase 11 dual-policy window):
--   * workspace_id stays NULLABLE everywhere in this file. The NOT NULL
--     tightening and the DROP of the legacy user_id policy arms are
--     later, separately-gated steps — NOT done here.
--   * RLS predicate per user-facing table is:
--       membership arm:  public.is_workspace_member(workspace_id)
--                        (writes: has_workspace_role owner/admin/member —
--                        viewers are read-only)
--       legacy arm:      workspace_id IS NULL AND <the table's previous
--                        user-ownership predicate, verbatim in spirit>
--     A row is visible/writable when EITHER arm holds, so pre-tenancy
--     data keeps working for its owner while bound rows are governed by
--     workspace membership (membership removal revokes access at once).
--   * Composite FKs use MATCH SIMPLE (the PostgreSQL default): when
--     workspace_id is NULL the check is skipped, so unbound legacy rows
--     are not blocked. Once workspace_id is set, the referenced parent
--     MUST live in the same workspace — a row in workspace A can never
--     reference workspace B's account/automation/session.
--   * UNIQUE (workspace_id, id) targets carry the same caveat: UNIQUE
--     treats NULLs as distinct, so multiple NULL-workspace rows may
--     share the index — that is the intended transitional behaviour.
--   * Backfill NEVER guesses: a row is stamped only when its owning
--     instagram_accounts row is already bound to a workspace
--     (…000026). Unbound rows stay NULL.
--   * debug_events / job_queue / inbound_webhook_events / dm_rate_events
--     stay SERVICE-ROLE ONLY (no authenticated policies, unchanged).
--     Their workspace_id is for server-side scoping/audit: writers
--     resolve the workspace from the account BEFORE touching tenant
--     data (see saas/PHASE_16_TENANT_ISOLATION_MATRIX.md). debug_events
--     and job_queue have no account column to backfill from, so their
--     existing rows stay NULL by design.
--   * EXCLUDED as platform-level (no workspace_id): app_settings
--     (deployment singleton), profiles (identity), data_deletion_requests
--     (Meta compliance audit keyed by meta_user_id; its account link is
--     ON DELETE SET NULL by design so the record survives deletion).
--     The SaaS tables of …000024–…000029 already carry workspace_id.
--
-- Idempotency: ADD COLUMN / CREATE INDEX use IF NOT EXISTS; every
-- constraint addition is guarded by a pg_constraint existence check;
-- policies are DROP IF EXISTS + CREATE. Safe on empty tables and safe
-- to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A. workspace_id columns + workspace-leading indexes ────────────────────
-- FK: REFERENCES public.workspaces(id) ON DELETE CASCADE — tenant data
-- dies with its workspace (mirrors the SaaS tables of …000024–…000029).
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_automations_workspace
  ON public.automations (workspace_id);

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_contacts_workspace
  ON public.contacts (workspace_id);

ALTER TABLE public.dm_jobs
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dm_jobs_workspace
  ON public.dm_jobs (workspace_id);

ALTER TABLE public.dm_sent_log
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dm_sent_log_workspace
  ON public.dm_sent_log (workspace_id);

ALTER TABLE public.automation_sessions
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_automation_sessions_workspace
  ON public.automation_sessions (workspace_id);

-- dm_logs owns no account/automation column: it inherits tenancy from
-- its parent automation_sessions row (backfill + composite FK below).
ALTER TABLE public.dm_logs
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dm_logs_workspace
  ON public.dm_logs (workspace_id);

ALTER TABLE public.recipient_opt_outs
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_recipient_opt_outs_workspace
  ON public.recipient_opt_outs (workspace_id);

-- ai_usage_log: the workspace index doubles as the §E reporting index
-- (workspace_id, created_at DESC). The pre-existing per-user index
-- idx_ai_usage_user_date is KEPT (transition).
ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_ai_usage_workspace_date
  ON public.ai_usage_log (workspace_id, created_at DESC);

-- Service-role-only tables: column exists for server-side scoping/audit.
ALTER TABLE public.debug_events
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_debug_events_workspace
  ON public.debug_events (workspace_id);

ALTER TABLE public.job_queue
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_job_queue_workspace
  ON public.job_queue (workspace_id);

ALTER TABLE public.inbound_webhook_events
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_workspace
  ON public.inbound_webhook_events (workspace_id);

ALTER TABLE public.dm_rate_events
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_dm_rate_events_workspace
  ON public.dm_rate_events (workspace_id);

-- Traffic-guard tables (…000007): tenant-owned via the guarded account.
ALTER TABLE public.comment_traffic_events
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_comment_traffic_events_workspace
  ON public.comment_traffic_events (workspace_id);

ALTER TABLE public.comment_traffic_incidents
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_traffic_incidents_workspace
  ON public.comment_traffic_incidents (workspace_id);

ALTER TABLE public.traffic_guard_notifications
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_traffic_notif_workspace
  ON public.traffic_guard_notifications (workspace_id);

-- Follow-ups (…000008).
ALTER TABLE public.automation_follow_ups
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_follow_ups_workspace
  ON public.automation_follow_ups (workspace_id);

-- Comment-reply reservations (…000020).
ALTER TABLE public.comment_private_reply_reservations
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_comment_reservations_workspace
  ON public.comment_private_reply_reservations (workspace_id);

ALTER TABLE public.comment_public_reply_reservations
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_comment_pub_reservations_workspace
  ON public.comment_public_reply_reservations (workspace_id);

-- ── B. Backfill from the owning account's binding (idempotent) ─────────────
-- Each UPDATE touches only rows whose workspace_id IS NULL and whose
-- owning account is already bound. Unbound rows stay NULL — never
-- silently assigned on ambiguous evidence.
UPDATE public.automations t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.contacts t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.dm_jobs t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.dm_sent_log t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.automation_sessions t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

-- dm_logs inherits from its (just-backfilled) parent session.
UPDATE public.dm_logs t
  SET workspace_id = s.workspace_id
  FROM public.automation_sessions s
  WHERE s.id = t.session_id AND t.workspace_id IS NULL AND s.workspace_id IS NOT NULL;

UPDATE public.recipient_opt_outs t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

-- ai_usage_log.instagram_account_id is nullable (SET NULL audit rows):
-- rows without an account stay NULL.
UPDATE public.ai_usage_log t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.dm_rate_events t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.comment_traffic_events t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.comment_traffic_incidents t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.traffic_guard_notifications t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.automation_follow_ups t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.comment_private_reply_reservations t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

UPDATE public.comment_public_reply_reservations t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.id = t.instagram_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

-- inbound_webhook_events keys accounts by IGSID TEXT (ig_account_id),
-- not by UUID: join on instagram_accounts.instagram_user_id.
UPDATE public.inbound_webhook_events t
  SET workspace_id = a.workspace_id
  FROM public.instagram_accounts a
  WHERE a.instagram_user_id = t.ig_account_id AND t.workspace_id IS NULL AND a.workspace_id IS NOT NULL;

-- debug_events / job_queue: NO backfill — neither table carries an
-- account column (debug_events has only user_id; job_queue only a JSONB
-- payload), so there is no trustworthy owning-account evidence. Their
-- rows stay NULL until Phase D writers stamp workspace_id explicitly.

-- ── C. Composite tenant-integrity constraints ──────────────────────────────
-- UNIQUE (workspace_id, id) targets for the composite FKs. A unique
-- INDEX is used (not ADD CONSTRAINT) so the statement is idempotent
-- via IF NOT EXISTS. NULL workspace_id rows are distinct under UNIQUE —
-- transitional semantics, see header.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_accounts_workspace_id_id
  ON public.instagram_accounts (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_automations_workspace_id_id
  ON public.automations (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_sessions_workspace_id_id
  ON public.automation_sessions (workspace_id, id);

-- Composite FKs (MATCH SIMPLE — the default: a NULL workspace_id skips
-- the check). Each addition is guarded by a pg_constraint lookup.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_automations_workspace_account' AND conrelid = 'public.automations'::regclass) THEN
    ALTER TABLE public.automations ADD CONSTRAINT fk_automations_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contacts_workspace_account' AND conrelid = 'public.contacts'::regclass) THEN
    ALTER TABLE public.contacts ADD CONSTRAINT fk_contacts_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dm_jobs_workspace_automation' AND conrelid = 'public.dm_jobs'::regclass) THEN
    ALTER TABLE public.dm_jobs ADD CONSTRAINT fk_dm_jobs_workspace_automation
      FOREIGN KEY (workspace_id, automation_id)
      REFERENCES public.automations (workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dm_jobs_workspace_account' AND conrelid = 'public.dm_jobs'::regclass) THEN
    ALTER TABLE public.dm_jobs ADD CONSTRAINT fk_dm_jobs_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dm_sent_log_workspace_automation' AND conrelid = 'public.dm_sent_log'::regclass) THEN
    ALTER TABLE public.dm_sent_log ADD CONSTRAINT fk_dm_sent_log_workspace_automation
      FOREIGN KEY (workspace_id, automation_id)
      REFERENCES public.automations (workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dm_sent_log_workspace_account' AND conrelid = 'public.dm_sent_log'::regclass) THEN
    ALTER TABLE public.dm_sent_log ADD CONSTRAINT fk_dm_sent_log_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_automation_sessions_workspace_automation' AND conrelid = 'public.automation_sessions'::regclass) THEN
    ALTER TABLE public.automation_sessions ADD CONSTRAINT fk_automation_sessions_workspace_automation
      FOREIGN KEY (workspace_id, automation_id)
      REFERENCES public.automations (workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_automation_sessions_workspace_account' AND conrelid = 'public.automation_sessions'::regclass) THEN
    ALTER TABLE public.automation_sessions ADD CONSTRAINT fk_automation_sessions_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dm_logs_workspace_session' AND conrelid = 'public.dm_logs'::regclass) THEN
    ALTER TABLE public.dm_logs ADD CONSTRAINT fk_dm_logs_workspace_session
      FOREIGN KEY (workspace_id, session_id)
      REFERENCES public.automation_sessions (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recipient_opt_outs_workspace_account' AND conrelid = 'public.recipient_opt_outs'::regclass) THEN
    ALTER TABLE public.recipient_opt_outs ADD CONSTRAINT fk_recipient_opt_outs_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_follow_ups_workspace_automation' AND conrelid = 'public.automation_follow_ups'::regclass) THEN
    ALTER TABLE public.automation_follow_ups ADD CONSTRAINT fk_follow_ups_workspace_automation
      FOREIGN KEY (workspace_id, automation_id)
      REFERENCES public.automations (workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_follow_ups_workspace_account' AND conrelid = 'public.automation_follow_ups'::regclass) THEN
    ALTER TABLE public.automation_follow_ups ADD CONSTRAINT fk_follow_ups_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_comment_reservations_workspace_automation' AND conrelid = 'public.comment_private_reply_reservations'::regclass) THEN
    ALTER TABLE public.comment_private_reply_reservations ADD CONSTRAINT fk_comment_reservations_workspace_automation
      FOREIGN KEY (workspace_id, automation_id)
      REFERENCES public.automations (workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_comment_reservations_workspace_account' AND conrelid = 'public.comment_private_reply_reservations'::regclass) THEN
    ALTER TABLE public.comment_private_reply_reservations ADD CONSTRAINT fk_comment_reservations_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_comment_pub_reservations_workspace_automation' AND conrelid = 'public.comment_public_reply_reservations'::regclass) THEN
    ALTER TABLE public.comment_public_reply_reservations ADD CONSTRAINT fk_comment_pub_reservations_workspace_automation
      FOREIGN KEY (workspace_id, automation_id)
      REFERENCES public.automations (workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_comment_pub_reservations_workspace_account' AND conrelid = 'public.comment_public_reply_reservations'::regclass) THEN
    ALTER TABLE public.comment_public_reply_reservations ADD CONSTRAINT fk_comment_pub_reservations_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_traffic_events_workspace_account' AND conrelid = 'public.comment_traffic_events'::regclass) THEN
    ALTER TABLE public.comment_traffic_events ADD CONSTRAINT fk_traffic_events_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_traffic_incidents_workspace_account' AND conrelid = 'public.comment_traffic_incidents'::regclass) THEN
    ALTER TABLE public.comment_traffic_incidents ADD CONSTRAINT fk_traffic_incidents_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_traffic_notif_workspace_account' AND conrelid = 'public.traffic_guard_notifications'::regclass) THEN
    ALTER TABLE public.traffic_guard_notifications ADD CONSTRAINT fk_traffic_notif_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dm_rate_events_workspace_account' AND conrelid = 'public.dm_rate_events'::regclass) THEN
    ALTER TABLE public.dm_rate_events ADD CONSTRAINT fk_dm_rate_events_workspace_account
      FOREIGN KEY (workspace_id, instagram_account_id)
      REFERENCES public.instagram_accounts (workspace_id, id) ON DELETE CASCADE;
  END IF;
END $$;

-- Deliberately NO composite FK on ai_usage_log: its account/automation
-- links are ON DELETE SET NULL audit references by design (…000021);
-- a composite NO ACTION FK would fight that semantics. Its tenancy is
-- enforced by RLS + the (workspace_id, created_at) index instead.

-- ── D. RLS re-expression (dual-policy transition window) ───────────────────
-- Grants first (idempotent): policies only take effect where the role
-- holds the table privilege. …000016 already grants automations CRUD,
-- instagram_accounts SELECT/DELETE and SELECT on the read-only tables;
-- the grants below restate the set this file's policies need and widen
-- contacts to CRUD so its new write policies are effective (product
-- writes still flow through the service role; RLS gates every row).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.automations TO authenticated;
GRANT SELECT, DELETE ON TABLE public.instagram_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contacts TO authenticated;
GRANT SELECT ON TABLE public.dm_jobs, public.dm_sent_log,
  public.automation_sessions, public.dm_logs, public.recipient_opt_outs,
  public.ai_usage_log, public.automation_follow_ups,
  public.comment_private_reply_reservations,
  public.comment_public_reply_reservations TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.comment_traffic_incidents,
  public.traffic_guard_notifications TO authenticated;
GRANT ALL ON TABLE public.automations, public.contacts, public.dm_jobs,
  public.dm_sent_log, public.automation_sessions, public.dm_logs,
  public.recipient_opt_outs, public.ai_usage_log, public.debug_events,
  public.job_queue, public.inbound_webhook_events, public.dm_rate_events,
  public.comment_traffic_events, public.comment_traffic_incidents,
  public.traffic_guard_notifications, public.automation_follow_ups,
  public.comment_private_reply_reservations,
  public.comment_public_reply_reservations TO service_role;

-- ── D1. automations (user_id + workspace_id) ──
DROP POLICY IF EXISTS "Users can view own automations" ON public.automations;
CREATE POLICY "Users can view own automations"
  ON public.automations FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));
DROP POLICY IF EXISTS "Users can insert own automations" ON public.automations;
CREATE POLICY "Users can insert own automations"
  ON public.automations FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
              OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));
DROP POLICY IF EXISTS "Users can update own automations" ON public.automations;
CREATE POLICY "Users can update own automations"
  ON public.automations FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
              OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));
DROP POLICY IF EXISTS "Users can delete own automations" ON public.automations;
CREATE POLICY "Users can delete own automations"
  ON public.automations FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));

-- ── D2. instagram_accounts (user_id + workspace_id; SELECT/DELETE only,
--        as before — connect/disconnect writes stay service-role) ──
DROP POLICY IF EXISTS "Users can view own instagram accounts" ON public.instagram_accounts;
CREATE POLICY "Users can view own instagram accounts"
  ON public.instagram_accounts FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));
DROP POLICY IF EXISTS "Users can delete own instagram accounts" ON public.instagram_accounts;
CREATE POLICY "Users can delete own instagram accounts"
  ON public.instagram_accounts FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));

-- ── D3. contacts (no user_id: legacy arm joins the owning account) ──
DROP POLICY IF EXISTS "Users can view own contacts" ON public.contacts;
CREATE POLICY "Users can view own contacts"
  ON public.contacts FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.instagram_accounts a
           WHERE a.id = contacts.instagram_account_id AND a.user_id = (SELECT auth.uid()))));
DROP POLICY IF EXISTS "Users can insert own contacts" ON public.contacts;
CREATE POLICY "Users can insert own contacts"
  ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
              OR (workspace_id IS NULL AND EXISTS (
                SELECT 1 FROM public.instagram_accounts a
                WHERE a.id = contacts.instagram_account_id AND a.user_id = (SELECT auth.uid()))));
DROP POLICY IF EXISTS "Users can update own contacts" ON public.contacts;
CREATE POLICY "Users can update own contacts"
  ON public.contacts FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.instagram_accounts a
           WHERE a.id = contacts.instagram_account_id AND a.user_id = (SELECT auth.uid()))))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
              OR (workspace_id IS NULL AND EXISTS (
                SELECT 1 FROM public.instagram_accounts a
                WHERE a.id = contacts.instagram_account_id AND a.user_id = (SELECT auth.uid()))));
DROP POLICY IF EXISTS "Users can delete own contacts" ON public.contacts;
CREATE POLICY "Users can delete own contacts"
  ON public.contacts FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin','member']::public.workspace_role[])
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.instagram_accounts a
           WHERE a.id = contacts.instagram_account_id AND a.user_id = (SELECT auth.uid()))));

-- ── D4. Read-only engine/audit tables (SELECT only, as before): the
--        membership arm reads the row's own workspace_id; the legacy
--        arm keeps the pre-tenancy parent-ownership EXISTS join. ──
DROP POLICY IF EXISTS "Users can view own dm jobs" ON public.dm_jobs;
CREATE POLICY "Users can view own dm jobs"
  ON public.dm_jobs FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.automations a
           WHERE a.id = dm_jobs.automation_id AND a.user_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS "Users can view own dm sent log" ON public.dm_sent_log;
CREATE POLICY "Users can view own dm sent log"
  ON public.dm_sent_log FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.automations a
           WHERE a.id = dm_sent_log.automation_id AND a.user_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS "Users can view own automation sessions" ON public.automation_sessions;
CREATE POLICY "Users can view own automation sessions"
  ON public.automation_sessions FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.automations a
           WHERE a.id = automation_sessions.automation_id AND a.user_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS "Users can view own dm logs" ON public.dm_logs;
CREATE POLICY "Users can view own dm logs"
  ON public.dm_logs FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND session_id IN (
           SELECT s.id FROM public.automation_sessions s
           JOIN public.automations a ON a.id = s.automation_id
           WHERE a.user_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS "Users can view own recipient opt outs" ON public.recipient_opt_outs;
CREATE POLICY "Users can view own recipient opt outs"
  ON public.recipient_opt_outs FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.instagram_accounts a
           WHERE a.id = recipient_opt_outs.instagram_account_id AND a.user_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS "Users can view own follow ups" ON public.automation_follow_ups;
CREATE POLICY "Users can view own follow ups"
  ON public.automation_follow_ups FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.automations a
           WHERE a.id = automation_follow_ups.automation_id AND a.user_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS "Users can view own comment reservations" ON public.comment_private_reply_reservations;
CREATE POLICY "Users can view own comment reservations"
  ON public.comment_private_reply_reservations FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.automations a
           WHERE a.id = comment_private_reply_reservations.automation_id AND a.user_id = (SELECT auth.uid()))));

DROP POLICY IF EXISTS "Users can view own comment public reservations" ON public.comment_public_reply_reservations;
CREATE POLICY "Users can view own comment public reservations"
  ON public.comment_public_reply_reservations FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND EXISTS (
           SELECT 1 FROM public.automations a
           WHERE a.id = comment_public_reply_reservations.automation_id AND a.user_id = (SELECT auth.uid()))));

-- ── D5. ai_usage_log (user_id + workspace_id; SELECT only, as before) ──
DROP POLICY IF EXISTS "Users can view own AI usage" ON public.ai_usage_log;
CREATE POLICY "Users can view own AI usage"
  ON public.ai_usage_log FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));

-- ── D6. Traffic-guard user tables (user_id + workspace_id). Their
--        UPDATE is read-state/dismissal, a member-level action, so the
--        UPDATE arm uses membership (any role) rather than the writable
--        role subset — recorded in the isolation matrix. ──
DROP POLICY IF EXISTS "Users can read own traffic incidents" ON public.comment_traffic_incidents;
CREATE POLICY "Users can read own traffic incidents"
  ON public.comment_traffic_incidents FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));
DROP POLICY IF EXISTS "Users can update own traffic incidents" ON public.comment_traffic_incidents;
CREATE POLICY "Users can update own traffic incidents"
  ON public.comment_traffic_incidents FOR UPDATE TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id))
  WITH CHECK (public.is_workspace_member(workspace_id)
              OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));

DROP POLICY IF EXISTS "Users can read own traffic notifications" ON public.traffic_guard_notifications;
CREATE POLICY "Users can read own traffic notifications"
  ON public.traffic_guard_notifications FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));
DROP POLICY IF EXISTS "Users can update own traffic notifications" ON public.traffic_guard_notifications;
CREATE POLICY "Users can update own traffic notifications"
  ON public.traffic_guard_notifications FOR UPDATE TO authenticated
  USING (public.is_workspace_member(workspace_id)
         OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id))
  WITH CHECK (public.is_workspace_member(workspace_id)
              OR (workspace_id IS NULL AND (SELECT auth.uid()) = user_id));

-- ── D7. Service-role-only tables — intentionally NO policy changes ──
-- debug_events, job_queue, inbound_webhook_events, dm_rate_events and
-- comment_traffic_events keep RLS enabled with no authenticated
-- policies. workspace_id on them exists solely so server-side code can
-- scope/filter by workspace; it grants clients nothing.
