-- ═══════════════════════════════════════════════════════════════════
-- Preview launch preparation (productization COPY ONLY) — waitlist.
--
-- A single table collecting email addresses from the public landing
-- page while public signup opens in stages. Written ONLY by the
-- service-role client inside POST /api/waitlist
-- (src/app/api/waitlist/route.ts); read by the owner in the dashboard.
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. That list is UNCHANGED:
-- 000021 required; 000002/000003 conditional; 000022/000023 candidate-only.
-- This file must never be applied to production under the release gates.
-- Applied to the STAGING project only, as the preview backend. ***
--
-- Access shape deliberately differs from the tenant tables in ONE way
-- and matches them in another: like them, RLS is enabled and NOTHING
-- is granted to anon or authenticated — no policy exists at all.
-- Unlike them, there is also no authenticated path: the only reader
-- or writer is the service role, which bypasses RLS. A public
-- landing-page insert therefore never touches this table directly.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.waitlist_entries (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL,
  source     TEXT        NOT NULL DEFAULT 'landing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per address; the API route treats a unique violation as
-- "already on the list", not as an error.
CREATE UNIQUE INDEX IF NOT EXISTS uq_waitlist_entries_email
  ON public.waitlist_entries (email);
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_created_at
  ON public.waitlist_entries (created_at);

ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.waitlist_entries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.waitlist_entries TO service_role;

-- No policies on purpose: with RLS enabled and no policy, anon and
-- authenticated roles can neither read nor write; service_role
-- bypasses RLS for the API route and the owner's dashboard.
