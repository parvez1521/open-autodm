/**
 * Creator Studio — Pexels stock client (Programme S3).
 *
 * Plain-fetch client for the Pexels API (images + videos). Zero-cost
 * discipline from saas/STUDIO_FREE_PROVIDERS_RESEARCH.md:
 *  - Content is free for commercial use, but the API terms require a
 *    prominent link to Pexels and photographer credit where possible,
 *    and prohibit standalone redistribution / building a competing
 *    stock library. The Studio pattern is therefore
 *    "search → use in this project" and saved items are REFERENCES
 *    (provider URLs + credit), never re-hosted files.
 *  - 200 req/hr + 20,000 req/mo are one shared pool across images and
 *    video — callers must rate-limit per user (see groq.ts limiter).
 *
 * The client is built with an injected fetch so it is fully
 * unit-testable in node, exactly like the Groq clients.
 */

export const PEXELS_PROVIDER_URL = "https://www.pexels.com";
export const PEXELS_LICENSE_URL = "https://www.pexels.com/license/";

export interface StockSearchItem {
  id: string;
  media: "image" | "video";
  title: string;
  pageUrl: string;
  creator: string;
  creatorUrl?: string;
  previewUrl: string;
  assetUrl: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export type PexelsErrorCode = "quota" | "unavailable" | "bad_response";

export class PexelsError extends Error {
  constructor(
    public readonly code: PexelsErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PexelsError";
  }
}

export interface PexelsSearchResult {
  items: StockSearchItem[];
  totalResults: number;
  page: number;
  perPage: number;
  hasNext: boolean;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function clampPerPage(perPage: number | undefined): number {
  const n = typeof perPage === "number" && Number.isFinite(perPage) ? Math.floor(perPage) : 15;
  return Math.min(40, Math.max(1, n));
}

function clampPage(page: number | undefined): number {
  const n = typeof page === "number" && Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.max(1, n);
}

interface PexelsPhotoRaw {
  id?: unknown;
  url?: unknown;
  alt?: unknown;
  photographer?: unknown;
  photographer_url?: unknown;
  width?: unknown;
  height?: unknown;
  src?: { medium?: unknown; large?: unknown };
}

interface PexelsVideoFileRaw {
  id?: unknown;
  quality?: unknown;
  file_type?: unknown;
  width?: unknown;
  height?: unknown;
  link?: unknown;
}

interface PexelsVideoRaw {
  id?: unknown;
  url?: unknown;
  image?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  user?: { name?: unknown; url?: unknown };
  video_files?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function pickVideoFile(files: PexelsVideoFileRaw[]): string {
  if (files.length === 0) return "";
  const withLink = files.filter((f) => typeof f.link === "string" && (f.link as string).length > 0);
  if (withLink.length === 0) return "";
  // Prefer mp4 when any mp4 exists.
  const mp4 = withLink.filter((f) => f.file_type === "video/mp4");
  const pool = mp4.length > 0 ? mp4 : withLink;
  const widthOf = (f: PexelsVideoFileRaw) => (typeof f.width === "number" ? f.width : 0);
  const under = pool.filter((f) => widthOf(f) <= 1920);
  const candidates = under.length > 0 ? under : pool;
  // Largest width wins within the chosen pool.
  let best = candidates[0]!;
  for (const f of candidates) {
    if (widthOf(f) > widthOf(best)) best = f;
  }
  return asString(best.link);
}

export function createPexelsClient(deps: { apiKey: string; fetchFn?: FetchFn }) {
  const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));

