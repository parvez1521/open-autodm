# Open AutoDM Production Cutover Checklist

Status: **planning only**. This document records the release sequence; it does not authorize or perform a production change. The production database and Worker have not been modified by this release-prep pass.

## Preflight snapshot

Before using this runbook, re-check the actual target project's migration history, project plan, Security Advisor, extension locations, cron jobs, workload counts, and the exact application deployment. Staging observations do not prove production is in the same state. Keep raw ACL output and detailed live security findings in a private operator record, not in this public repository.

## Read-only SQL preflight and postflight

Run these queries separately against the exact target Supabase project before and after the migration window. They are **read-only**. Do not combine them with the operator's mutating migration or scheduling commands. A missing expected function or any unexpected grant is a stop condition until explained.

### 1. Verify extension placement and any existing processor schedule

```sql
SELECT e.extname, n.nspname AS extension_schema, e.extversion
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname IN ('pg_cron', 'pg_net')
ORDER BY e.extname;

-- Safe before and after migration: these return NULL when the relation is absent.
SELECT to_regclass('cron.job') AS cron_job_catalog,
       to_regclass('net.http_request_queue') AS pg_net_request_queue;

-- Only run the following cron.job queries if cron_job_catalog above is non-NULL.
-- Read only the app's expected processor job; do not print unrelated job commands.
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'open-autodm-process-jobs';

-- Inspect recent executions; a SQL success does not alone prove the HTTP response was successful.
SELECT d.jobid, j.jobname, d.status, d.return_message, d.start_time, d.end_time
FROM cron.job_run_details d
JOIN cron.job j USING (jobid)
WHERE j.jobname = 'open-autodm-process-jobs'
ORDER BY d.start_time DESC
LIMIT 10;

-- Only run this count if pg_net_request_queue above is non-NULL.
SELECT count(*) AS queued_http_requests
FROM net.http_request_queue;
```

Before moving `pg_net`, its request queue must be empty and all cron jobs that call `net.http_*` must be paused with their in-flight runs finished. The guarded migration aborts if these conditions are not met. Do not use a live `CRON_SECRET` for an ad hoc smoke test.

### 2. Verify exact privileged-function ACLs

The migrations restrict these functions to `service_role`. Run this query before and after migration to check every required signature and role grant:

```sql
WITH expected(signature) AS (
  VALUES
    ('public.check_and_record_dm_rate_limit(uuid,integer)'),
    ('public.claim_due_jobs(integer)'),
    ('public.cleanup_old_rows()'),
    ('public.increment_automation_dms_sent(uuid)'),
    ('public.record_contact_interaction(uuid,text,text,text,uuid)'),
    ('public.update_contact_profile(uuid,text,text,boolean)'),
    ('public.handle_new_user()'),
    ('public.get_traffic_guard_status(uuid)'),
    ('public.traffic_guard_pause_account(uuid,uuid)'),
    ('public.traffic_guard_resume_account(uuid,uuid)')
),
resolved AS (
  SELECT signature, to_regprocedure(signature) AS fn
  FROM expected
)
SELECT
  signature,
  fn IS NOT NULL AS exists,
  CASE WHEN fn IS NOT NULL THEN has_function_privilege('anon', fn, 'EXECUTE') END AS anon_execute,
  CASE WHEN fn IS NOT NULL THEN has_function_privilege('authenticated', fn, 'EXECUTE') END AS authenticated_execute,
  CASE WHEN fn IS NOT NULL THEN has_function_privilege('service_role', fn, 'EXECUTE') END AS service_role_execute
FROM resolved
ORDER BY signature;
```

For these backend-only functions, expected postflight is: all signatures exist, `anon_execute = false`, `authenticated_execute = false`, and `service_role_execute = true`. Any deviation blocks the cutover.

Check the trigger helper's pinned search path separately:

```sql
SELECT p.oid::regprocedure AS function_name, p.proconfig
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.handle_updated_at()');
```

### 3. Verify existing table grants and future-object defaults

