/**
 * Viral Script Writer - generate + provider status.
 *
 * Auth: same rule as every other API route - identity comes from the
 * verified Supabase JWT, never from the request body. The instance is
 * invite-only, so this also keeps the owner's free AI quota from being
 * burned by strangers.
 *
 * This feature talks to NO Meta/Instagram API and needs NO new Meta
 * permission - it is a pure writing tool, so it has no effect on the
 * app's Meta App Review submission.
 */

import { z } from "zod";
import { getAuthenticatedUser, unauthorized } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { buildScriptMessages, parseGeneratedScript } from "@/lib/script-writer/prompt";
import { generateWithAi, providerStatus, NO_PROVIDER_MESSAGE } from "@/lib/script-writer/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:script-writer");

const GenerateSchema = z.object({
  topic: z.string().min(3, "topic is too short").max(600),
  niche: z.string().min(1).max(80),
  language: z.enum(["english", "hindi", "hinglish"]),
  durationSeconds: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60), z.literal(90)]),
  tone: z.string().min(1).max(60),
  hookStyle: z.string().min(1).max(60),
  audience: z.string().max(200).optional(),
  ctaKeyword: z
    .string()
    .min(1)
    .max(30)
    .transform((s) => s.trim().toUpperCase().replace(/\s+/g, "")),
  ctaResource: z.string().max(200).optional(),
  provider: z.enum(["auto", "workers-ai", "groq"]).default("auto"),
});

/** GET - which AI providers are configured (booleans only, never keys). */
export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();
  const status = providerStatus();
  return Response.json({
    ...status,
    // On Cloudflare the binding may exist even when REST vars are unset;
    // the UI treats "unknown" honestly instead of claiming it is off.
    workersAiBinding: "unknown" as const,
  });
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = GenerateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      { status: 400 },
    );
  }

  const messages = buildScriptMessages(parsed.data);
  const result = await generateWithAi(messages, parsed.data.provider);
  if (!result) {
    logger.warn({ userId: user.id, preference: parsed.data.provider }, "Script generation failed - no provider answered");
    return Response.json({ error: "ai_unavailable", message: NO_PROVIDER_MESSAGE }, { status: 503 });
  }

  let used = result;
  let script = parseGeneratedScript(result.text);
  if (!script && parsed.data.provider === "auto") {
    // "Auto" promises a fallback chain: if the primary provider
    // answered with output the parser cannot use, give the fallback
    // provider one chance before reporting bad_model_output.
    const fallback = await generateWithAi(messages, "groq");
    if (fallback && fallback.provider !== result.provider) {
      const retry = parseGeneratedScript(fallback.text);
      if (retry) {
        used = fallback;
        script = retry;
      }
    }
  }
  if (!script) {
    logger.warn({ provider: used.provider, model: used.model }, "Model returned unparseable output");
    return Response.json(
      {
        error: "bad_model_output",
        message: "The AI model returned a response that could not be parsed as a script. Please try Generate again.",
        raw: result.text.slice(0, 4000),
      },
      { status: 502 },
    );
  }

  // The prompt demands the creator's keyword back; enforce it server-side
  // so a drifting model can never break the automation connection.
  script.ctaKeyword = parsed.data.ctaKeyword;

  return Response.json({ script, provider: used.provider, model: used.model });
}
