/**
 * AI Generation Endpoint — DRAFTING ONLY (Phase 7).
 *
 * Provides on-demand, owner-authored drafting for the automation builder:
 *  - 5 Opening DM variations
 *  - 5 Public comment replies
 *  - DM response draft
 *  - Follow-up message draft
 *
 * Uses Cloudflare Workers AI free tier with automatic fallback.
 * Restored from release-prep (origin/opendm-release-prep,
 * src/app/api/ai/generate/route.ts) with the fixes in
 * phase6-ai-mixed-proposal.md §2:
 *  - F-2: the response_draft action logs feature 'response_draft' (release-prep
 *    logged the misleading 'runtime_response').
 *  - F-3: usage-log inserts go through logAiUsage(), which checks the
 *    returned { error } (Supabase's client reports failures there, it does
 *    not throw) and warns instead of failing silently. Logging stays
 *    best-effort: a failed insert never fails the generation request.
 *  - F-4: owner-only gate via isInstanceOwner() — fail-closed when no owner
 *    is configured. Release-prep required only any authenticated user.
 *  - F-6 (deliberate non-fix): prompt_tokens / completion_tokens stay NULL.
 *
 * Strictly requires an authenticated OWNER session. No audience data ever
 * reaches this endpoint: inputs are the owner's own prompt, post caption,
 * automation name, and username only. AI public replies and AI runtime DM
 * responses are NOT part of this endpoint and must not be added here.
 */

import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { isInstanceOwner } from '@/lib/owner';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import {
  generateOpeningVariations,
  generatePublicReplies,
  generateResponseDraft,
  generateFollowUpDraft,
  DEFAULT_AI_MODEL,
} from '@/lib/ai/workersAi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:ai:generate');

const RequestSchema = z.object({
  action: z.enum(['opening_variations', 'public_replies', 'response_draft', 'follow_up_draft']).optional(),
  type: z.string().optional(),
  prompt: z.string().max(1000).optional().default(''),
  postCaption: z.string().max(1000).optional(),
  creatorUsername: z.string().max(100).optional(),
  automationName: z.string().max(200).optional(),
  count: z.number().int().min(1).max(10).optional().default(5),
  mode: z.enum(['custom', 'auto']).optional().default('auto'),
});

type AiUsageFeature =
  | 'opening_variations'
  | 'public_reply_draft'
  | 'response_draft'
  | 'follow_up_draft';

/**
 * Best-effort usage logging (F-3). Checks the returned { error } — the
 * Supabase JS client does not throw on insert failures — and warns on
 * either path. Never throws, never fails the caller's generation request.
 * The row carries only { user_id, feature, model, status }: no prompt,
 * caption, or generated text is ever written to the log.
 */
/**
 * Owner-wide daily drafting ceiling (Phase 10.4 §8 — the S-09 response for
 * this endpoint). Drafting is owner-only (F-4), so a PER-USER quota is the
 * wrong control: the only person who can spend here is the owner, against
 * their own shared Workers AI allowance. This optional ceiling caps the
 * owner's own drafting requests per UTC day, counted from ai_usage_log
 * rows (one row per served drafting request — see logAiUsage below).
 *
 * Deliberately conservative semantics:
 *  - Configured ONLY via AI_DRAFTING_DAILY_LIMIT. Unset, blank, non-numeric
 *    or ≤ 0 means OFF — today's behaviour is preserved exactly and the
 *    count query is never issued.
 *  - SOFT ceiling: the count is read before generation and the usage row
 *    is written after, so concurrent requests can race past it by a small
 *    margin, and a failed usage-log insert undercounts. It is a cost
 *    guardrail, not a billing-grade quota and not a security boundary.
 *  - FAIL-OPEN: if the count query errors, the request proceeds and a
 *    warning is logged — a broken counter must never silently disable an
 *    owner-approved feature.
 *  - When the ceiling is reached the request is refused with 429 BEFORE
 *    any provider call, and no usage row is written for the refusal (the
 *    usage log's status CHECK has no "blocked" value; the refusal is
 *    recorded in the structured log instead, metadata only).
 */
function parseDraftingDailyLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100_000) return null;
  return n;
}

async function countTodaysDraftingRequests(userId: string): Promise<number> {
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const db = createServiceClient();
  const { count, error } = await db
    .from('ai_usage_log')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', startOfUtcDay.toISOString());
  if (error) throw error;
  return count ?? 0;
}

/**
 * Phase D1 (B9, minimal + safe): workspace attribution for a usage row.
 * Resolves ONLY when the user has exactly one workspace membership —
 * the unambiguous case. Zero or multiple memberships, a missing table
 * (pre-tenancy deployments), or any lookup failure all yield null, and
 * the caller then writes the row exactly as before (no workspace_id key
 * at all). Wrapped so attribution can NEVER fail — or even delay-fail —
 * the generation request, mirroring the soft-ceiling style above.
 */
