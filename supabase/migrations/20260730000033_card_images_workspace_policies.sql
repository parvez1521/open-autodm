-- ═══════════════════════════════════════════════════════════════════════════
-- Phase D2 / Programme 16 (productization COPY ONLY) — card-images
-- storage: workspace-prefix policies alongside the user-folder policies.
--
-- *** COPY-ONLY PRODUCTIZATION ARTIFACT — NOT part of the frozen
-- candidate's approved production apply-list. That list is UNCHANGED:
-- 000021 required; 000002/000003 conditional; 000022/000023
-- candidate-only; …000024–…000032 are copy-only artifacts.
-- This file (…000033) is likewise NOT on the frozen apply-list and must
-- never be applied to production under the release gates. ***
--
-- TRANSITION MODEL (dual-prefix window):
--   The ONLY live write path (processCardImages() in
--   src/hooks/useAutomations.ts) writes `<auth-user-id>/<file>` and is
--   governed by …000023's "Auth users … own card images" policies.
--   The SaaS build adds a second convention, `<workspace-id>/<file>`
--   (see src/lib/storage/cardImages.ts). PostgreSQL storage policies
--   are PERMISSIVE and OR together, so the workspace policies below are
--   purely ADDITIVE: a write is allowed when EITHER the legacy
--   user-folder rule OR a workspace rule holds. The …000023 policies
--   are NOT dropped or altered here — dropping them is a later,
--   separately-gated step after every writer has moved to workspace
--   prefixes. Until then both prefixes are valid by design.
--
-- WORKSPACE RULE (per verb):
--   The object's first folder segment must (a) parse as a UUID —
--   guarded by a strict UUID regex inside a CASE, so a non-UUID
--   segment yields a clean denial instead of a cast error — (b) name
--   an EXISTING public.workspaces row, and (c) satisfy the role check
--   against the caller's membership:
--     INSERT / UPDATE — has_workspace_role(seg, owner/admin/member)
--                       (viewers are read-only, per the Programme 16
--                       role table; mirrors …000032's write gating)
--     DELETE          — has_workspace_role(seg, owner/admin)
--                       (deletion is destructive; members cannot delete
--                       workspace card images)
--   SELECT is deliberately NOT touched: the bucket is public-read by
--   design ("Public read card images", TO public, since …000001)
--   because Meta fetches card-image URLs server-side. A workspace
--   SELECT policy would be redundant next to the public one.
--   service_role bypasses RLS entirely and is unaffected, as before.
--
-- COLUMN QUALIFICATION (load-bearing): every foldername() call below
-- is written storage.foldername(objects.name), NEVER bare `name`.
-- Inside the EXISTS subquery an unqualified `name` resolves to
-- public.workspaces.name (the workspace's display name) instead of
-- the storage object's path — foldername('WS-A')[1] is NULL, the
-- EXISTS would silently never hold, and every workspace write would
-- be denied. The Phase D rehearsal caught exactly this; the
-- qualification is what makes the policies function.
--
-- Re-runnable: every statement is DROP POLICY IF EXISTS + CREATE POLICY.
-- FILE ONLY — never applied by the productization work.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. INSERT: workspace members (owner/admin/member) may upload under ────
-- ── their workspace's prefix ───────────────────────────────────────────────
DROP POLICY IF EXISTS card_images_insert_workspace_member ON storage.objects;

CREATE POLICY card_images_insert_workspace_member
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'card-images'
    AND CASE
      WHEN (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN EXISTS (
             SELECT 1 FROM public.workspaces w
             WHERE w.id = ((storage.foldername(objects.name))[1])::uuid
           )
           AND public.has_workspace_role(
                 ((storage.foldername(objects.name))[1])::uuid,
                 ARRAY['owner','admin','member']::public.workspace_role[]
               )
      ELSE false
    END
  );

-- ── 2. UPDATE: same writable-role rule (USING + WITH CHECK, so an update ───
-- ── can neither touch another workspace's object nor move an object into ───
-- ── a workspace the caller cannot write to) ────────────────────────────────
DROP POLICY IF EXISTS card_images_update_workspace_member ON storage.objects;

CREATE POLICY card_images_update_workspace_member
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'card-images'
    AND CASE
      WHEN (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN EXISTS (
             SELECT 1 FROM public.workspaces w
             WHERE w.id = ((storage.foldername(objects.name))[1])::uuid
           )
           AND public.has_workspace_role(
                 ((storage.foldername(objects.name))[1])::uuid,
                 ARRAY['owner','admin','member']::public.workspace_role[]
               )
      ELSE false
    END
  )
  WITH CHECK (
    bucket_id = 'card-images'
    AND CASE
      WHEN (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN EXISTS (
             SELECT 1 FROM public.workspaces w
             WHERE w.id = ((storage.foldername(objects.name))[1])::uuid
           )
           AND public.has_workspace_role(
                 ((storage.foldername(objects.name))[1])::uuid,
                 ARRAY['owner','admin','member']::public.workspace_role[]
               )
      ELSE false
    END
  );

-- ── 3. DELETE: workspace owner/admin only ───────────────────────────────────
DROP POLICY IF EXISTS card_images_delete_workspace_admin ON storage.objects;

CREATE POLICY card_images_delete_workspace_admin
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'card-images'
    AND CASE
      WHEN (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN EXISTS (
             SELECT 1 FROM public.workspaces w
             WHERE w.id = ((storage.foldername(objects.name))[1])::uuid
           )
           AND public.has_workspace_role(
                 ((storage.foldername(objects.name))[1])::uuid,
                 ARRAY['owner','admin']::public.workspace_role[]
               )
      ELSE false
    END
  );
