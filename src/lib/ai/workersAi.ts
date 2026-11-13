/**
 * Cloudflare Workers AI integration for open-autoDM — DRAFTING ONLY (Phase 7).
 *
 * Restored from release-prep (origin/opendm-release-prep, src/lib/ai/workersAi.ts)
 * as a TRIMMED restore: only the four builder-time drafting generators are
 * present. The two runtime generators (runtime public replies and runtime
 * DM responses) are DELIBERATELY NOT restored (owner-approved
 * mixed scope, phase6-ai-mixed-proposal.md §1.2/§7). No runtime AI code path
 * exists in this module; see tests/ai-mixed-scope-negative.test.ts.
 *
 * Uses Cloudflare Workers AI Free Tier (10,000 Neurons/day).
 * Default model: @cf/meta/llama-3.3-70b-instruct-fp8-fast
 * (llama-3.2-3b-instruct was deprecated by Cloudflare effective 2026-11-20;
 *  the 70B model is the same one the Script Writer already uses.)
 *
 * Designed to be 100% resilient:
 *  - Enforces prompt injection sanitization.
 *  - Strict 5s execution timeout.
 *  - Never crashes if the AI binding is unavailable (e.g. local dev / test runner).
 *  - Seamlessly falls back to high-converting predefined templates on error or quota exhaustion.
 *
 * Fixes applied vs release-prep (proposal §2):
 *  - F-5: generateFollowUpDraft() sanitises the creator handle through
 *    sanitizePromptInput(..., 100) instead of interpolating it raw.
 */

import { createLogger } from '@/lib/logger';

const logger = createLogger('workers-ai');

export const DEFAULT_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const AI_REQUEST_TIMEOUT_MS = 5000;

/**
 * Bound how long application code waits for Workers AI.
 *
 * The Workers AI binding's run() API does not accept an AbortSignal. This
 * deadline returns control to the existing fallback path, but it cannot
 * cancel an inference that the platform has already started.
 */
export function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = AI_REQUEST_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Workers AI request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}


export interface WorkersAiBinding {
  run: (
    model: string,
    options: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      max_tokens?: number;
      temperature?: number;
    }
  ) => Promise<{ response?: string } | unknown>;
}

export interface AiGenerationResult<T> {
  data: T;
  status: 'success' | 'fallback';
  model: string;
  error?: string;
}

/** Sanitize input strings to prevent prompt injection and tokenizer manipulation. */
export function sanitizePromptInput(input: string, maxLen = 500): string {
  if (!input) return '';
  return input
    .replace(/<\|[a-z0-9_]+\|>/gi, '') // Strip Llama special tokens
    .replace(/\[\/?INST\]/gi, '')       // Strip legacy instruction tags
    .slice(0, maxLen)
    .trim();
}

/** Clean up model output: remove surrounding quotes, markdown asterisks, and trim. */
export function cleanAiOutput(text: string): string {
  return text
    .replace(/^\s*["'`]+|["'`]+\s*$/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .trim();
}

/**
 * Groq free-tier models, best first. Mirrors lib/script-writer/providers.ts
 * (and lib/studio/groq.ts) — the older llama names were retired by Groq and
 * answer 404/model_not_found, so the same rotation is tried in order and
 * the first model that answers wins. Keep the lists in step.
 */
const GROQ_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];

/**
 * Random tone angles — one is picked per request and appended to the
 * prompt, so identical user prompts still yield different outputs run
 * to run (same temperature, different angle). The angle is a style cue
 * only; it never reaches the user-facing text.
 */
export const AI_STYLE_ANGLES = [
  'playful and energetic',
  'warm and personal, like a message from a friend',
  'short, punchy and confident',
  'grateful and enthusiastic',
  'calm, clear and helpful',
  'excited, with a sense of delight',
];

export function pickRandomStyleAngle(): string {
  return AI_STYLE_ANGLES[randomIndex(AI_STYLE_ANGLES.length)] ?? AI_STYLE_ANGLES[0]!;
}

/** Crypto-random index in [0, n) (Math.random fallback for runtimes without WebCrypto). */
function randomIndex(n: number): number {
  if (n <= 1) return 0;
  try {
    const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (arr: Uint32Array) => Uint32Array } }).crypto;
    if (cryptoObj?.getRandomValues) {
      const buf = new Uint32Array(1);
      cryptoObj.getRandomValues(buf);
      return (buf[0] ?? 0) % n;
    }
  } catch {
    // Fall through to Math.random below.
  }
  return Math.floor(Math.random() * n);
}