```sql
-- Inspect current direct table rights for client roles.
SELECT table_name, grantee,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;

-- Catch explicit table/sequence ACLs granted to PUBLIC as well.
SELECT n.nspname AS schema_name, c.relname AS object_name,
       CASE c.relkind
         WHEN 'r' THEN 'table'
         WHEN 'p' THEN 'partitioned_table'
         WHEN 'v' THEN 'view'
         WHEN 'm' THEN 'materialized_view'
         WHEN 'f' THEN 'foreign_table'
         WHEN 'S' THEN 'sequence'
         ELSE c.relkind::text
       END AS object_type,
       a.privilege_type, a.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
WHERE n.nspname = 'public'
  AND a.grantee = 0
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
ORDER BY object_type, object_name, privilege_type;

-- Inspect defaults for objects created by the postgres migration owner.
SELECT d.defaclrole::regrole::text AS owner_role,
       COALESCE(n.nspname, '<global>') AS schema_name,
       d.defaclobjtype AS object_type,
       d.defaclacl::text AS default_acl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
  AND (d.defaclnamespace = 0 OR n.nspname = 'public')
ORDER BY schema_name, object_type;
```

Postflight expectations: `anon` has no direct table privileges; `authenticated` has only the deliberately retained grants for tables covered by intended owner-scoped RLS policies; the service-only tables (including `app_settings`, `debug_events`, `job_queue`, `dm_rate_events`, and `comment_traffic_events`) have no direct client grants. In the `postgres` default ACL for `public`, `anon` and `authenticated` must not appear; only the owner and intentionally granted `service_role` rights should remain. Any unexpected grant blocks cutover. In the explicit `PUBLIC` table/view/sequence ACL query, postflight should return zero rows. Do not treat RLS as a mitigation for broad `TRUNCATE` or `REFERENCES` rights: PostgreSQL documents that these whole-table privileges are not subject to row-security policies ([PostgreSQL 17 RLS documentation](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)). Any client `TRUNCATE`/`REFERENCES` grant is a hard stop until removed or explicitly justified.

Postflight should show an empty search path configuration (`search_path=""`). Rerun Security Advisor and retain the full output in the private operator record.


Check the current draft PR for the latest CI run before each cutover attempt; never treat a historical green run as validation of a newer commit. Staging release-prep migrations and the `pg_net` relocation have been verified. A live staging invalid-HMAC request returned 403 and an unauthenticated cron request returned 401; post-probe checks showed no webhook debug writes, no queued/processing work, and an empty HTTP request queue. No production secrets were retrieved or changed.

## Release blockers

Do not merge or schedule live processing until all of the following have an owner and pass:

1. Review the eight SQL migrations below against the exact deployed application commit, determine which versions are actually missing in the target environment, and approve a production maintenance window.
2. Take/verify a restorable production backup or point-in-time recovery option. Save the current migration ledger, Security Advisor output, relevant function ACLs, extension state, scheduler state, and non-sensitive workload counts in the private operator record.
3. Coordinate the same strong random `CRON_SECRET` value between the production Cloudflare Worker secret and Supabase Vault. Cloudflare does not return a secret's value on read, so do not assume the two values match merely because both bindings exist.
4. Apply the migrations, then verify privileges, the trigger function search path, extension schemas, and Security Advisor results before enabling the production schedule.
5. Create exactly one production job named `open-autodm-process-jobs` only after the operator authorizes periodic processing. This endpoint can process queued jobs, refresh live Instagram tokens, and clean up rows; it must not be manually called with valid credentials as a casual smoke test.
6. Complete the real Meta OAuth consent/callback flow and a valid signed webhook event on staging with a dedicated test Instagram account. Unit tests cover valid/invalid HMAC signatures but are not a substitute for Meta's live round-trip.
7. Enable leaked-password protection if the target plan supports it, or record the explicit risk acceptance/upgrade decision. Then rerun the Security Advisor. Do not automatically upgrade the plan.

## Migration order

Apply these eight existing migration files in timestamp order. Do not edit or skip historical migrations just to make the ledger look aligned.

