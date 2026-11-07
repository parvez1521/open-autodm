-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 (Workstream 2) — DB hardening parity (row 31).
--
-- Ported from release-prep 20261028144658_tighten_public_default_privileges.sql, reviewed individually.
-- Production already has this (RP applied it); this file exists for
-- fresh-install parity and is idempotent-safe.
-- FILE ONLY — never applied by the readiness work.
-- ═══════════════════════════════════════════════════════════════════════════

-- Remove residual legacy default privileges on future public-schema objects.
--
-- The Data API migration revoked CRUD but older projects can also carry default
-- MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, or sequence UPDATE privileges for
-- client roles. Clear all default privileges, then re-add only what the
-- server-side service client needs. Existing objects are not affected.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;