/** Fisher-Yates shuffle returning a new array (crypto-random when available). */
export function shuffleCopy<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Varied fallback: a fresh random ordering of the pool, exactly `count`
 * unique items. Two consecutive calls practically never return the
 * identical ordered set.
 */
export function sampleFallback(pool: readonly string[], count: number): string[] {
  return shuffleCopy(pool).slice(0, Math.max(0, Math.min(count, pool.length)));
}

/** Varied single-item fallback: one random entry from the pool. */
export function pickRandomFallback(pool: readonly string[]): string {
  return pool[randomIndex(pool.length)] ?? pool[0]!;
}

/**
 * Groq free-tier chat completion — the second provider attempt, only when
 * GROQ_API_KEY is set (free at console.groq.com; same key the Script
 * Writer already uses). Model rotation mirrors
 * lib/script-writer/providers.ts. Returns null when unset, when every
 * model fails, or when a model returns no text. No new dependencies —
 * plain fetch to Groq's OpenAI-compatible endpoint.
 */
async function tryGroqChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens: number
): Promise<{ text: string; model: string } | null> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return null;
  for (const model of GROQ_MODELS) {
    try {
      const res = await withTimeout(
        () =>
          fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
          }),
        AI_REQUEST_TIMEOUT_MS
      );
      if (!res.ok) {
        logger.warn({ model, status: res.status }, 'Groq call failed, trying next model');
        continue;
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json?.choices?.[0]?.message?.content ?? '';
      if (text.trim()) return { text, model };
    } catch (err) {
      logger.warn({ err, model }, 'Groq call failed, trying next model');
    }
  }
  return null;
}

/**
 * Run a chat completion through Workers AI first (injected binding or the
 * resolved binding/REST fallback), then Groq when GROQ_API_KEY is set.
 * Returns null when no provider answers — the caller then serves the
 * (varied) template fallback. `injectedAi` is the test seam: when a
 * binding is injected, getAiBinding() is skipped.
 */
async function runChatCompletion(
  injectedAi: WorkersAiBinding | null | undefined,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens: number
): Promise<{ text: string; model: string } | null> {
  const ai = injectedAi ?? (await getAiBinding());
  if (ai) {
    try {
      const raw = (await withTimeout(
        () =>
          ai.run(DEFAULT_AI_MODEL, {
            messages,
            max_tokens: maxTokens,
            temperature: 0.7,
          }),
        AI_REQUEST_TIMEOUT_MS
      )) as { response?: string };
      const text = typeof raw?.response === 'string' ? raw.response : '';
      if (text.trim()) return { text, model: DEFAULT_AI_MODEL };
    } catch (err) {
      logger.warn({ err }, 'Workers AI generation failed - trying Groq fallback');
    }
  }
  return tryGroqChat(messages, maxTokens);
}

/**
 * Pad a partial provider result up to `count` with pool templates not
 * already present. Iterates a fresh shuffle, so it can never loop forever
 * on a duplicate (the old index-based padding could spin when the
 * computed fallback was already in the list).
 */
function padWithFallback(cleaned: string[], pool: readonly string[], count: number): string[] {
  for (const candidate of shuffleCopy(pool)) {
    if (cleaned.length >= count) break;
    if (!cleaned.includes(candidate)) cleaned.push(candidate);
  }
  return cleaned;
}

/**
 * REST-backed stand-in for the Workers AI binding, for runtimes where
 * no binding exists (e.g. Vercel) when CLOUDFLARE_ACCOUNT_ID +
 * CLOUDFLARE_API_TOKEN are set. Mirrors the call pattern already used
 * by lib/script-writer/providers.ts (tryWorkersAiRest) and normalizes
 * the REST envelope { result: { response } } to the binding's shape.
 */
function createWorkersAiRestBinding(accountId: string, token: string): WorkersAiBinding {
  return {
    async run(model, options) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: options.messages,
            ...(options.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          }),
        }
      );
      if (!res.ok) {
        throw new Error(`Workers AI REST call failed with status ${res.status}`);
      }
      const json = (await res.json()) as { result?: { response?: string } };
      return { response: json?.result?.response ?? '' };
    },
  };
}

