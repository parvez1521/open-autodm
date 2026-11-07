-- ═══════════════════════════════════════════════════════════════════════════
-- Phase B / Programme 16 (productization COPY ONLY) — Workspace membership
-- RPCs: create-workspace bootstrap, invitation acceptance, role change and
-- member removal with the last-owner guard. These close the gaps recorded
-- against …000024 (Phase 11 §B.4.1 bootstrap, §B.4.2 last-owner guard,
-- §B.4.3 invitation acceptance).
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. That list is UNCHANGED:
-- 000021 required; 000002/000003 conditional; 000022/000023
-- candidate-only; …000024–…000030 are copy-only artifacts.
-- This file (…000031) is likewise NOT on the frozen apply-list and must
-- never be applied to production under the release gates. ***
--
-- Posture (same as …000024): every function is SECURITY DEFINER with
-- search_path = '' and schema-qualified names throughout; authorization
-- derives ONLY from (select auth.uid()) + workspace_memberships rows —
-- never from raw_user_meta_data or any user-editable metadata. All error
-- messages are generic and non-sensitive (no token, email, or row data
-- beyond what the caller already supplied).
--
-- Prerequisite: …000030 must be applied in an EARLIER transaction than
-- this file — the 'viewer' enum value added there may not be used in the
-- transaction that created it. This file does not reference 'viewer'
-- literally, but the functions accept/return the full workspace_role
-- enum, so the ordering is required regardless.
-- ═══════════════════════════════════════════════════════════════════════════

