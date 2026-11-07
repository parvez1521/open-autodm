-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 13 (productization COPY ONLY) — Billing tables per Phase 11 §B.4.5
-- + Phase 12 architecture: subscriptions (with lifecycle columns),
-- workspace_billing_profiles, billing_customers.
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list (000021 required;
-- 000002/000003 conditional; 000022/000023 candidate-only). ***
--
-- Posture: members may SELECT their workspace subscription; there are NO
-- authenticated INSERT/UPDATE/DELETE policies on subscriptions — writes
-- come only from service-role server code after owner checks or from
-- verified provider webhooks (Phase 12). Currency is immutable after
-- issuance (enforced by trigger below: a currency change requires
-- cancel + new subscription).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── subscriptions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID        NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  plan_id                  TEXT        NOT NULL,
  lifecycle_status         TEXT        NOT NULL DEFAULT 'free'
                             CHECK (lifecycle_status IN ('trialing','incomplete','active','past_due','paused','cancelled','expired','free')),
  provider                 TEXT        CHECK (provider IN ('razorpay','cashfree','stripe')),
  provider_customer_id     TEXT,
  provider_subscription_id TEXT,
  provider_status_raw      TEXT,
  billing_period           TEXT        CHECK (billing_period IN ('monthly','annual')),
  amount_minor             BIGINT      NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency                 TEXT        NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR','USD')),
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  trial_ends_at            TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN     NOT NULL DEFAULT false,
  paused_at                TIMESTAMPTZ,
  last_provider_event_at   TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_sub ON public.subscriptions(provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(lifecycle_status);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Currency immutability (Phase 12): reject any UPDATE that changes it.
CREATE OR REPLACE FUNCTION public.subscriptions_currency_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'subscription currency is immutable after issuance';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS subscriptions_currency_guard ON public.subscriptions;
CREATE TRIGGER subscriptions_currency_guard BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.subscriptions_currency_immutable();

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;
GRANT ALL ON TABLE public.subscriptions TO service_role;
DROP POLICY IF EXISTS subscriptions_select_member ON public.subscriptions;
CREATE POLICY subscriptions_select_member ON public.subscriptions
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
-- Deliberately no authenticated write policies (see header).

-- ── workspace_billing_profiles ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_billing_profiles (
  workspace_id         UUID        PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  billing_email        TEXT,
  legal_name           TEXT,
  country              TEXT,
  tax_id               TEXT,
  provider_customer_id TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_profiles_provider_customer ON public.workspace_billing_profiles(provider_customer_id);
CREATE TRIGGER billing_profiles_updated_at BEFORE UPDATE ON public.workspace_billing_profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
ALTER TABLE public.workspace_billing_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_billing_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.workspace_billing_profiles TO authenticated;
GRANT ALL ON TABLE public.workspace_billing_profiles TO service_role;
DROP POLICY IF EXISTS billing_profiles_select_owner_admin ON public.workspace_billing_profiles;
CREATE POLICY billing_profiles_select_owner_admin ON public.workspace_billing_profiles
  FOR SELECT TO authenticated USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS billing_profiles_insert_owner_admin ON public.workspace_billing_profiles;
CREATE POLICY billing_profiles_insert_owner_admin ON public.workspace_billing_profiles
  FOR INSERT TO authenticated WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS billing_profiles_update_owner_admin ON public.workspace_billing_profiles;
CREATE POLICY billing_profiles_update_owner_admin ON public.workspace_billing_profiles
  FOR UPDATE TO authenticated
  USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]))
  WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));

-- ── billing_customers (one row per workspace × provider) ──────────────────
CREATE TABLE IF NOT EXISTS public.billing_customers (
  workspace_id         UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider             TEXT        NOT NULL CHECK (provider IN ('razorpay','cashfree','stripe')),
  provider_customer_id TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider),
  UNIQUE (provider, provider_customer_id)
);
CREATE TRIGGER billing_customers_updated_at BEFORE UPDATE ON public.billing_customers
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_customers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.billing_customers TO authenticated;
GRANT ALL ON TABLE public.billing_customers TO service_role;
DROP POLICY IF EXISTS billing_customers_select_owner_admin ON public.billing_customers;
CREATE POLICY billing_customers_select_owner_admin ON public.billing_customers
  FOR SELECT TO authenticated USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
-- Writes are service-role only (provider customer creation is server-side).
