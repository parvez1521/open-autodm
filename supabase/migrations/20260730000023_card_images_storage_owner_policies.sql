-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 10.4 (Workstream D) — S-08: card-images storage policy hardening.
--
-- Ownership model (proven from source, see phase10.4-scratch-D-storage.md):
-- the ONLY storage write path in the codebase is processCardImages() in
-- src/hooks/useAutomations.ts, which uploads through the browser client
-- (anon key + user session => Postgres role `authenticated`) to the path
--   `${session.user.id}/${Date.now()}-${random}.${ext}`
-- i.e. the first folder of EVERY authenticated write is the uploader's
-- auth user id (auth.uid()). No service-role code touches storage, no
-- code path calls storage .remove(), and uploads use upsert:false.
--
-- State this migration fixes (after …000001 + …000010):
--   INSERT "Auth users upload card images"  — bucket-wide: ANY authenticated
--     user could INSERT under ANY path, including another user's folder.
--   UPDATE — no policy existed, so authenticated UPDATE was deny-all.
--     An owner-scoped UPDATE policy is added so the posture is explicit
--     and a future upsert to the owner's OWN folder works, while a
--     cross-user overwrite stays impossible.
--   DELETE — …000010 already restricted deletion to the uploading owner
--     via the server-set owner/owner_id columns. It is re-expressed here
--     with the same folder predicate as INSERT/UPDATE so all three write
--     verbs share ONE canonical ownership rule. This is equivalent for
--     every object the app can create (under the tightened INSERT policy
--     an object can only land in a folder by that folder's owner or by
--     the service role) and strictly better for service-role-copied
--     objects sitting in a user's folder (owner column NULL there).
--
-- Deliberately UNCHANGED:
--   SELECT "Public read card images" (TO public) — required: Meta fetches
--     the public card-image URLs server-side; the bucket is public-read
--     by design (…000001, bucket public = true).
--   service_role — bypasses RLS entirely; no policy is needed or added,
--     so admin/service operations are unaffected.
--   …000010 §1 (app_settings.owner_user_id) — untouched.
--
-- Re-runnable: every statement is DROP POLICY IF EXISTS + CREATE POLICY.
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. INSERT: owner folder only ───────────────────────────────────────────
DROP POLICY IF EXISTS "Auth users upload card images" ON storage.objects;
DROP POLICY IF EXISTS "Auth users upload own card images" ON storage.objects;

CREATE POLICY "Auth users upload own card images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'card-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- ── 2. UPDATE: owner folder only (USING + WITH CHECK, so an update can ────
-- ── neither touch another user's object nor move an object out of the ────
-- ── owner's own folder) ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Auth users update own card images" ON storage.objects;

CREATE POLICY "Auth users update own card images"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'card-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'card-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- ── 3. DELETE: owner folder only (supersedes …000010 §2's owner-column ─────
-- ── predicate with the canonical folder predicate; same policy name) ──────
DROP POLICY IF EXISTS "Auth users delete card images" ON storage.objects;
DROP POLICY IF EXISTS "Auth users delete own card images" ON storage.objects;

CREATE POLICY "Auth users delete own card images"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'card-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
