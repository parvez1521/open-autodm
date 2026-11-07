/**
 * Creator Studio — browser helpers for the stock library routes
 * (Programme S3). Mirrors aiClient.ts: the Supabase session Bearer is
 * attached, and the routes' typed degradation codes stay readable
 * instead of collapsing into a thrown error. These routes are GETs
 * with query strings (search), unlike the AI route's POST.
 */

import { createBrowserClient } from "@/lib/supabase/clients";
import type { StockSearchItem } from "./pexels";
import type { StockAudioItem } from "./openverse";

/** Degradation states shared by the stock search helpers. */
export type StockDegradation =
  | "not_configured"
  | "quota_reached"
  | "rate_limited"
  | "daily_quota_reached"
  | "provider_unavailable"
  | "signed_out";

export type PexelsSearchOutcome =
  | {
      status: "ok";
      items: StockSearchItem[];
      totalResults: number;
      page: number;
      hasNext: boolean;
      providerUrl: string;
      licenseUrl: string;
    }
  | { status: StockDegradation };

export type OpenverseSearchOutcome =
  | {
      status: "ok";
      items: StockAudioItem[];
      resultCount: number;
      page: number;
      pageCount: number;
      providerUrl: string;
    }
  | { status: StockDegradation };

interface StockResponseBody {
  ok?: boolean;
  code?: string;
  providerUrl?: string;
  licenseUrl?: string;
  items?: unknown;
  totalResults?: number;
  page?: number;
  hasNext?: boolean;
  resultCount?: number;
  pageCount?: number;
}

async function getStock(
  path: string
): Promise<{ status: number; body: StockResponseBody } | { status: StockDegradation }> {
  const supabase = createBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return { status: "signed_out" };

  let res: Response;
  try {
    res = await fetch(path, {
      method: "GET",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { status: "provider_unavailable" };
  }

  const body = (await res.json().catch(() => null)) as StockResponseBody | null;
  if (res.status === 429) {
    return {
      status: body?.code === "daily_quota_reached" ? "daily_quota_reached" : "rate_limited",
    };
  }
  if (!body) return { status: "provider_unavailable" };
  return { status: res.status, body };
}

function degradationFrom(body: StockResponseBody): StockDegradation {
  switch (body.code) {
    case "not_configured":
      return "not_configured";
    case "quota_reached":
      return "quota_reached";
    case "provider_unavailable":
      return "provider_unavailable";
    default:
      return "provider_unavailable";
  }
}

export async function searchPexels(input: {
  media: "image" | "video";
  query: string;
  page?: number;
}): Promise<PexelsSearchOutcome> {
  const params = new URLSearchParams({
    media: input.media,
    q: input.query,
    page: String(input.page ?? 1),
  });
  const result = await getStock(`/api/studio/pexels?${params.toString()}`);
  if (!("body" in result)) return { status: result.status };
  const { body } = result;
  if (body.ok && Array.isArray(body.items)) {
    return {
      status: "ok",
      items: body.items as StockSearchItem[],
      totalResults: typeof body.totalResults === "number" ? body.totalResults : 0,
      page: typeof body.page === "number" ? body.page : (input.page ?? 1),
      hasNext: body.hasNext === true,
      providerUrl: typeof body.providerUrl === "string" ? body.providerUrl : "https://www.pexels.com",
      licenseUrl:
        typeof body.licenseUrl === "string" ? body.licenseUrl : "https://www.pexels.com/license/",
    };
  }
  return { status: degradationFrom(body) };
}

export async function searchOpenverseAudio(input: {
  query: string;
  page?: number;
}): Promise<OpenverseSearchOutcome> {
  const params = new URLSearchParams({
    q: input.query,
    page: String(input.page ?? 1),
  });
  const result = await getStock(`/api/studio/openverse?${params.toString()}`);
  if (!("body" in result)) return { status: result.status };
  const { body } = result;
  if (body.ok && Array.isArray(body.items)) {
    return {
      status: "ok",
      items: body.items as StockAudioItem[],
      resultCount: typeof body.resultCount === "number" ? body.resultCount : 0,
      page: typeof body.page === "number" ? body.page : (input.page ?? 1),
      pageCount: typeof body.pageCount === "number" ? body.pageCount : 1,
      providerUrl: typeof body.providerUrl === "string" ? body.providerUrl : "https://openverse.org",
    };
  }
  return { status: degradationFrom(body) };
}