  async function fetchJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "GET",
        headers: { Authorization: deps.apiKey },
      });
    } catch {
      throw new PexelsError("unavailable", "Pexels request failed before a response was received");
    }
    if (res.status === 429) {
      throw new PexelsError("quota", "Pexels is at its free-tier limit");
    }
    if (!res.ok) {
      throw new PexelsError("unavailable", `Pexels returned ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new PexelsError("bad_response", "Pexels response was not valid JSON");
    }
  }

  return {
    async searchImages(input: {
      query: string;
      page?: number;
      perPage?: number;
    }): Promise<PexelsSearchResult> {
      const page = clampPage(input.page);
      const perPage = clampPerPage(input.perPage);
      const params = new URLSearchParams({
        query: input.query,
        page: String(page),
        per_page: String(perPage),
      });
      const body = (await fetchJson(
        `https://api.pexels.com/v1/search?${params.toString()}`
      )) as {
        photos?: unknown;
        total_results?: unknown;
        next_page?: unknown;
      } | null;
      if (!body || !Array.isArray(body.photos)) {
        throw new PexelsError("bad_response", "Pexels image response had no photos array");
      }
      const items: StockSearchItem[] = [];
      for (const raw of body.photos as PexelsPhotoRaw[]) {
        if (typeof raw !== "object" || raw === null) continue;
        const previewUrl = asString(raw.src?.medium);
        const assetUrl = asString(raw.src?.large);
        const pageUrl = asString(raw.url);
        if (!previewUrl || !assetUrl || !pageUrl) continue;
        const item: StockSearchItem = {
          id: raw.id != null ? String(raw.id) : pageUrl,
          media: "image",
          title: asString(raw.alt).trim() || "Untitled photo",
          pageUrl,
          creator: asString(raw.photographer).trim() || "Unknown creator",
          previewUrl,
          assetUrl,
        };
        const creatorUrl = asString(raw.photographer_url);
        if (creatorUrl) item.creatorUrl = creatorUrl;
        const w = asNumber(raw.width);
        if (w !== undefined) item.width = w;
        const h = asNumber(raw.height);
        if (h !== undefined) item.height = h;
        items.push(item);
      }
      const totalResults =
        typeof body.total_results === "number" ? body.total_results : items.length;
      const hasNext =
        typeof body.next_page === "string" && body.next_page.length > 0
          ? true
          : items.length === perPage && page * perPage < totalResults;
      return { items, totalResults, page, perPage, hasNext };
    },

    async searchVideos(input: {
      query: string;
      page?: number;
      perPage?: number;
    }): Promise<PexelsSearchResult> {
      const page = clampPage(input.page);
      const perPage = clampPerPage(input.perPage);
      const params = new URLSearchParams({
        query: input.query,
        page: String(page),
        per_page: String(perPage),
      });
      const body = (await fetchJson(
        `https://api.pexels.com/videos/search?${params.toString()}`
      )) as {
        videos?: unknown;
        total_results?: unknown;
        next_page?: unknown;
      } | null;
      if (!body || !Array.isArray(body.videos)) {
        throw new PexelsError("bad_response", "Pexels video response had no videos array");
      }
      const items: StockSearchItem[] = [];
      for (const raw of body.videos as PexelsVideoRaw[]) {
        if (typeof raw !== "object" || raw === null) continue;
        const pageUrl = asString(raw.url);
        const previewUrl = asString(raw.image);
        const files = Array.isArray(raw.video_files)
          ? (raw.video_files as PexelsVideoFileRaw[])
          : [];
        const assetUrl = pickVideoFile(files);
        if (!pageUrl || !previewUrl || !assetUrl) continue;
        const creatorName = asString(raw.user?.name).trim();
        const item: StockSearchItem = {
          id: raw.id != null ? String(raw.id) : pageUrl,
          media: "video",
          title: creatorName ? `Video by ${creatorName}` : "Untitled video",
          pageUrl,
          creator: creatorName || "Unknown creator",
          previewUrl,
          assetUrl,
        };
        const creatorUrl = asString(raw.user?.url);
        if (creatorUrl) item.creatorUrl = creatorUrl;
        const w = asNumber(raw.width);
        if (w !== undefined) item.width = w;
        const h = asNumber(raw.height);
        if (h !== undefined) item.height = h;
        const dur = asNumber(raw.duration);
        if (dur !== undefined) item.durationSec = dur;
        items.push(item);
      }
      const totalResults =
        typeof body.total_results === "number" ? body.total_results : items.length;
      const hasNext =
        typeof body.next_page === "string" && body.next_page.length > 0
          ? true
          : items.length === perPage && page * perPage < totalResults;
      return { items, totalResults, page, perPage, hasNext };
    },
  };
}