-- digest() (used to hash invitation tokens) is provided by pgcrypto.
-- On Supabase, pgcrypto is pre-installed in the `extensions` schema,
-- which is why the call below is qualified as extensions.digest(...):
-- with search_path = '' an unqualified call would not resolve.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── create_workspace ───────────────────────────────────────────────────────
-- Atomically creates the workspace AND the creator's owner membership.
-- A direct table INSERT by the creator cannot do this safely (the
-- membership policy requires already being owner/admin), so bootstrap
-- goes through this definer RPC.
CREATE OR REPLACE FUNCTION public.create_workspace(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor UUID := (SELECT auth.uid());
  v_workspace_id UUID;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'workspace name must not be blank';
  END IF;

  INSERT INTO public.workspaces (name, created_by)
  VALUES (btrim(p_name), v_actor)
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_memberships (workspace_id, user_id, role)
  VALUES (v_workspace_id, v_actor, 'owner'::public.workspace_role);

  RETURN v_workspace_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_workspace(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_workspace(TEXT) TO authenticated, service_role;

-- ── accept_workspace_invitation ────────────────────────────────────────────
-- Invitees have NO direct table access to workspace_invitations by design
-- (…000024 grants SELECT only to owner/admin members). Acceptance is
-- therefore definer-only: the caller presents the raw token, the function
-- hashes it (sha256 hex — the table stores only token_hash), verifies the
-- invitation is live, and verifies the caller's VERIFIED account email
-- (auth.users.email, written by Supabase Auth — never raw_user_meta_data)
-- matches the invited email before creating the membership.
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor UUID := (SELECT auth.uid());
  v_token_hash TEXT;
  v_invitation public.workspace_invitations%ROWTYPE;
  v_caller_email TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_token IS NULL OR length(btrim(p_token)) = 0 THEN
    RAISE EXCEPTION 'invitation token is required';
  END IF;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  SELECT * INTO v_invitation
  FROM public.workspace_invitations
  WHERE token_hash = v_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not found';
  END IF;
  IF v_invitation.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation already accepted';
  END IF;
  IF v_invitation.expires_at <= NOW() THEN
    RAISE EXCEPTION 'invitation expired';
  END IF;
  -- Defence in depth: the table CHECK already forbids role = 'owner'.
  IF v_invitation.role = 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'invitation role is not acceptable';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = v_actor;
  IF v_caller_email IS NULL
     OR lower(btrim(v_caller_email)) <> lower(btrim(v_invitation.email)) THEN
    RAISE EXCEPTION 'invitation email does not match the signed-in account';
  END IF;

  -- PK (workspace_id, user_id) protects against duplicates if the invitee
  -- is already a member (e.g. via a second invitation): accept succeeds
  -- without duplicating or changing the existing membership.
  INSERT INTO public.workspace_memberships (workspace_id, user_id, role, invited_by)
  VALUES (v_invitation.workspace_id, v_actor, v_invitation.role, v_invitation.invited_by)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  UPDATE public.workspace_invitations
  SET accepted_at = NOW()
  WHERE id = v_invitation.id;

  RETURN v_invitation.workspace_id;
END;
$$;
REVOKE ALL ON FUNCTION public.accept_workspace_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation(TEXT) TO authenticated, service_role;

-- ── change_member_role ─────────────────────────────────────────────────────
-- Rules: actor must be owner or admin of the workspace; only an owner may
-- grant the 'owner' role; an admin may not modify an owner's role; a
-- non-owner may not change their own role; LAST-OWNER GUARD — the
-- workspace's only owner cannot be demoted (including by themselves).
CREATE OR REPLACE FUNCTION public.change_member_role(
  p_workspace_id UUID,
  p_target_user_id UUID,
  p_new_role public.workspace_role
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor UUID := (SELECT auth.uid());
  v_actor_role public.workspace_role;
  v_target_role public.workspace_role;
  v_owner_count BIGINT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_workspace_id IS NULL OR p_target_user_id IS NULL OR p_new_role IS NULL THEN
    RAISE EXCEPTION 'workspace, target user and new role are required';
  END IF;

  SELECT role INTO v_actor_role FROM public.workspace_memberships
  WHERE workspace_id = p_workspace_id AND user_id = v_actor;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'actor is not a member of this workspace';
  END IF;
  IF v_actor_role NOT IN ('owner'::public.workspace_role, 'admin'::public.workspace_role) THEN
    RAISE EXCEPTION 'only an owner or admin may change member roles';
  END IF;

  SELECT role INTO v_target_role FROM public.workspace_memberships
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'target user is not a member of this workspace';
  END IF;

  IF p_new_role = 'owner'::public.workspace_role
     AND v_actor_role <> 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'only an owner may grant the owner role';
  END IF;
  IF v_target_role = 'owner'::public.workspace_role
     AND v_actor_role <> 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'an admin may not modify an owner''s role';
  END IF;
  IF p_target_user_id = v_actor
     AND v_actor_role <> 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'members cannot change their own role';
  END IF;

  -- LAST-OWNER GUARD (also covers sole-owner self-demotion).
  IF v_target_role = 'owner'::public.workspace_role
     AND p_new_role <> 'owner'::public.workspace_role THEN
    SELECT count(*) INTO v_owner_count FROM public.workspace_memberships
    WHERE workspace_id = p_workspace_id AND role = 'owner'::public.workspace_role;
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'cannot demote the last owner of a workspace';
    END IF;
  END IF;

  UPDATE public.workspace_memberships
  SET role = p_new_role
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.change_member_role(UUID, UUID, public.workspace_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_member_role(UUID, UUID, public.workspace_role) TO authenticated, service_role;

-- ── remove_member ──────────────────────────────────────────────────────────
-- Rules: actor must be owner/admin of the workspace OR the target
-- themselves (leaving); an admin may not remove an owner; LAST-OWNER
-- GUARD — the workspace's only owner cannot be removed, even by
-- themselves (they must transfer ownership or delete the workspace).
CREATE OR REPLACE FUNCTION public.remove_member(
  p_workspace_id UUID,
  p_target_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor UUID := (SELECT auth.uid());
  v_actor_role public.workspace_role;
  v_target_role public.workspace_role;
  v_owner_count BIGINT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_workspace_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'workspace and target user are required';
  END IF;

  SELECT role INTO v_target_role FROM public.workspace_memberships
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'target user is not a member of this workspace';
  END IF;

  IF p_target_user_id <> v_actor THEN
    SELECT role INTO v_actor_role FROM public.workspace_memberships
    WHERE workspace_id = p_workspace_id AND user_id = v_actor;
    IF v_actor_role IS NULL
       OR v_actor_role NOT IN ('owner'::public.workspace_role, 'admin'::public.workspace_role) THEN
      RAISE EXCEPTION 'only an owner or admin may remove another member';
    END IF;
    IF v_target_role = 'owner'::public.workspace_role
       AND v_actor_role <> 'owner'::public.workspace_role THEN
      RAISE EXCEPTION 'an admin may not remove an owner';
    END IF;
  END IF;

  -- LAST-OWNER GUARD (applies to self-removal too).
  IF v_target_role = 'owner'::public.workspace_role THEN
    SELECT count(*) INTO v_owner_count FROM public.workspace_memberships
    WHERE workspace_id = p_workspace_id AND role = 'owner'::public.workspace_role;
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'cannot remove the last owner of a workspace; transfer ownership or delete the workspace instead';
    END IF;
  END IF;

  DELETE FROM public.workspace_memberships
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.remove_member(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_member(UUID, UUID) TO authenticated, service_role;