/** Attempts to acquire the Cloudflare AI binding via OpenNext context. */
export async function getAiBinding(): Promise<WorkersAiBinding | null> {
  if ((globalThis as any).__WORKERS_AI_BINDING) {
    return (globalThis as any).__WORKERS_AI_BINDING;
  }
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as { AI?: WorkersAiBinding } | undefined;
    if (env?.AI && typeof env.AI.run === 'function') {
      return env.AI;
    }
  } catch {
    // Expected in Node.js / Vitest / non-Cloudflare environments
  }
  // No Workers binding on this runtime (e.g. Vercel): fall back to the
  // Workers AI REST API when the account credentials are configured.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (accountId && token) {
    return createWorkersAiRestBinding(accountId, token);
  }
  return null;
}

/** Default opening DM variations when AI is unavailable or prompt is empty.
 * The pool is deliberately larger than any requested count (route caps
 * count at 10): the fallback shuffles it per request, so two consecutive
 * clicks practically never return the identical ordered set. The first
 * five entries are the originals, in their original order. */
export const DEFAULT_OPENING_VARIATIONS = [
  "Hey {username}! Thanks so much for reaching out! Here is the link you requested: 👇",
  "Thanks for your comment, {username}! Super excited to share this with you ✨",
  "Hey {username}! Really appreciate your interest! Here is everything you need 🚀",
  "Hey {username}! Dropping the details right here in your inbox 📬",
  "So glad you asked, {username}! Here is the link and info you wanted 🙌",
  "Hey {username}! Your link is on its way — check your DMs in a second 👇",
  "Thanks for stopping by, {username}! Sending the details over to your inbox now ✨",
  "Hey {username}! Got you — everything you asked for is in your DMs 🚀",
  "Appreciate you, {username}! The link you wanted is waiting in your inbox 📬",
  "Hey {username}! Just sent it your way — take a look in your DMs 🙌",
  "Thanks for the comment, {username}! Your guide is ready in your inbox ✨",
  "Hey {username}! Here you go — all the details are in your DMs now 👇",
];

/** Default public comment replies when AI is unavailable or as fallback options.
 * Same shuffle-per-request contract as DEFAULT_OPENING_VARIATIONS. */
export const DEFAULT_PUBLIC_REPLIES = [
  "Sent you a DM! Check your requests 📥",
  "Check your inbox! Just sent it over ✨",
  "Just messaged you the link! 🚀",
  "Sent to your DMs! Let me know if you got it 📬",
  "All sent! Check your message requests 🙌",
  "DM sent! It's waiting in your inbox ✨",
  "Just dropped it in your DMs! 🚀",
  "Check your DMs — link is on its way! 📬",
  "Sent! Take a peek at your inbox 🙌",
  "Your DM is on its way! Check your requests 📥",
  "Messaged you! The link is in your inbox ✨",
  "Done — check your DMs! 🚀",
];

/** Default DM response draft when AI is unavailable or as fallback. */
export const DEFAULT_RESPONSE_DRAFT =
  "Here is the link and details you requested! Let me know if you need any help getting started 🙌";

export const DEFAULT_RESPONSE_DRAFTS = [
  "Here is the link and details you requested! Let me know if you need any help getting started 🙌",
  "So glad you reached out! You can access everything right here. Hope you find it super valuable! ✨",
  "Thanks for checking this out! Here are all the details and next steps. Enjoy! 🚀",
  "Here you go! Everything you asked for is right here — let me know if anything is unclear 🙌",
  "Happy to share! All the details are in this message, and I'm here if you need anything ✨",
  "You got it! Here's the link plus a quick rundown — enjoy going through it 🚀",
];

/** Default follow-up message when AI is unavailable or as fallback. */
export const DEFAULT_FOLLOW_UP_MESSAGE =
  "Hey {username}, did you get a chance to check the details I sent you?";

