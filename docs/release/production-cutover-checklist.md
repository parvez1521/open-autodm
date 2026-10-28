# Open AutoDM Production Cutover Checklist

Status: **planning only**. This document records the release sequence; it does not authorize or perform a production change. The production database and Worker have not been modified by this release-prep pass.

## Verified state (2026-10-28)

- Release-prep CI run #59 passed unit tests, TypeScript, production build, and desktop/mobile browser QA.
- The staging database has the release-prep migrations applied and verified. The staging `pg_net` extension is in `extensions`; the scheduled staging cron is active and its latest run succeeded.
- The production migration ledger still ends at `20260731000009`. Eight release-prep migrations remain unapplied there.
- Production has no `pg_cron` or `pg_net` extension and no `cron.job` table. Its Cloudflare Worker currently has no Cron Triggers configured. The repo's `vercel.json` daily cron applies only to a Vercel deployment, and no Open AutoDM Vercel project was found in the connected Vercel team.
- The production Security Advisor reports seven `SECURITY DEFINER` functions executable by `anon`, ten executable by `authenticated`, and a mutable search path on `public.handle_updated_at()`. It also reports leaked-password protection disabled.
- At the last read-only workload check there was one active Instagram account, but zero active automations, zero queued/processing DM jobs, zero pending/processing internal jobs, zero scheduled/sending follow-ups, and zero reserved comment replies. Re-check these counts in the actual maintenance window; they can change.
- No production secrets were retrieved or changed. Do not copy secret values into this file, a PR, an issue, or chat.

## Release blockers

Do not merge or schedule live processing until all of the following have an owner and pass:

1. Review the eight SQL migrations below against the exact deployed application commit and approve a production maintenance window.
2. Take/verify a restorable production backup or point-in-time recovery option. Save the current migration ledger, Security Advisor output, relevant function ACLs, extension state, and workload counts.
3. Coordinate the same strong random `CRON_SECRET` value between the production Cloudflare Worker secret and Supabase Vault. Cloudflare does not return a secret's value on read, so do not assume the two values match merely because both bindings exist.
4. Apply the migrations, then verify privileges, the trigger function search path, extension schemas, and Security Advisor results before enabling the production schedule.
5. Create exactly one production job named `open-autodm-process-jobs` only after the operator authorizes periodic processing. This endpoint can process queued jobs, refresh live Instagram tokens, and clean up rows; it must not be manually called with valid credentials as a casual smoke test.
6. Complete the real Meta OAuth consent/callback flow and a valid signed webhook event on staging with a dedicated test Instagram account. Unit tests cover valid/invalid HMAC signatures but are not a substitute for Meta's live round-trip.
7. Enable leaked-password protection where the project's plan supports it, then rerun the Security Advisor. Do not automatically upgrade the plan.

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
