/**
 * Background maintenance endpoint. Secured by CRON_SECRET.
 *
 * Called by:
 *  - Supabase pg_cron every minute (primary - the Setup Wizard generates the
 *    exact SQL snippet), and/or
 *  - Vercel daily cron (vercel.json) as a safety net.
 *
 * HEADER-ONLY auth (Phase 10.4, S-03): the secret is accepted ONLY as
 * `Authorization: Bearer <CRON_SECRET>`. The former `?secret=` query-param
 * fallback was removed — every in-repo caller already uses the header
 * (the setup-generated pg_cron snippet sends `Authorization: Bearer …`;
 * Vercel Cron presents CRON_SECRET as a Bearer header), and a secret in a
 * URL lands in access/proxy logs and browser history. The query string is
 * never consulted now, not even when the header is missing or malformed.
 *
 * Does three things:
 *  1. Drains due queue jobs (rate-limit overflow, retries, stuck jobs).
 *  2. Silently refreshes Instagram tokens expiring within 10 days.
 *  3. Housekeeping: prunes old debug events / rate events / finished jobs.
 */

import { processDueJobs } from '@/lib/automation/engine';
import { evaluateOpenIncidents } from '@/lib/trafficGuard/tracker';
import { sweepDueFollowUps } from '@/lib/automation/followUps';
import { createServiceClient } from '@/lib/supabase/service';
import { refreshLongLivedToken } from '@/lib/instagram/oauth';
import { decrypt, encrypt, safeCompare } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import type { InstagramAccountRow } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const logger = createLogger('cron');

function isAuthorized(request: Request): boolean {
  // Fail closed when CRON_SECRET is absent/invalid: getEnv() throws on a
  // missing or too-short secret — that must mean "nobody is authorized"
  // (401 from handle()), never an unhandled 500 and never an allow.
  let cronSecret: string;
  try {
    cronSecret = getEnv().CRON_SECRET;
  } catch {
    return false;
  }
  if (!cronSecret) return false;

  // Header-only: an exact `Bearer <token>` Authorization header. Any
  // other shape (missing header, non-Bearer scheme, empty token) is
  // rejected; the URL query string is deliberately never read (S-03).
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const provided = header.slice(7);
  // Constant-time comparison; the provided value is never logged or
  // returned (handle() answers a bare { error: 'Unauthorized' }).
  return provided.length > 0 && safeCompare(provided, cronSecret);
}

async function refreshExpiringTokens(): Promise<number> {
  const env = getEnv();
  const db = createServiceClient();
  const threshold = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();

  const { data: accounts } = await db
    .from('instagram_accounts')
    .select('*')
    .eq('is_active', true)
    .not('token_expires_at', 'is', null)
    .lt('token_expires_at', threshold);

  let refreshed = 0;
  for (const account of (accounts ?? []) as InstagramAccountRow[]) {
    // Skip already-expired tokens - Meta cannot refresh those; user must reconnect.
    if (account.token_expires_at && new Date(account.token_expires_at) < new Date()) continue;

    try {
      const current = decrypt(account.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
      const result = await refreshLongLivedToken(current);
      if ('error' in result) {
        debugLog('cron', 'warn', 'token_refresh', 'error',
          `Token refresh failed for @${account.username ?? account.id} (${result.error}, HTTP ${result.status})`,
          { accountId: account.id, userId: account.user_id });
        continue;
      }
      await db
        .from('instagram_accounts')
        .update({
          access_token_encrypted: encrypt(result.access_token, env.TOKEN_ENCRYPTION_KEY),
          token_expires_at: new Date(Date.now() + result.expires_in * 1000).toISOString(),
        })
        .eq('id', account.id);
      refreshed += 1;
      debugLog('cron', 'info', 'token_refresh', 'ok', `Token auto-refreshed for @${account.username ?? account.id}`, {
        accountId: account.id,
        userId: account.user_id,
        daysRemaining: Math.floor(result.expires_in / 86400),
      });
    } catch (err) {
      logger.warn({ err, accountId: account.id }, 'Token refresh attempt errored');
    }
  }
  return refreshed;
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const drain = await processDueJobs(25);
  const tokensRefreshed = await refreshExpiringTokens();

  // Traffic Guard: re-evaluate open high-traffic incidents so recovery is
  // detected even when no new comments arrive.
  const trafficIncidentsEvaluated = await evaluateOpenIncidents();

  // Scheduled follow-ups: re-enqueue send jobs for due rows whose original
  // enqueue was lost (dedupe keys make this a no-op when the job exists),
  // then drain again so freshly requeued follow-ups are not left waiting.
  const followUpsRequeued = await sweepDueFollowUps(25);
  const followUpDrain = followUpsRequeued > 0 ? await processDueJobs(25) : null;

  const db = createServiceClient();
  const { error: cleanupError } = await db.rpc('cleanup_old_rows');
  if (cleanupError) logger.warn({ err: cleanupError }, 'cleanup_old_rows failed');

  return Response.json({
    ok: true,
    jobs: drain,
    tokensRefreshed,
    trafficIncidentsEvaluated,
    followUpsRequeued,
    followUpJobs: followUpDrain,
    at: new Date().toISOString(),
  });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