export const DEFAULT_FOLLOW_UP_DRAFTS = [
  "Hey {username}, did you get a chance to check the details I sent you?",
  "Hey {username}, just checking in to see if you had any questions about the info I sent over! ✨",
  "Quick follow-up, {username}! Did that have everything you were looking for? Happy to help 🙌",
  "Hey {username}, just floating this back up — did the link work okay for you?",
  "Hi {username}! Wanted to check if you had a chance to look through what I sent ✨",
  "Hey {username}, no rush at all — just let me know if you need anything else! 🙌",
];

/**
 * Generate 5 opening DM variations using Workers AI (then Groq when
 * configured) with automatic fallback to a freshly shuffled template set.
 */
export async function generateOpeningVariations(
  promptContext: string,
  count = 5,
  context?: { postCaption?: string; creatorUsername?: string; automationName?: string },
  injectedAi?: WorkersAiBinding | null
): Promise<AiGenerationResult<string[]>> {
  const sanitizedPrompt = sanitizePromptInput(promptContext || context?.automationName || '', 600);
  const sanitizedCaption = context?.postCaption ? sanitizePromptInput(context.postCaption, 300) : '';

  const systemMessage =
    "You are an assistant creating high-converting, friendly Instagram DM opening messages for a creator. " +
    "Generate distinct variations that feel human, authentic, and inviting. " +
    "Use {username} as the placeholder for the recipient's name where appropriate. " +
    "Do NOT fabricate URLs, discount percentages, or specific pricing unless provided. " +
    "Output EXACTLY one variation per line, numbered 1 to 5. No conversational preamble.";

  const userContent =
    `Creator goal/topic: ${sanitizedPrompt || 'Sharing a valuable resource, guide, or link'}\n` +
    (sanitizedCaption ? `Context from post: ${sanitizedCaption}\n` : '') +
    `Style angle for this batch: ${pickRandomStyleAngle()}\n` +
    `Generate ${count} distinct opening DM messages.`;

  const outcome = await runChatCompletion(
    injectedAi,
    [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent },
    ],
    350
  );

  if (outcome) {
    const lines = outcome.text
      .split('\n')
      .map((l) => l.replace(/^\d+[\.\)\-\s]+/, '').trim())
      .filter((l) => l.length > 5 && !l.startsWith('Here are') && !l.startsWith('Sure'));

    const cleaned = lines.map(cleanAiOutput);
    if (cleaned.length >= 2) {
      // Pad up to requested count with defaults if needed
      padWithFallback(cleaned, DEFAULT_OPENING_VARIATIONS, count);
      return {
        data: cleaned.slice(0, count),
        status: 'success',
        model: outcome.model,
      };
    }
    logger.warn({}, 'AI opening variations output too short - using template fallback');
  }

  return {
    data: sampleFallback(DEFAULT_OPENING_VARIATIONS, count),
    status: 'fallback',
    model: DEFAULT_AI_MODEL,
  };
}

/**
 * Generate public comment replies using Workers AI (then Groq when
 * configured) with automatic fallback to a freshly shuffled template set.
 */
export async function generatePublicReplies(
  promptContext?: string,
  count = 5,
  injectedAi?: WorkersAiBinding | null
): Promise<AiGenerationResult<string[]>> {
  const sanitizedPrompt = sanitizePromptInput(promptContext ?? '', 400);

  const systemMessage =
    "You are an assistant generating short, natural public Instagram comment replies for a creator. " +
    "Replies inform the commenter that a DM has been sent. Keep each reply under 50 characters, friendly, with 1-2 emojis. " +
    "Output EXACTLY one reply per line. No numbers, no bullet points, no extra text.";

  const userContent =
    `Context/vibe: ${sanitizedPrompt || 'Notifying commenter that their requested link is in their DMs'}\n` +
    `Style angle for this batch: ${pickRandomStyleAngle()}\n` +
    `Generate ${count} short variations.`;

  const outcome = await runChatCompletion(
    injectedAi,
    [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent },
    ],
    150
  );

  if (outcome) {
    const lines = outcome.text
      .split('\n')
      .map((l) => l.replace(/^\d+[\.\)\-\s]+/, '').trim())
      .filter((l) => l.length > 2 && l.length < 100);

    const cleaned = lines.map(cleanAiOutput);
    if (cleaned.length >= 2) {
      padWithFallback(cleaned, DEFAULT_PUBLIC_REPLIES, count);
      return {
        data: cleaned.slice(0, count),
        status: 'success',
        model: outcome.model,
      };
    }
    logger.warn({}, 'AI public replies output too short - using template fallback');
  }

  return {
    data: sampleFallback(DEFAULT_PUBLIC_REPLIES, count),
    status: 'fallback',
    model: DEFAULT_AI_MODEL,
  };
}

