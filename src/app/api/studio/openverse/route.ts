/**
 * Creator Studio — Openverse stock audio endpoint (Programme S3).
 *
 * GET /api/studio/openverse?q=&page=
 *
 * Zero-cost contract (saas/STUDIO_FREE_PROVIDERS_RESEARCH.md):
 *  - Openverse is keyless, but the anonymous tier is 200 requests/day
 *    against one shared provider pool. Two guards apply: the per-user
 *    limiter, and a PER-INSTANCE daily cap of 180 (headroom under
 *    200) implemented in lib/studio/openverseQuota.ts — an in-memory
 *    counter in this server process, NOT a deployment-wide cap
 *    (Programme 34 terminology). Hitting the per-instance cap is an
 *    expected degradation → HTTP 200 with the shared-quota message.
 *  - The client locks `license_type=commercial` and post-filters every
 *    NC licence — see lib/studio/openverse.ts. Items keep their own
 *    per-item credit and licence link.
 */

import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { createPerUserRateLimiter } from "@/lib/studio/groq";
import { OpenverseError, createOpenverseClient } from "@/lib/studio/openverse";
import { createPerInstanceDailyCap } from "@/lib/studio/openverseQuota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:studio:openverse");

const SHARED_QUOTA_MESSAGE =
  "The free stock-audio quota is used up for today. The free tier is one small shared pool (about 200 requests a day), so search pauses until it resets. Try again tomorrow.";

// Module singletons: per-user guardrail + the per-instance daily guard.
const limiter = createPerUserRateLimiter({ perMinute: 10, perDay: 50 });
const perInstanceCap = createPerInstanceDailyCap({ cap: 180 });

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const qRaw = url.searchParams.get("q");
  const q = qRaw ? qRaw.trim() : "";
  if (q.length < 1 || q.length > 100) {
    return Response.json({ error: "q must be 1-100 characters" }, { status: 400 });
  }
  const pageRaw = url.searchParams.get("page");
  let page = 1;
  if (pageRaw !== null && pageRaw !== "") {
    const parsed = Number(pageRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return Response.json({ error: "page must be an integer 1-500" }, { status: 400 });
    }
    page = parsed;
  }

  if (!perInstanceCap.check()) {
    logger.warn({ userId: user.id }, "Studio Openverse search refused by per-instance daily cap");
    return Response.json({ ok: false, code: "quota_reached", message: SHARED_QUOTA_MESSAGE });
  }

  const refusal = limiter.check(user.id);
  if (refusal) {
    logger.warn({ userId: user.id, refusal }, "Studio Openverse request refused by per-user limiter");
    return Response.json({ ok: false, code: refusal }, { status: 429 });
  }
  limiter.record(user.id);
  perInstanceCap.record();

  try {
    const client = createOpenverseClient();
    const result = await client.searchAudio({ query: q, page });
    return Response.json({
      ok: true,
      provider: "openverse",
      providerUrl: "https://openverse.org",
      items: result.items,
      resultCount: result.resultCount,
      page: result.page,
      pageCount: result.pageCount,
    });
  } catch (err) {
    if (err instanceof OpenverseError) {
      logger.warn({ userId: user.id, code: err.code }, "Studio Openverse search degraded");
      if (err.code === "quota") {
        return Response.json({
          ok: false,
          code: "quota_reached",
          message: SHARED_QUOTA_MESSAGE,
        });
      }
      return Response.json({ ok: false, code: "provider_unavailable" });
    }
    logger.error({ err }, "Studio Openverse search failed unexpectedly");
    return Response.json({ ok: false, code: "provider_unavailable" });
  }
}
