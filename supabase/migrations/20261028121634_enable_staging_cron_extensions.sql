-- Ensure the extensions used by Open AutoDM's background job scheduler exist.
-- Idempotent: safe for fresh instances; existing extensions and their schemas
-- remain unchanged. The one-minute cron job itself is configured by the setup
-- wizard and is deliberately not created by this migration.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA public;