1. `20261028121508_restrict_service_role_rpcs.sql`
2. `20261028121634_enable_staging_cron_extensions.sql`
3. `20261028122007_pin_updated_at_search_path.sql`
4. `20261028144525_harden_traffic_guard_rpcs.sql`
5. `20261028144612_service_role_data_api_grants.sql`
6. `20261028144658_tighten_public_default_privileges.sql`
7. `20261028145034_restrict_legacy_object_grants.sql`
8. `20261028145957_move_pg_net_to_extensions.sql`

Important notes:

- The extension migration deliberately creates `pg_cron` and `pg_net` first; the final guarded migration moves `pg_net` out of `public`. The last migration aborts if an active cron job calls `net.http_*`, a matching cron run is in flight, or the request queue is non-empty.
- `DROP EXTENSION pg_net` recreates extension-owned queue/response tables. It is only acceptable after confirming the request queue is empty and the short-lived response diagnostics are not needed. Never run it manually outside the guarded migration.
- The migrations revoke public/client execution of privileged functions and narrow existing grants. If the deployed app contains unreviewed direct client calls to the Data API, these grants can break them. Verify the application commit and perform a focused smoke test before proceeding.
- Do not run `supabase db push` until the CLI is explicitly linked to the production project and the dry-run's exact migration list has been reviewed. A staging link is not a production link.

## Production cron setup (operator runbook; do not run until authorized)

The expected scheduler is Supabase Cron + `pg_net`; the repo's Vercel schedule is not active on the current Cloudflare deployment.

### 1. Store the matching secret in Supabase Vault

Create a strong random secret via a secure operator workflow and set the exact same value as the Cloudflare Worker `CRON_SECRET` binding. Store it in Vault with this name:

`open_autodm_production_cron_secret`

Vault encrypts secrets at rest, and `vault.decrypted_secrets` exposes them to SQL that is authorized to read it. Do not print the decrypted value. Official reference: https://supabase.com/docs/guides/database/vault

### 2. Inspect before creating the job

After migrations, verify `pg_cron` exists, `pg_net` is installed in `extensions`, and there is no existing job with the name `open-autodm-process-jobs`. Review its schedule and command if one exists; do not create a duplicate.

### 3. Create the schedule once, after approval

The SQL below is a template only. Verify the production app URL and Vault secret name first. It must be run once by the production database owner after the migration checks and live-processing approval:

```sql
select cron.schedule(
  'open-autodm-process-jobs',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://app.opendm.in/api/cron/process-jobs',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'open_autodm_production_cron_secret'
          limit 1
        )
      ),
      timeout_milliseconds := 55000
    );
  $job$
);
```

This must not be added as an automatic data migration: enabling it can begin processing real queued jobs immediately. Do not invoke the endpoint manually using a valid secret just to see whether it works.

### 4. Verify the schedule and endpoint response

- Confirm exactly one active job named `open-autodm-process-jobs` on `* * * * *`.
- Read `cron.job_run_details` for recent successful runs.
- Check recent `net._http_response` rows for HTTP 200, no timeout, and an `ok: true` payload. A successful `cron.job_run_details` row only shows that the SQL command ran; it does not alone prove the HTTP endpoint succeeded.
- Confirm `net.http_request_queue` is empty after requests complete.
- Re-run Security Advisor and verify client roles cannot execute the privileged SECURITY DEFINER RPCs.
- If verification fails, pause/unschedule the job and use the approved recovery plan; do not flood retries or manually drain real jobs.

Official Supabase scheduling reference: https://supabase.com/docs/guides/cron
Official `pg_net` reference: https://supabase.com/docs/guides/database/extensions/pg_net

## Final go/no-go

**No-go until** production migrations are deliberately applied and verified, the production cron secret is coordinated without exposing it, the scheduler is configured exactly once and returns successful endpoint responses, the Meta flow is tested on staging, and the remaining Auth/plan decision is recorded. A successful CI run alone does not authorize a merge, migration, or deployment.