async function resolveSingleWorkspaceId(userId: string): Promise<string | null> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from('workspace_memberships')
      .select('workspace_id')
      .eq('user_id', userId);
    if (error || !data || data.length !== 1) return null;
    const workspaceId = (data[0] as { workspace_id?: unknown }).workspace_id;
    return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null;
  } catch {
    return null;
  }
}

async function logAiUsage(
  userId: string,
  feature: AiUsageFeature,
  model: string,
  status: 'success' | 'fallback'
): Promise<void> {
  try {
    const db = createServiceClient();
    const workspaceId = await resolveSingleWorkspaceId(userId);
    const { error } = await db.from('ai_usage_log').insert({
      user_id: userId,
      feature,
      model,
      status,
      // Only present when attribution is unambiguous, so legacy rows
      // (and pre-…000032 stores) are written exactly as before.
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    });
    if (error) {
      logger.warn({ err: error }, 'Failed to record AI usage log');
    }
  } catch (e: unknown) {
    logger.warn({ err: e }, 'Failed to record AI usage log');
  }
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  // F-4: owner-only, fail-closed. When no owner is configured,
  // isInstanceOwner() is false for everyone and drafting is unavailable.
  if (!isInstanceOwner(user)) {
    return Response.json(
      { error: 'Forbidden', message: 'AI drafting is available only to the instance owner' },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 });
  }

  let action = parsed.data.action;
  if (!action && parsed.data.type) {
    if (parsed.data.type === 'public_replies' || parsed.data.type === 'public_reply' || parsed.data.type === 'comment_reply_options') {
      action = 'public_replies';
    } else if (parsed.data.type === 'opening_variations') {
      action = 'opening_variations';
    } else if (parsed.data.type === 'response_draft') {
      action = 'response_draft';
    } else if (parsed.data.type === 'follow_up_draft') {
      action = 'follow_up_draft';
    }
  }

  if (!action) {
    return Response.json({ error: 'Validation failed: action or supported type required' }, { status: 400 });
  }

  const { prompt, postCaption, creatorUsername, automationName, count } = parsed.data;

  // Phase 10.4 §8: optional owner-wide daily ceiling (see
  // parseDraftingDailyLimit). Runs after auth + owner gate + validation, so
  // non-owners still get 403 first and malformed requests still get 400.
  const dailyLimit = parseDraftingDailyLimit(process.env['AI_DRAFTING_DAILY_LIMIT']);
  if (dailyLimit !== null) {
    let usedToday: number | null = null;
    try {
      usedToday = await countTodaysDraftingRequests(user.id);
    } catch (e: unknown) {
      logger.warn({ err: e }, 'AI drafting ceiling check failed - allowing request (soft ceiling)');
    }
    if (usedToday !== null && usedToday >= dailyLimit) {
      logger.warn(
        { userId: user.id, limit: dailyLimit, usedToday },
        'AI drafting daily limit reached - request refused before generation'
      );
      return Response.json(
        {
          error: 'AI drafting daily limit reached',
          message: `This instance has reached its configured limit of ${dailyLimit} AI drafting requests for today (UTC). Try again tomorrow, or raise AI_DRAFTING_DAILY_LIMIT.`,
          limit: dailyLimit,
        },
        { status: 429 }
      );
    }
  }

  try {
    if (action === 'opening_variations') {
      const result = await generateOpeningVariations(prompt, count, {
        postCaption,
        creatorUsername,
        automationName,
      });

      await logAiUsage(user.id, 'opening_variations', result.model, result.status);

      return Response.json({
        success: true,
        variations: result.data,
        status: result.status,
        model: result.model,
      });
    }

    if (action === 'public_replies') {
      const result = await generatePublicReplies(prompt, count);

      await logAiUsage(user.id, 'public_reply_draft', result.model, result.status);

      if (result.status === 'fallback') {
        return Response.json(
          {
            success: false,
            error: 'AI generation is currently unavailable. Cloudflare Workers AI binding is not connected or quota is exceeded. Please use the predefined templates or try again later.',
            status: 'fallback',
          },
          { status: 503 }
        );
      }

      return Response.json({
        success: true,
        variations: result.data,
        options: result.data,
        status: 'success',
        model: result.model,
      });
    }

    if (action === 'response_draft') {
      const result = await generateResponseDraft(prompt, {
        postCaption,
        creatorUsername,
        automationName,
      });

      // F-2: logged under the truthful drafting feature name, not
      // release-prep's misleading 'runtime_response'.
      await logAiUsage(user.id, 'response_draft', result.model, result.status);

      return Response.json({
        success: true,
        draft: result.data,
        status: result.status,
        model: result.model,
      });
    }

    if (action === 'follow_up_draft') {
      const result = await generateFollowUpDraft(prompt, {
        automationName,
        creatorUsername,
      });

      await logAiUsage(user.id, 'follow_up_draft', result.model, result.status);

      return Response.json({
        success: true,
        draft: result.data,
        status: result.status,
        model: result.model,
      });
    }

    return Response.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (err) {
    logger.error({ err }, 'Error handling AI generate request');
    return Response.json({ error: 'Failed to generate AI content' }, { status: 500 });
  }
}