/**
 * Generate a response message draft using Workers AI (then Groq when
 * configured) with automatic fallback to a random template draft.
 */
export async function generateResponseDraft(
  promptContext?: string,
  context?: { postCaption?: string; creatorUsername?: string; automationName?: string },
  injectedAi?: WorkersAiBinding | null
): Promise<AiGenerationResult<string>> {
  const sanitizedPrompt = sanitizePromptInput(promptContext ?? '', 600);
  const sanitizedCaption = context?.postCaption ? sanitizePromptInput(context.postCaption, 300) : '';
  const sanitizedName = context?.automationName ? sanitizePromptInput(context.automationName, 200) : '';

  const systemMessage =
    "You are an assistant crafting a helpful, warm, and concise Instagram DM response for a creator. " +
    "Keep it under 300 characters, authentic, human, and clear. " +
    "Do NOT fabricate specific prices, secret coupon codes, or false claims. " +
    "Output ONLY the response message text. No quotes, no preamble.";

  const userContent =
    `Creator message goal: ${sanitizedPrompt || sanitizedName || 'Delivering the requested resource, link, or helpful info'}\n` +
    (sanitizedCaption ? `Context from post: ${sanitizedCaption}\n` : '') +
    `Style angle for this draft: ${pickRandomStyleAngle()}\n` +
    "Write a direct message response draft:";

  const outcome = await runChatCompletion(
    injectedAi,
    [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent },
    ],
    180
  );

  if (outcome) {
    const text = cleanAiOutput(outcome.text);
    if (text && text.length > 5) {
      return {
        data: text,
        status: 'success',
        model: outcome.model,
      };
    }
    logger.warn({}, 'AI response draft output too short - using template fallback');
  }

  return {
    data: pickRandomFallback(DEFAULT_RESPONSE_DRAFTS),
    status: 'fallback',
    model: DEFAULT_AI_MODEL,
  };
}

/**
 * Generate a follow-up message draft using Workers AI (then Groq when
 * configured) with automatic fallback to a random template draft.
 */
export async function generateFollowUpDraft(
  promptContext: string,
  context?: { automationName?: string; creatorUsername?: string },
  injectedAi?: WorkersAiBinding | null
): Promise<AiGenerationResult<string>> {
  const sanitizedPrompt = sanitizePromptInput(promptContext || context?.automationName || '', 600);
  // F-5: the creator handle is sanitised like every other interpolation
  // (release-prep interpolated it raw).
  const sanitizedCreator = context?.creatorUsername ? sanitizePromptInput(context.creatorUsername, 100) : '';

  const systemMessage =
    "You are an expert Instagram creator writing a friendly, polite follow-up DM check-in message. " +
    "The recipient already received an initial link or info after opting in. " +
    "Ask politely if they got a chance to check it out or if they have any questions. " +
    "Include {username} where natural. Keep it concise (under 250 characters), warm, and non-pushy. " +
    "Do NOT fabricate facts or external links. Output only the follow-up message.";

  const userContent =
    `Goal/context: ${sanitizedPrompt || 'Polite check-in on the previously shared link/guide'}\n` +
    (sanitizedCreator ? `Creator handle: @${sanitizedCreator}\n` : '') +
    `Style angle for this draft: ${pickRandomStyleAngle()}\n` +
    "Write the follow-up message:";

  const outcome = await runChatCompletion(
    injectedAi,
    [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent },
    ],
    150
  );

  if (outcome) {
    const text = cleanAiOutput(outcome.text);
    if (text && text.length > 5 && text.length <= 500) {
      return {
        data: text,
        status: 'success',
        model: outcome.model,
      };
    }
    logger.warn({}, 'AI follow-up draft output unusable - using template fallback');
  }

  return {
    data: pickRandomFallback(DEFAULT_FOLLOW_UP_DRAFTS),
    status: 'fallback',
    model: DEFAULT_AI_MODEL,
  };
}
