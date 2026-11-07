-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 13 (productization COPY ONLY) — billing_events (durable form of
-- the Phase 12 BillingEventStore) + payment_attempts.
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list (000021 required;
-- 000002/000003 conditional; 000022/000023 candidate-only). ***
--
-- billing_events: NO raw payload column, NO PII, NO card data — sanitized
-- metadata only (Phase 12 rule). UNIQUE (provider, provider_event_id) is
-- the database-level idempotency/replay guard. Service-role only, like
-- platform_config: no authenticated policies at all.
-- payment_attempts: service-role writes; members may SELECT attempts that
-- belong to their workspace's subscription (join policy).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.billing_events (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 TEXT        NOT NULL CHECK (provider IN ('razorpay','cashfree','stripe')),
  provider_event_id        TEXT        NOT NULL,
  provider_subscription_id TEXT,
  workspace_id             UUID        REFERENCES public.workspaces(id) ON DELETE SET NULL,
  event_type               TEXT        NOT NULL,
  claimed_status           TEXT,
  server_status            TEXT,
  outcome                  TEXT        NOT NULL,
  occurred_at              TIMESTAMPTZ NOT NULL,
  processed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_events_workspace ON public.billing_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_provider_sub ON public.billing_events(provider_subscription_id);
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.billing_events TO service_role;
-- No authenticated policies: ops/audit surface only.

CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id     UUID        NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  provider_payment_id TEXT,
  status              TEXT        NOT NULL CHECK (status IN ('succeeded','failed','pending','unknown')),
  amount_minor        BIGINT,
  currency            TEXT        CHECK (currency IN ('INR','USD')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_subscription ON public.payment_attempts(subscription_id);
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.payment_attempts TO authenticated;
GRANT ALL ON TABLE public.payment_attempts TO service_role;
DROP POLICY IF EXISTS payment_attempts_select_member ON public.payment_attempts;
CREATE POLICY payment_attempts_select_member ON public.payment_attempts
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.subscriptions s
    WHERE s.id = payment_attempts.subscription_id
      AND public.is_workspace_member(s.workspace_id)
  ));
