/**
 * Creator Studio — browser helper for the AI image route (Programme S3).
 * Mirrors aiClient.ts: Supabase session Bearer, typed degradations
 * kept readable instead of collapsing into a thrown error.
 */

import { createBrowserClient } from "@/lib/supabase/clients";
import type { AiDegradation } from "./aiClient";

export type AiImageOutcome =
  | { status: "ok"; imageDataUrl: string; model: string }
  | { status: AiDegradation };

interface ImageResponseBody {
  ok?: boolean;
  code?: string;
  model?: string;
  imageDataUrl?: string;
}

function degradationFrom(body: ImageResponseBody): AiDegradation {
  switch (body.code) {
    case "not_configured":
      return "not_configured";
    case "quota_reached":
      return "quota_reached";
    default:
      return "ai_unavailable";
  }
}

export async function requestAiImage(input: { prompt: string }): Promise<AiImageOutcome> {
  const supabase = createBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return { status: "signed_out" };

  let res: Response;
  try {
    res = await fetch("/api/studio/image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ prompt: input.prompt }),
    });
  } catch {
    return { status: "ai_unavailable" };
  }

  const body = (await res.json().catch(() => null)) as ImageResponseBody | null;
  if (res.status === 429) {
    return {
      status: body?.code === "daily_quota_reached" ? "daily_quota_reached" : "rate_limited",
    };
  }
  if (!body) return { status: "ai_unavailable" };
  if (body.ok && typeof body.imageDataUrl === "string" && body.imageDataUrl) {
    return {
      status: "ok",
      imageDataUrl: body.imageDataUrl,
      model: typeof body.model === "string" ? body.model : "@cf/black-forest-labs/flux-1-schnell",
    };
  }
  return { status: degradationFrom(body) };
}
