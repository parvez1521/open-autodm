/**
 * Creator Studio — browser helper for the free-AI enhancement route
 * (Programmes S1 + S2). Mirrors lib/api/client's auth attach (Supabase
 * session Bearer) but keeps the route's typed degradation codes
 * readable instead of collapsing them into a thrown error.
 */

import { createBrowserClient } from "@/lib/supabase/clients";
import type {
  IdeaItem,
  IdeaMode,
  ScriptFormat,
  ScriptSectionKind,
  ScriptTone,
  StudioCategory,
} from "./types";

/** Degradation states shared by every Studio AI task. */
export type AiDegradation =
  | "not_configured"
  | "quota_reached"
  | "rate_limited"
  | "daily_quota_reached"
  | "ai_unavailable"
  | "signed_out";

export type AiIdeasOutcome =
  | { status: "ok"; ideas: IdeaItem[]; model: string; cached: boolean }
  | { status: AiDegradation };

export type AiPolishOutcome =
  | { status: "ok"; text: string; model: string; cached: boolean }
  | { status: AiDegradation };

export type AiSlidePolishOutcome =
  | { status: "ok"; bullets: string[]; model: string; cached: boolean }
  | { status: AiDegradation };

interface GenerateResponseBody {
  ok?: boolean;
  code?: string;
  model?: string;
  cached?: boolean;
  ideas?: IdeaItem[];
  text?: string;
}

/**
 * POSTs to the Studio AI route with the session Bearer attached.
 * Returns the parsed body plus the HTTP status, or a typed degradation
 * for the transport-level failures (signed out / network / bad body).
 */
async function postGenerate(
  payload: Record<string, unknown>
): Promise<{ status: number; body: GenerateResponseBody } | { status: AiDegradation }> {
  const supabase = createBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return { status: "signed_out" };

  let res: Response;
  try {
    res = await fetch("/api/studio/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { status: "ai_unavailable" };
  }

  const body = (await res.json().catch(() => null)) as GenerateResponseBody | null;
  if (res.status === 429) {
    return {
      status: body?.code === "daily_quota_reached" ? "daily_quota_reached" : "rate_limited",
    };
  }
  if (!body) return { status: "ai_unavailable" };
  return { status: res.status, body };
}

function degradationFrom(body: GenerateResponseBody): AiDegradation {
  switch (body.code) {
    case "not_configured":
      return "not_configured";
    case "quota_reached":
      return "quota_reached";
    default:
      return "ai_unavailable";
  }
}

export async function requestAiIdeas(input: {
  topic: string;
  category: StudioCategory;
  mode: IdeaMode;
  count: number;
}): Promise<AiIdeasOutcome> {
  const result = await postGenerate({ task: "video_ideas", ...input });
  if (!("body" in result)) return { status: result.status };
  const { body } = result;
  if (body.ok && Array.isArray(body.ideas)) {
    return {
      status: "ok",
      ideas: body.ideas,
      model: typeof body.model === "string" ? body.model : "groq",
      cached: body.cached === true,
    };
  }
  return { status: degradationFrom(body) };
}

export async function requestAiSlidePolish(input: {
  topic: string;
  audience: string;
  slideTitle: string;
  bullets: string[];
}): Promise<AiSlidePolishOutcome> {
  const result = await postGenerate({ task: "slide_polish", ...input });
  if (!("body" in result)) return { status: result.status };
  const { body } = result;
  if (body.ok && typeof body.text === "string") {
    const bullets = body.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 8);
    if (bullets.length === 0) return { status: "ai_unavailable" };
    return {
      status: "ok",
      bullets,
      model: typeof body.model === "string" ? body.model : "groq",
      cached: body.cached === true,
    };
  }
  return { status: degradationFrom(body) };
}

export async function requestAiScriptPolish(input: {
  topic: string;
  format: ScriptFormat;
  tone: ScriptTone;
  sectionKind: ScriptSectionKind;
  sectionHeading?: string;
  sectionText: string;
}): Promise<AiPolishOutcome> {
  const result = await postGenerate({ task: "script_polish", ...input });
  if (!("body" in result)) return { status: result.status };
  const { body } = result;
  if (body.ok && typeof body.text === "string" && body.text.trim()) {
    return {
      status: "ok",
      text: body.text,
      model: typeof body.model === "string" ? body.model : "groq",
      cached: body.cached === true,
    };
  }
  return { status: degradationFrom(body) };
}
