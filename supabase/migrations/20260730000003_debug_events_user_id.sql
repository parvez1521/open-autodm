-- ═══════════════════════════════════════════════════════════════════════════
-- open-autoDM - Per-user ownership for debug_events
--
-- debug_events was instance-global: it had no user column, GET
-- /api/debug/events returned the newest 200 events to ANY authenticated
-- user (metadata can contain other operators' account IDs, usernames and
-- error detail), and DELETE wiped the whole instance log (security audit
-- finding #6). This migration adds the ownership column the API now scopes
-- on:
--
--   * src/lib/debugLog.ts persists user_id whenever the caller context has
--     one (metadata.userId - e.g. the OAuth callback, webhook/job processing
--     for a known account, cron token refresh).
--   * GET returns only rows where user_id = the authenticated user; rows
--     with user_id NULL (system events with no derivable owner, e.g.
--     pre-auth webhook verification) are hidden from ordinary users.
--   * DELETE removes only the caller's own rows.
--
-- user_id is deliberately a plain UUID with NO foreign key: this is a log
-- table - a logging write must never fail because of an FK, and events must
-- survive operator-account removal (they age out via cleanup_old_rows(),
-- 7 days). Existing rows stay NULL and are therefore hidden by the new API
-- scoping, which is the intended privacy-preserving default.
--
-- RLS posture is unchanged: RLS stays enabled with NO user policies, so the
-- table remains service-role only and ownership is enforced in the API
-- layer, exactly like the rest of the service-role data path.
--
-- FILE ONLY - not applied to any database by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.debug_events
  ADD COLUMN user_id UUID;

COMMENT ON COLUMN public.debug_events.user_id IS
  'Owning operator (Supabase auth user id) when derivable at log time; NULL for system events with no user context. API reads/deletes are scoped to this column.';

-- Supports the panel query: newest events for one user.
CREATE INDEX debug_events_user_created_idx
  ON public.debug_events (user_id, created_at DESC);
