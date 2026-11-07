-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 13 (productization COPY ONLY) — Tenancy core: workspaces,
-- memberships, invitations + membership helper functions.
-- Implements the Phase 11 design (saas/phase11-multitenancy-architecture.md
-- §B.2–B.4). 
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. That list is UNCHANGED:
-- 000021 required; 000002/000003 conditional; 000022/000023 candidate-only.
-- This file must never be applied to production under the release gates. ***
--
-- RLS follows the Supabase guidance used in Phase 11: grants AND policies
-- per table; a separate policy per operation, always TO authenticated;
-- policy filter columns indexed; (select auth.uid()) wrapping; SECURITY
-- DEFINER helpers with search_path = '' and schema-qualified names;
-- authorization NEVER from raw_user_meta_data (user-editable) — role
-- lives only in workspace_memberships.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Role enum ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.workspace_role AS ENUM ('owner', 'admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── workspaces ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspaces (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_by UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_created_by ON public.workspaces(created_by);
CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ── workspace_memberships ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_memberships (
  workspace_id UUID               NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      UUID               NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         public.workspace_role NOT NULL,
  invited_by   UUID               REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);
-- The composite PK leads with workspace_id, so user_id needs its own index.
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON public.workspace_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_workspace_role ON public.workspace_memberships(workspace_id, role);

-- ── Helper functions (SECURITY DEFINER — break policy recursion) ──────────
CREATE OR REPLACE FUNCTION public.workspace_role(p_workspace_id UUID)
RETURNS public.workspace_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT m.role FROM public.workspace_memberships m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = (SELECT auth.uid())
$$;
REVOKE ALL ON FUNCTION public.workspace_role(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_role(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT public.workspace_role(p_workspace_id) IS NOT NULL $$;
REVOKE ALL ON FUNCTION public.is_workspace_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.has_workspace_role(p_workspace_id UUID, p_roles public.workspace_role[])
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT public.workspace_role(p_workspace_id) = ANY (p_roles) $$;
REVOKE ALL ON FUNCTION public.has_workspace_role(UUID, public.workspace_role[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_workspace_role(UUID, public.workspace_role[]) TO authenticated, service_role;

-- ── RLS: workspaces ────────────────────────────────────────────────────────
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspaces FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspaces TO authenticated;
GRANT ALL ON TABLE public.workspaces TO service_role;

DROP POLICY IF EXISTS workspaces_select_member ON public.workspaces;
CREATE POLICY workspaces_select_member ON public.workspaces
  FOR SELECT TO authenticated USING (public.is_workspace_member(id));
DROP POLICY IF EXISTS workspaces_insert_creator ON public.workspaces;
CREATE POLICY workspaces_insert_creator ON public.workspaces
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = created_by);
DROP POLICY IF EXISTS workspaces_update_owner_admin ON public.workspaces;
CREATE POLICY workspaces_update_owner_admin ON public.workspaces
  FOR UPDATE TO authenticated
  USING (public.workspace_role(id) = ANY (ARRAY['owner','admin']::public.workspace_role[]))
  WITH CHECK (public.workspace_role(id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS workspaces_delete_owner ON public.workspaces;
CREATE POLICY workspaces_delete_owner ON public.workspaces
  FOR DELETE TO authenticated USING (public.workspace_role(id) = 'owner');

-- ── RLS: workspace_memberships ─────────────────────────────────────────────
ALTER TABLE public.workspace_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_memberships FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_memberships TO authenticated;
GRANT ALL ON TABLE public.workspace_memberships TO service_role;

DROP POLICY IF EXISTS memberships_select_member ON public.workspace_memberships;
CREATE POLICY memberships_select_member ON public.workspace_memberships
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS memberships_insert_owner_admin ON public.workspace_memberships;
CREATE POLICY memberships_insert_owner_admin ON public.workspace_memberships
  FOR INSERT TO authenticated
  WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS memberships_update_owner_admin ON public.workspace_memberships;
CREATE POLICY memberships_update_owner_admin ON public.workspace_memberships
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS memberships_delete_owner_or_self ON public.workspace_memberships;
CREATE POLICY memberships_delete_owner_or_self ON public.workspace_memberships
  FOR DELETE TO authenticated
  USING (public.workspace_role(workspace_id) = 'owner' OR (SELECT auth.uid()) = user_id);
-- NOTE: the "last owner cannot be demoted/removed" guard cannot be a plain
-- policy (it needs a count); it is an RPC/app-layer responsibility per
-- Phase 11 §B.4.2 and is NOT enforced by these policies.

-- ── workspace_invitations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_invitations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email        TEXT        NOT NULL,
  role         public.workspace_role NOT NULL CHECK (role <> 'owner'),
  token_hash   TEXT        NOT NULL,
  invited_by   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_token_hash ON public.workspace_invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON public.workspace_invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.workspace_invitations(email);

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_invitations TO authenticated;
GRANT ALL ON TABLE public.workspace_invitations TO service_role;

DROP POLICY IF EXISTS invitations_select_owner_admin ON public.workspace_invitations;
CREATE POLICY invitations_select_owner_admin ON public.workspace_invitations
  FOR SELECT TO authenticated USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS invitations_insert_owner_admin ON public.workspace_invitations;
CREATE POLICY invitations_insert_owner_admin ON public.workspace_invitations
  FOR INSERT TO authenticated WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS invitations_update_owner_admin ON public.workspace_invitations;
CREATE POLICY invitations_update_owner_admin ON public.workspace_invitations
  FOR UPDATE TO authenticated
  USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]))
  WITH CHECK (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
DROP POLICY IF EXISTS invitations_delete_owner_admin ON public.workspace_invitations;
CREATE POLICY invitations_delete_owner_admin ON public.workspace_invitations
  FOR DELETE TO authenticated USING (public.workspace_role(workspace_id) = ANY (ARRAY['owner','admin']::public.workspace_role[]));
-- Invite ACCEPTANCE is deliberately not a table operation for invitees:
-- it goes through a future definer RPC (Phase 11 §B.4.3), not designed here.
