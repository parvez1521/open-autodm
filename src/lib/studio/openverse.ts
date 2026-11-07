/**
 * Creator Studio — Openverse audio client (Programme S3).
 *
 * Keyless client for Openverse audio. Binding rules from
 * saas/STUDIO_FREE_PROVIDERS_RESEARCH.md:
 *  - Query `license_type=commercial` LOCKED on — callers cannot widen
 *    it (the builder's input type has no licence field at all).
 *  - All NC variants are hard-excluded twice: by the query lock and by
 *    a post-filter on every returned item (defence in depth — the API
 *    filter narrows, it does not clear, and Openverse does not verify
 *    per-item rights).
 *  - Per-item attribution + licence link are carried on every item so
 *    the UI and saved references can display them.
 *  - Anonymous tier is 200 requests/day against one shared provider
 *    pool — callers must add per-user limiting plus the per-instance
 *    daily guard (openverseQuota.ts; an in-memory counter in one
 *    server process, not a deployment-wide cap).
 */

export const OPENVERSE_AUDIO_ENDPOINT = "https://api.openverse.org/v1/audio/";

export interface StockAudioItem {
  id: string;
  title: string;
  creator: string;
  creatorUrl?: string;
  pageUrl: string;
  assetUrl: string;
  licenseName: string;
  licenseUrl?: string;
  durationSec?: number;
  thumbnailUrl?: string;
}

export type OpenverseErrorCode = "quota" | "unavailable" | "bad_response";

export class OpenverseError extends Error {
  constructor(
    public readonly code: OpenverseErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OpenverseError";
  }
}

export interface OpenverseSearchResult {
  items: StockAudioItem[];
  resultCount: number;
  page: number;
  pageCount: number;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function clampPage(page: number | undefined): number {
  const n = typeof page === "number" && Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.max(1, n);
}

function clampPageSize(pageSize: number | undefined): number {
  const n =
    typeof pageSize === "number" && Number.isFinite(pageSize) ? Math.floor(pageSize) : 20;
  return Math.min(50, Math.max(1, n));
}

/**
 * Build the Openverse audio search URL. The input type deliberately
 * has NO licence field — licence handling cannot be influenced by
 * callers. `license_type=commercial` is always set here.
 */
export function buildOpenverseSearchUrl(input: {
  query: string;
  page?: number;
  pageSize?: number;
}): string {
  const page = clampPage(input.page);
  const pageSize = clampPageSize(input.pageSize);
  const params = new URLSearchParams({
    q: input.query,
    license_type: "commercial",
    filter_dead: "false",
    page: String(page),
    page_size: String(pageSize),
  });
  return `${OPENVERSE_AUDIO_ENDPOINT}?${params.toString()}`;
}

export function licenseLabel(license: string, version?: string): string {
  const key = (license ?? "").trim().toLowerCase();
  const ver = typeof version === "string" ? version.trim() : "";
  switch (key) {
    case "by":
      return ver ? `CC BY ${ver}` : "CC BY";
    case "by-sa":
      return ver ? `CC BY-SA ${ver}` : "CC BY-SA";
    case "cc0":
      return "CC0 1.0";
    case "pdm":
      return "Public Domain Mark";
    case "sampling+":
      return "Sampling Plus";
    default:
      return key ? key.toUpperCase() : "";
  }
}

export function isCommerciallyUsableLicense(license: string): boolean {
  const key = (license ?? "").trim().toLowerCase();
  if (!key) return false;
  if (key.includes("nc")) return false;
  return true;
}

interface OpenverseAudioRaw {
  id?: unknown;
  title?: unknown;
  creator?: unknown;
  creator_url?: unknown;
  foreign_landing_url?: unknown;
  detail_url?: unknown;
  url?: unknown;
  license?: unknown;
  license_version?: unknown;
  license_url?: unknown;
  duration?: unknown;
  thumbnail?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function createOpenverseClient(deps?: { fetchFn?: FetchFn }) {
  const fetchFn: FetchFn = deps?.fetchFn ?? ((url, init) => fetch(url, init));

  return {
    async searchAudio(input: {
      query: string;
      page?: number;
      pageSize?: number;
    }): Promise<OpenverseSearchResult> {
      const page = clampPage(input.page);
      const url = buildOpenverseSearchUrl(input);
      let res: Response;
      try {
        res = await fetchFn(url, { method: "GET" });
      } catch {
        throw new OpenverseError(
          "unavailable",
          "Openverse request failed before a response was received"
        );
      }
      if (res.status === 429) {
        throw new OpenverseError("quota", "Openverse is at its anonymous daily limit");
      }
      if (!res.ok) {
        throw new OpenverseError("unavailable", `Openverse returned ${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new OpenverseError("bad_response", "Openverse response was not valid JSON");
      }
      const b = body as {
        results?: unknown;
        result_count?: unknown;
        page_count?: unknown;
      } | null;
      if (!b || !Array.isArray(b.results)) {
        throw new OpenverseError("bad_response", "Openverse response had no results array");
      }
      const items: StockAudioItem[] = [];
      for (const raw of b.results as OpenverseAudioRaw[]) {
        if (typeof raw !== "object" || raw === null) continue;
        const licenseRaw = asString(raw.license);
        // Defence in depth: drop anything the query lock should have
        // excluded (every NC variant, and empty/unknown licences).
        if (!isCommerciallyUsableLicense(licenseRaw)) continue;
        const assetUrl = asString(raw.url);
        const pageUrl = asString(raw.foreign_landing_url) || asString(raw.detail_url);
        if (!assetUrl || !pageUrl) continue;
        const item: StockAudioItem = {
          id: raw.id != null ? String(raw.id) : pageUrl,
          title: asString(raw.title).trim() || "Untitled audio",
          creator: asString(raw.creator).trim() || "Unknown creator",
          pageUrl,
          assetUrl,
          licenseName: licenseLabel(
            licenseRaw,
            typeof raw.license_version === "string" ? raw.license_version : undefined
          ),
        };
        const creatorUrl = asString(raw.creator_url);
        if (creatorUrl) item.creatorUrl = creatorUrl;
        const licenseUrl = asString(raw.license_url);
        if (licenseUrl) item.licenseUrl = licenseUrl;
        if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) {
          item.durationSec = Math.round(raw.duration / 1000);
        }
        const thumbnailUrl = asString(raw.thumbnail);
        if (thumbnailUrl) item.thumbnailUrl = thumbnailUrl;
        items.push(item);
      }
      const resultCount =
        typeof b.result_count === "number" ? b.result_count : items.length;
      const pageCount = typeof b.page_count === "number" ? b.page_count : page;
      return { items, resultCount, page, pageCount };
    },
  };
}
