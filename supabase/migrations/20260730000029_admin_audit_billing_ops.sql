-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 14 (productization COPY ONLY) — Billing administration:
-- admin_audit_log (append-only), refund_records (mock-recording model),
-- invoices, and billing report VIEWS (defined, not populated).
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. That list is UNCHANGED:
-- 000021 required; 000002/000003 conditional; 000022/000023
-- candidate-only; …000024–…000028 are Phase 13 copy-only artifacts.
-- This file (…000029) is likewise NOT on the frozen apply-list and must
-- never be applied to production under the release gates. ***
--
-- Posture: admin_audit_log and refund_records are service-role only
-- (no authenticated grants/policies at all, like billing_events).
-- admin_audit_log is append-only at THREE levels: (1) grants expose
-- only SELECT + INSERT to service_role, (2) a trigger raises on any
-- UPDATE/DELETE attempt, (3) the app service (src/lib/admin) exposes no
-- mutation API. Report views read the Phase 13 subscriptions table and
-- are keyed by currency — views never sum across currencies.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── admin_audit_log (append-only) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role    TEXT        NOT NULL CHECK (actor_role IN ('platform-admin','platform-support')),
  action        TEXT        NOT NULL,
  target_type   TEXT        NOT NULL CHECK (target_type IN ('workspace','subscription','refund','invoice','entitlement')),
  target_id     TEXT        NOT NULL,
  workspace_id  UUID        REFERENCES public.workspaces(id) ON DELETE SET NULL,
  before_state  JSONB,
  after_state   JSONB,
  reason        TEXT        NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_workspace ON public.admin_audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON public.admin_audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON public.admin_audit_log(created_at);

CREATE OR REPLACE FUNCTION public.admin_audit_log_append_only()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only: % is not permitted', TG_OP;
END $$;
DROP TRIGGER IF EXISTS admin_audit_no_update ON public.admin_audit_log;
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_append_only();
DROP TRIGGER IF EXISTS admin_audit_no_delete ON public.admin_audit_log;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_append_only();

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO service_role;
-- Deliberately NO UPDATE/DELETE grant to anyone, and no authenticated
-- policies: the audit log is a platform-operations surface only.

-- ── refund_records (recording model — execution is provider-side, later) ──
CREATE TABLE IF NOT EXISTS public.refund_records (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  invoice_id         UUID,
  amount_minor       BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency           TEXT        NOT NULL CHECK (currency IN ('INR','USD')),
  reason             TEXT        NOT NULL CHECK (length(btrim(reason)) > 0),
  -- 'recorded-mock' is the ONLY status the Phase 14 prototype can write;
  -- live statuses are added by a later, owner-approved phase.
  status             TEXT        NOT NULL DEFAULT 'recorded-mock' CHECK (status IN ('recorded-mock')),
  mode               TEXT        NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock')),
  provider_refund_id TEXT,
  recorded_by        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  audit_log_id       UUID        REFERENCES public.admin_audit_log(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refund_records_workspace ON public.refund_records(workspace_id);
ALTER TABLE public.refund_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.refund_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.refund_records TO service_role;
-- No authenticated policies: refund records are admin-surface only in
-- this phase (customer-visible refund status is a later design step).

-- ── invoices (invoice history backing table) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.invoices (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id    UUID        REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  amount_minor       BIGINT      NOT NULL CHECK (amount_minor >= 0),
  currency           TEXT        NOT NULL CHECK (currency IN ('INR','USD')),
  status             TEXT        NOT NULL CHECK (status IN ('paid','open','failed','void','refunded')),
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_start       TIMESTAMPTZ,
  period_end         TIMESTAMPTZ,
  provider_invoice_ref TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_workspace ON public.invoices(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invoices_issued ON public.invoices(issued_at);
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invoices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.invoices TO authenticated;
GRANT ALL ON TABLE public.invoices TO service_role;
DROP POLICY IF EXISTS invoices_select_member ON public.invoices;
CREATE POLICY invoices_select_member ON public.invoices
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
-- Writes are service-role only (verified webhooks / admin service).

-- ── Billing report VIEWS (defined, not populated; per-currency) ───────────
-- MRR: active + past_due subscriptions; annual normalized by /12 floor.
CREATE OR REPLACE VIEW public.v_billing_mrr_by_currency AS
  SELECT currency,
         SUM(CASE WHEN billing_period = 'annual' THEN amount_minor / 12 ELSE amount_minor END) AS mrr_minor,
         COUNT(*) AS contributing_subscriptions
  FROM public.subscriptions
  WHERE lifecycle_status IN ('active','past_due')
  GROUP BY currency;

-- Past-due aging: bucket by days since the subscription entered past_due
-- (approximated by last_provider_event_at until a dedicated
-- past_due_since column is owner-approved — see architecture doc §7).
CREATE OR REPLACE VIEW public.v_billing_past_due_aging AS
  SELECT currency,
         CASE
           WHEN NOW() - last_provider_event_at <= INTERVAL '7 days' THEN '0-7'
           WHEN NOW() - last_provider_event_at <= INTERVAL '30 days' THEN '8-30'
           WHEN NOW() - last_provider_event_at <= INTERVAL '60 days' THEN '31-60'
           ELSE '61+'
         END AS bucket,
         COUNT(*) AS subscriptions,
         SUM(amount_minor) AS amount_minor
  FROM public.subscriptions
  WHERE lifecycle_status = 'past_due'
  GROUP BY currency, bucket;

-- Trial conversion: subscriptions that ever trialed (trial_ends_at set)
-- vs those now active.
CREATE OR REPLACE VIEW public.v_billing_trial_conversion AS
  SELECT COUNT(*) FILTER (WHERE trial_ends_at IS NOT NULL) AS trials_started,
         COUNT(*) FILTER (WHERE trial_ends_at IS NOT NULL AND lifecycle_status = 'active') AS converted
  FROM public.subscriptions;

-- Churn (monthly): cancellations whose updated_at falls in the month of
-- current_period_end month bucket — a reporting approximation, defined
-- here so the definition is reviewed once, centrally (see doc §7).
CREATE OR REPLACE VIEW public.v_billing_churn_monthly AS
  SELECT DATE_TRUNC('month', updated_at) AS month,
         COUNT(*) AS cancelled_subscriptions
  FROM public.subscriptions
  WHERE lifecycle_status = 'cancelled'
  GROUP BY DATE_TRUNC('month', updated_at);
