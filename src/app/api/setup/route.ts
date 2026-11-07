/**
 * Setup Wizard API.
 *
 * GET  → current setup status + the exact values to paste into the Meta portal
 *        (webhook URL, verify token, OAuth redirect URI, pg_cron snippet).
 * POST → save Meta App ID + App Secret (secret is AES-256-GCM encrypted
 *        before it touches the DB). Generates a webhook verify token on
 *        first save and PRESERVES it on later saves so Meta's existing
 *        webhook subscription keeps validating.
 *
 * OWNER GUARD (security audit finding #12): while setup is incomplete, any
 * authenticated user may complete it (first run). Once setup_completed is
 * true, only the instance owner (OWNER_USER_ID / OWNER_EMAIL - see
 * src/lib/owner.ts) may POST changes, and the live webhook verify token is
 * only returned to the owner. When no owner is configured the guard fails
 * closed: a completed setup cannot be modified through this API at all.
 */

import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { getMetaSettings, saveMetaSettings } from '@/lib/settings';
import { isInstanceOwner } from '@/lib/owner';
import { randomToken } from '@/lib/crypto';
import { getAppUrl, getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SaveSetupSchema = z.object({
  metaAppId: z.string().regex(/^\d{5,25}$/, 'Meta App ID must be numeric'),
  metaAppSecret: z.string().regex(/^[0-9a-f]{32}$/i, 'Meta App Secret must be 32 hex characters'),
  // Optional: some Meta apps sign webhooks with the Facebook app secret.
  metaFbAppSecret: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'Facebook App Secret must be 32 hex characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

function cronSnippet(appUrl: string): string {
  return `-- Run this ONCE in your Supabase project's SQL Editor.
-- It makes Supabase call your deployment every minute to process
-- queued/delayed DM jobs and auto-refresh Instagram tokens.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'open-autodm-process-jobs',
  '* * * * *',
  $$
  select net.http_post(
    url := '${appUrl}/api/cron/process-jobs',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET'),
    timeout_milliseconds := 55000
  );
  $$
);`;
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const settings = await getMetaSettings();
  const appUrl = getAppUrl(request);

  // Read the raw row too - settings is null until fully configured, but a
  // partially-saved verify token should survive wizard re-entry.
  const db = createServiceClient();
  const { data: row } = await db
    .from('app_settings')
    .select('meta_app_id, webhook_verify_token, setup_completed')
    .eq('id', 1)
    .maybeSingle();

  // The verify token is a live credential for the webhook subscription.
  // Before setup completes it is part of the first-run wizard flow; after
  // completion only the instance owner may see it. Everyone else gets the
  // same response shape with the token redacted.
  const setupCompleted = (row?.setup_completed as boolean | null) ?? false;
  const maySeeToken = !setupCompleted || isInstanceOwner(user);

  return Response.json({
    configured: !!settings,
    metaAppId: (row?.meta_app_id as string | null) ?? null,
    webhookVerifyToken: maySeeToken ? ((row?.webhook_verify_token as string | null) ?? null) : null,
    webhookUrl: `${appUrl}/api/webhook`,
    oauthRedirectUri: `${appUrl}/api/instagram/callback`,
    appUrl,
    cronSnippet: cronSnippet(appUrl),
  });
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = SaveSetupSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return Response.json({ error: `Validation failed - ${detail}` }, { status: 400 });
  }

  try {
    // Ensure env is valid before accepting credentials (fail loudly, but with
    // the actual list of missing vars so the self-hoster can fix it).
    getEnv();

    // Preserve the existing verify token if one was generated before -
    // regenerating it would silently break the webhook registered in Meta.
    const db = createServiceClient();
    const { data: existing } = await db
      .from('app_settings')
      .select('webhook_verify_token, setup_completed')
      .eq('id', 1)
      .maybeSingle();

    // Owner guard: re-running setup overwrites the instance's Meta App ID
    // and secrets. Permitted during first run (setup not yet completed);
    // afterwards owner-only. Fails closed when no owner is configured -
    // isInstanceOwner() is then false for every caller.
    if (existing?.setup_completed && !isInstanceOwner(user)) {
      return Response.json(
        {
          error:
            'Setup is already complete - only the instance owner can change the Meta app configuration. ' +
            'If you are the owner, set OWNER_USER_ID or OWNER_EMAIL in the deployment environment to your account.',
        },
        { status: 403 }
      );
    }

    const verifyToken = (existing?.webhook_verify_token as string | null) ?? randomToken(16);

    await saveMetaSettings({
      metaAppId: parsed.data.metaAppId,
      metaAppSecret: parsed.data.metaAppSecret,
      metaFbAppSecret: parsed.data.metaFbAppSecret ?? null,
      webhookVerifyToken: verifyToken,
    });

    const appUrl = getAppUrl(request);
    return Response.json({
      success: true,
      webhookVerifyToken: verifyToken,
      webhookUrl: `${appUrl}/api/webhook`,
      oauthRedirectUri: `${appUrl}/api/instagram/callback`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The single most common self-hosting mistake: migrations not applied yet.
    if (/app_settings/i.test(message) && /(find|exist|schema)/i.test(message)) {
      return Response.json(
        {
          error:
            'Database schema is missing - the migrations have not been applied to your Supabase project. ' +
            'Run: supabase link --project-ref <your-ref> && supabase db push, then try again.',
        },
        { status: 500 }
      );
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
