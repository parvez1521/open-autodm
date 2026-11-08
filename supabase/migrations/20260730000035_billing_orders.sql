-- ═══════════════════════════════════════════════════════════════════════════
-- SaaS subscription wiring (productization COPY ONLY) — billing_orders:
-- the durable record of a Razorpay order created for a workspace.
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. Staging-compatible; apply
-- to the staging/preview project only, never production. ***
--
-- Why this table exists: checkout (POST /api/billing/checkout) creates a
-- one-time Razorpay ORDER (not a Razorpay subscription). The order must
-- be bound to the caller's workspace at creation time so the signed
-- webhook (POST /api/billing/webhook) can resolve workspace + plan +
-- period from THIS row — server-side truth — and never from anything
-- the webhook payload claims (forged workspace claims in a payload are
-- ignored by design; see the tenancy security matrix §1 posture).
--
-- UNIQUE (provider, provider_order_id) is the database-level guard
-- against recording the same provider order twice. Writes are
-- service-role only (checkout route after owner checks; webhook route
-- after signature verification). Members may SELECT their own
-- workspace's orders for the billing UI.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.billing_orders (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider            TEXT        NOT NULL CHECK (provider IN ('razorpay','cashfree','stripe')),
  provider_order_id   TEXT        NOT NULL,
  plan_id             TEXT        NOT NULL,
  billing_period      TEXT        NOT NULL CHECK (billing_period IN ('monthly','annual')),
  amount_minor        BIGINT      NOT NULL CHECK (amount_minor >= 0),
  currency            TEXT        NOT NULL CHECK (currency IN ('INR','USD')),
  status              TEXT        NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','paid','failed','expired')),
  receipt             TEXT,
  provider_payment_id TEXT,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_order_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_orders_workspace ON public.billing_orders(workspace_id);
CREATE TRIGGER billing_orders_updated_at BEFORE UPDATE ON public.billing_orders
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.billing_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.billing_orders TO authenticated;
GRANT ALL ON TABLE public.billing_orders TO service_role;
DROP POLICY IF EXISTS billing_orders_select_member ON public.billing_orders;
CREATE POLICY billing_orders_select_member ON public.billing_orders
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
-- Deliberately no authenticated write policies: orders are recorded by
-- service-role server code only (checkout + verified webhook).
