/**
 * Script Writer AI providers.
 *
 * Primary: Cloudflare Workers AI - Llama 3.3 70B (fp8-fast).
 *   Two ways in, tried in this order:
 *   1. The Workers AI binding (`AI`) when the app itself runs on
 *      Cloudflare via OpenNext - zero keys, zero extra setup, free
 *      allocation of 10,000 neurons/day on the Workers account.
 *   2. The Workers AI REST API when CLOUDFLARE_ACCOUNT_ID +
 *      CLOUDFLARE_API_TOKEN are set - this is the path for Vercel
 *      deployments and local development.
 *
 * Optional fallback: Groq (GROQ_API_KEY).
 *   Groq's free tier is fast and generous; its model catalogue changes
 *   often, so a small chain of currently-served free models is tried in
 *   order and the first that answers wins.
 *
 * Nothing here is added to the strict getEnv() schema on purpose:
 * existing deployments must keep booting without any AI variables set.
 * When no provider is configured the route returns a setup error with
 * exact instructions instead of failing mysteriously.
 */

import { createLogger } from "@/lib/logger";

const logger = createLogger("script-writer");

export type AiProviderName = "workers-ai" | "groq";

export interface AiResult {
  text: string;
  provider: AiProviderName;
  model: string;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/* Groq free-tier models, best first. The catalogue rotates; a model
   that no longer exists answers 404/model_not_found and we move on. */
const GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"];

export function providerStatus(): { workersAiRest: boolean; groq: boolean } {
  return {
    workersAiRest: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    groq: Boolean(process.env.GROQ_API_KEY),
  };
}

/** Try the Workers AI binding via OpenNext's Cloudflare context. */
async function tryWorkersAiBinding(messages: ChatMessage[]): Promise<AiResult | null> {
  try {
    // Dynamic import: this package is only present/meaningful on
    // Cloudflare builds. On Vercel or local Node it throws and we
    // fall through to the REST path.
    const mod = (await import("@opennextjs/cloudflare")) as unknown as {
      getCloudflareContext?: (opts?: { async?: boolean }) => Promise<{ env?: Record<string, unknown> }>;
    };
    if (!mod.getCloudflareContext) return null;
    const ctx = await mod.getCloudflareContext({ async: true });
    const ai = ctx?.env?.AI as
      | { run: (model: string, input: { messages: ChatMessage[]; max_tokens?: number }) => Promise<{ response?: string }> }
      | undefined;
    if (!ai || typeof ai.run !== "function") return null;
    const out = await ai.run(WORKERS_AI_MODEL, { messages, max_tokens: 1800 });
    const text = typeof out?.response === "string" ? out.response : "";
    if (!text) return null;
    return { text, provider: "workers-ai", model: WORKERS_AI_MODEL };
  } catch {
    return null;
  }
}

async function tryWorkersAiRest(messages: ChatMessage[]): Promise<AiResult | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) return null;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${WORKERS_AI_MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: 1800 }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: body.slice(0, 300) }, "Workers AI REST call failed");
    return null;
  }
  const json = (await res.json()) as { result?: { response?: string } };
  const text = json?.result?.response ?? "";
  if (!text) return null;
  return { text, provider: "workers-ai", model: WORKERS_AI_MODEL };
}

async function tryGroq(messages: ChatMessage[]): Promise<AiResult | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  for (const model of GROQ_MODELS) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1800,
        temperature: 0.8,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ model, status: res.status, body: body.slice(0, 300) }, "Groq call failed, trying next model");
      continue;
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json?.choices?.[0]?.message?.content ?? "";
    if (text) return { text, provider: "groq", model };
  }
  return null;
}

/**
 * Generate with the requested strategy. "auto" = Workers AI primary,
 * Groq fallback - the configuration the product ships with.
 */
export async function generateWithAi(
  messages: ChatMessage[],
  preference: "auto" | "workers-ai" | "groq",
): Promise<AiResult | null> {
  if (preference === "workers-ai") {
    return (await tryWorkersAiBinding(messages)) ?? (await tryWorkersAiRest(messages));
  }
  if (preference === "groq") {
    return tryGroq(messages);
  }
  const workers = (await tryWorkersAiBinding(messages)) ?? (await tryWorkersAiRest(messages));
  if (workers) return workers;
  return tryGroq(messages);
}

export const NO_PROVIDER_MESSAGE =
  "No AI provider is configured yet. On Cloudflare: add the Workers AI binding (already in wrangler.jsonc - redeploy), or set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN. Anywhere: set GROQ_API_KEY (free at console.groq.com) to enable the Groq fallback. See .env.example.";
