/**
 * Creator Studio — Pexels stock search endpoint (Programme S3).
 *
 * GET /api/studio/pexels?media=image|video&q=&page=
 *
 * Zero-cost contract (saas/STUDIO_FREE_PROVIDERS_RESEARCH.md):
 *  - Pexels needs a free API key (PEXELS_API_KEY). With no key the
 *    route returns a typed `not_configured` response (HTTP 200) and
 *    the Library tab explains the state instead of showing
 *    placeholders.
 *  - Expected degradations (not configured / provider quota /
 *    provider unavailable) return HTTP 200 with a typed `code`. The
 *    route's OWN per-user throttle is the only 429.
 *  - Results are provider REFERENCES (page URL, CDN asset URL, credit)
 *    — this route never downloads or re-hosts stock files, which the
 *    Pexels terms prohibit as standalone redistribution.
 */

import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { createPerUserRateLimiter } from "@/lib/studio/groq";
import {
  PEXELS_LICENSE_URL,
  PEXELS_PROVIDER_URL,
  PexelsError,
  createPexelsClient,
} from "@/lib/studio/pexels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:studio:pexels");

// Module singleton: per-user guardrail for the shared Pexels pool
// (200 req/hr + 20,000 req/mo across images and video).
const limiter = createPerUserRateLimiter({ perMinute: 10, perDay: 100 });

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const media = url.searchParams.get("media");
  if (media !== "image" && media !== "video") {
    return Response.json({ error: "media must be image or video" }, { status: 400 });
  }
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

  const apiKey = process.env["PEXELS_API_KEY"];
  if (!apiKey) {
    return Response.json({ ok: false, code: "not_configured" });
  }

  const refusal = limiter.check(user.id);
  if (refusal) {
    logger.warn({ userId: user.id, refusal }, "Studio Pexels request refused by per-user limiter");
    return Response.json({ ok: false, code: refusal }, { status: 429 });
  }
  limiter.record(user.id);

  try {
    const client = createPexelsClient({ apiKey });
    const result =
      media === "image"
        ? await client.searchImages({ query: q, page })
        : await client.searchVideos({ query: q, page });
    return Response.json({
      ok: true,
      provider: "pexels",
      providerUrl: PEXELS_PROVIDER_URL,
      licenseUrl: PEXELS_LICENSE_URL,
      items: result.items,
      totalResults: result.totalResults,
      page: result.page,
      hasNext: result.hasNext,
    });
  } catch (err) {
    if (err instanceof PexelsError) {
      logger.warn({ userId: user.id, code: err.code }, "Studio Pexels search degraded");
      return Response.json({
        ok: false,
        code: err.code === "quota" ? "quota_reached" : "provider_unavailable",
      });
    }
    logger.error({ err }, "Studio Pexels search failed unexpectedly");
    return Response.json({ ok: false, code: "provider_unavailable" });
  }
}
