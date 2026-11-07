/**
 * Creator Studio — free-AI enhancement endpoint (Programmes S1 + S2).
 *
 * POST /api/studio/generate
 *   { task: "video_ideas", topic, category, mode, count }        (S1)
 *   { task: "script_polish", topic, format, tone, sectionKind,
 *     sectionHeading?, sectionText }                             (S2)
 *
 * Zero-cost contract (saas/STUDIO_FREE_PROVIDERS_RESEARCH.md):
 *  - The ONLY provider is Groq's free tier, used only when GROQ_API_KEY
 *    is configured. With no key the route returns a typed
 *    `not_configured` response and every Studio tool keeps working on
 *    its built-in offline engine — AI here is an enhancement, never a
 *    dependency.
 *  - Expected degradations (not configured / free quota reached /
 *    provider unavailable) return HTTP 200 with a typed `code`, so the
 *    client can label the fallback honestly instead of treating it as
 *    an error. The route's OWN per-user throttle is the only 429.
 *  - Per-user rate limiting is in-memory at this tier (per instance,
 *    resets on restart) — a cost guardrail for the shared free pool,
 *    not a billing-grade quota.
 *  - Nothing about the prompt or output is persisted by this route;
 *    successful responses are cached in-memory by the provider client.
 */

import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import {
  GroqError,
  createGroqIdeasClient,
  createGroqTextClient,
  createPerUserRateLimiter,
} from '@/lib/studio/groq';
import { stableHash } from '@/lib/studio/nicheEngine';
import { STUDIO_CATEGORIES } from '@/lib/studio/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:studio:generate');

const IdeasRequestSchema = z.object({
  task: z.literal('video_ideas'),
  topic: z.string().trim().min(1).max(120),
  category: z.enum(STUDIO_CATEGORIES),
  mode: z.enum(['proven', 'questions', 'angles']),
  count: z.number().int().min(1).max(12).optional().default(6),
});

const PolishRequestSchema = z.object({
  task: z.literal('script_polish'),
  topic: z.string().trim().min(1).max(160),
  format: z.enum(['reel30', 'short60', 'longform']),
  tone: z.enum(['energetic', 'educational', 'calm', 'bold']),
  sectionKind: z.enum(['hook', 'setup', 'point', 'payoff', 'cta']),
  sectionHeading: z.string().trim().max(120).optional(),
  sectionText: z.string().trim().min(1).max(4000),
});

const SlidePolishRequestSchema = z.object({
  task: z.literal('slide_polish'),
  topic: z.string().trim().min(1).max(160),
  audience: z.string().trim().min(1).max(80),
  slideTitle: z.string().trim().min(1).max(160),
  bullets: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
});

const RequestSchema = z.discriminatedUnion('task', [
  IdeasRequestSchema,
  PolishRequestSchema,
  SlidePolishRequestSchema,
]);

// Module-level singletons: the provider clients' rotation cursors and
// response caches, and the per-user limiter, live for the process.
const limiter = createPerUserRateLimiter();
let groqClient: ReturnType<typeof createGroqIdeasClient> | null = null;
let groqTextClient: ReturnType<typeof createGroqTextClient> | null = null;

function getGroqClient(apiKey: string) {
  if (!groqClient) groqClient = createGroqIdeasClient({ apiKey });
  return groqClient;
}

function getGroqTextClient(apiKey: string) {
  if (!groqTextClient) groqTextClient = createGroqTextClient({ apiKey });
  return groqTextClient;
}

const FORMAT_LABELS: Record<z.infer<typeof PolishRequestSchema>['format'], string> = {
  reel30: 'a 30-second Reel/Short',
  short60: 'a 60-second Short',
  longform: 'a long-form video (outline level)',
};

function buildSlidePolishPrompt(
  data: z.infer<typeof SlidePolishRequestSchema>
): { system: string; user: string } {
  return {
    system:
      'You polish the bullets of ONE presentation slide. Reply with ONLY the polished ' +
      'bullets, one per line, no numbering, no bullet characters, no preamble. Keep ' +
      'every fact and claim from the original bullets; do not invent statistics, ' +
      'names or results. Keep roughly the same number of bullets and a similar length.',
    user:
      `Presentation topic: ${data.topic}\nAudience: ${data.audience}\n` +
      `Slide title: ${data.slideTitle}\n\n` +
      `Rewrite these slide bullets, tighter and clearer:\n\n${data.bullets.join('\n')}`,
  };
}

function parseSlidePolishLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('- ')) line = line.slice(2).trim();
    else if (line.startsWith('• ')) line = line.slice(2).trim();
    if (!line) continue;
    lines.push(line.slice(0, 300));
    if (lines.length >= 8) break;
  }
  return lines;
}

function buildPolishPrompt(data: z.infer<typeof PolishRequestSchema>): { system: string; user: string } {
  return {
    system:
      'You polish ONE section of a video script written by a creator. Reply with ONLY the ' +
      'rewritten section text — no preamble, no quotes, no markdown, no explanation. Keep ' +
      'every fact and claim from the original; do not invent statistics, names or results. ' +
      'Keep roughly the same length unless the original is padded, and keep any [bracketed] ' +
      'production notes intact.',
    user:
      `Video topic: ${data.topic}\nFormat: ${FORMAT_LABELS[data.format]}\nTone: ${data.tone}\n` +
      `Section: ${data.sectionKind}${data.sectionHeading ? ` — ${data.sectionHeading}` : ''}\n\n` +
      `Rewrite this section in the stated tone, tighter and more speakable:\n\n${data.sectionText}`,
  };
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

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 });
  }

  const apiKey = process.env['GROQ_API_KEY'];
  if (!apiKey) {
    return Response.json({ ok: false, code: 'not_configured', engine: 'built-in' });
  }

  const refusal = limiter.check(user.id);
  if (refusal) {
    logger.warn({ userId: user.id, refusal }, 'Studio AI request refused by per-user limiter');
    return Response.json({ ok: false, code: refusal, engine: 'built-in' }, { status: 429 });
  }
  limiter.record(user.id);

  try {
    if (parsed.data.task === 'video_ideas') {
      const result = await getGroqClient(apiKey).generateIdeas({
        topic: parsed.data.topic,
        category: parsed.data.category,
        mode: parsed.data.mode,
        count: parsed.data.count,
      });
      return Response.json({
        ok: true,
        engine: 'free-ai',
        provider: 'groq',
        model: result.model,
        cached: result.cached,
        ideas: result.ideas,
      });
    }

    if (parsed.data.task === 'slide_polish') {
      const slideData = parsed.data;
      const slideResult = await getGroqTextClient(apiKey).generateText({
        ...buildSlidePolishPrompt(slideData),
        cacheKey: `slide_polish:${stableHash(
          JSON.stringify({
            t: slideData.topic.toLowerCase(),
            a: slideData.audience.toLowerCase(),
            s: slideData.slideTitle,
            b: slideData.bullets,
          })
        )}`,
        maxTokens: 700,
      });
      const lines = parseSlidePolishLines(slideResult.text);
      if (lines.length === 0) {
        throw new GroqError('bad_response', 'Groq slide polish returned no usable bullets');
      }
      return Response.json({
        ok: true,
        engine: 'free-ai',
        provider: 'groq',
        model: slideResult.model,
        cached: slideResult.cached,
        text: lines.join('\n'),
      });
    }

    const data = parsed.data;
    const result = await getGroqTextClient(apiKey).generateText({
      ...buildPolishPrompt(data),
      cacheKey: `script_polish:${stableHash(
        JSON.stringify({
          t: data.topic.toLowerCase(),
          f: data.format,
          tone: data.tone,
          k: data.sectionKind,
          x: data.sectionText,
        })
      )}`,
      maxTokens: 900,
    });
    return Response.json({
      ok: true,
      engine: 'free-ai',
      provider: 'groq',
      model: result.model,
      cached: result.cached,
      text: result.text,
    });
  } catch (err) {
    if (err instanceof GroqError) {
      logger.warn({ userId: user.id, code: err.code }, 'Studio AI degraded to built-in engine');
      return Response.json({
        ok: false,
        code: err.code === 'quota' ? 'quota_reached' : 'ai_unavailable',
        engine: 'built-in',
      });
    }
    logger.error({ err }, 'Studio AI request failed unexpectedly');
    return Response.json({ ok: false, code: 'ai_unavailable', engine: 'built-in' });
  }
}
