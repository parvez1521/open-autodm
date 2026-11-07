-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 13 (productization COPY ONLY) — Instagram account → workspace
-- binding (Phase 11 §B.6). Two additive pieces, both inert for the
-- existing release:
--   1. instagram_accounts gains a NULLABLE workspace_id (backfill +
--      NOT NULL are later, separately-gated steps per Phase 11 §B.8 —
--      NOT done here). Existing policies on instagram_accounts are NOT
--      altered by this file.
--   2. workspace_instagram_accounts mapping table recording the binding
--      + who connected the account, with membership-based RLS.
-- The global UNIQUE (instagram_user_id) invariant is KEPT (one workspace
-- per IG account, platform-wide).
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list (000021 required;
-- 000002/000003 conditional; 000022/000023 candidate-only). ***
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.instagram_accounts
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE SET NULL;
ALTER TABLE public.instagram_accounts
  ADD COLUMN IF NOT EXISTS connected_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_instagram_accounts_workspace ON public.instagram_accounts(workspace_id);

CREATE TABLE IF NOT EXISTS public.workspace_instagram_accounts (
  workspace_id         UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  instagram_account_id UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  connected_by         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, instagram_account_id),
  UNIQUE (instagram_account_id)  -- an IG account binds to exactly one workspace
);
CREATE INDEX IF NOT EXISTS idx_ws_ig_accounts_workspace ON public.workspace_instagram_accounts(workspace_id);

ALTER TABLE public.workspace_instagram_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_instagram_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.workspace_instagram_accounts TO authenticated;
GRANT ALL ON TABLE public.workspace_instagram_accounts TO service_role;

DROP POLICY IF EXISTS ws_ig_select_member ON public.workspace_instagram_accounts;
CREATE POLICY ws_ig_select_member ON public.workspace_instagram_accounts
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS ws_ig_insert_owner_admin ON public.workspace_instagram_accounts;
CREATE POLICY ws_ig_insert_owner_admin ON public.workspace_instagram_accounts
  FOR INSERT TO authenticated WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS ws_ig_delete_owner_admin ON public.workspace_instagram_accounts;
CREATE POLICY ws_ig_delete_owner_admin ON public.workspace_instagram_accounts
  FOR DELETE TO authenticated USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
-- No UPDATE policy: rebinding = delete + insert, both owner/admin-gated,
-- and the callback's reject-on-foreign-workspace rule (Phase 11 §B.6)
-- is enforced server-side in the connect flow.
