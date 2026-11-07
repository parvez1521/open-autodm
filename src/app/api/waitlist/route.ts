/**
 * POST /api/waitlist — collect an email address for the public launch.
 *
 * Public by design (it sits on the landing page), so the defences are:
 *  - strict email validation + normalization (trim, lowercase),
 *  - a per-IP in-memory rate limit (per instance; counters reset on
 *    restart — the same documented trade-off as the Studio limiter),
 *  - writes go through the service-role client ONLY: the
 *    waitlist_entries table has RLS enabled, no policies, and no
 *    grants to anon/authenticated (migration 20260730000034), so this
 *    route is the single write path,
 *  - a duplicate address is a success state ("already on the list"),
 *    never an error, and the response never reveals anything beyond
 *    what the caller just submitted.
 */

import { createLogger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase/service";
import { normalizeWaitlistEmail } from "@/lib/waitlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger("api:waitlist");

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function isRateLimited(ip: string, now: number): boolean {
  const kept = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  kept.push(now);
  hits.set(ip, kept);
  return kept.length > MAX_PER_WINDOW;
}

export async function POST(request: Request): Promise<Response> {
  const ip =
    (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip, Date.now())) {
    return Response.json(
      { error: "rate_limited", message: "Too many tries just now. Wait a minute and try again." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_body", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const fields = (body ?? {}) as { email?: unknown; source?: unknown };
  const email = normalizeWaitlistEmail(fields.email);
  if (!email) {
    return Response.json(
      { error: "invalid_email", message: "Enter a valid email address." },
      { status: 400 },
    );
  }
  const source =
    typeof fields.source === "string" && fields.source.trim().length > 0
      ? fields.source.trim().slice(0, 40)
      : "landing";

  const supabase = createServiceClient();
  const { error } = await supabase.from("waitlist_entries").insert({ email, source });
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return Response.json({ ok: true, alreadyOnList: true });
    }
    logger.warn({ code: (error as { code?: string }).code }, "Waitlist insert failed");
    return Response.json(
      { error: "unavailable", message: "The waitlist did not respond just now. Try again in a moment." },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, alreadyOnList: false });
}
