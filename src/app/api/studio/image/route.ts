/**
 * Creator Studio — free-AI image endpoint (Programme S3).
 *
 * POST /api/studio/image  { prompt }
 *
 * Zero-cost contract: Workers AI FLUX.1-schnell, used only when
 * CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are configured. With
 * no config the route returns a typed `not_configured` response and
 * the Thumbnail Editor keeps working fully without it. Expected
 * degradations return HTTP 200 with a typed `code`; the route's own
 * per-user throttle is the only 429. The free pool is shared across
 * the whole workspace, so the per-user caps here are deliberately
 * tight (5/min, 20/day).
 */

import { z } from "zod";
import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { createPerUserRateLimiter } from "@/lib/studio/groq";
import {
  FluxError,
  createFluxImageClient,
  workersAiConfigFromEnv,
} from "@/lib/studio/fluxImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:studio:image");

const RequestSchema = z.object({
  prompt: z.string().trim().min(3).max(600),
});

// Module-level singleton: in-memory, per instance, resets on restart.
const limiter = createPerUserRateLimiter({ perMinute: 5, perDay: 20 });

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const config = workersAiConfigFromEnv(process.env);
  if (!config) {
    return Response.json({ ok: false, code: "not_configured", engine: "built-in" });
  }

  const refusal = limiter.check(user.id);
  if (refusal) {
    logger.warn({ userId: user.id, refusal }, "Studio image request refused by per-user limiter");
    return Response.json({ ok: false, code: refusal, engine: "built-in" }, { status: 429 });
  }
  limiter.record(user.id);

  try {
    const client = createFluxImageClient(config);
    const result = await client.generateImage({ prompt: parsed.data.prompt });
    return Response.json({
      ok: true,
      engine: "free-ai",
      provider: "workers-ai",
      model: result.model,
      imageDataUrl: `data:image/jpeg;base64,${result.imageBase64}`,
    });
  } catch (err) {
    if (err instanceof FluxError) {
      logger.warn({ userId: user.id, code: err.code }, "Studio image generation degraded");
      return Response.json({
        ok: false,
        code: err.code === "quota" ? "quota_reached" : "ai_unavailable",
        engine: "built-in",
      });
    }
    logger.error({ err }, "Studio image request failed unexpectedly");
    return Response.json({ ok: false, code: "ai_unavailable", engine: "built-in" });
  }
}
