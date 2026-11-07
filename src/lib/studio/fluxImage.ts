/**
 * Creator Studio — Workers AI image provider (Programme S3).
 *
 * Zero-cost architecture: FLUX.1-schnell on Cloudflare Workers AI is
 * the Studio's only hosted image-AI option, used only when a
 * Cloudflare account id + API token are configured. Its free neurons
 * come from ONE shared pool for the whole workspace, so callers must
 * rate-limit per user and degrade honestly. Plain fetch only.
 */

export const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export type FluxErrorCode = "quota" | "unavailable" | "bad_response";

export class FluxError extends Error {
  constructor(
    public readonly code: FluxErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FluxError";
  }
}

export interface WorkersAiConfig {
  accountId: string;
  apiToken: string;
}

export function workersAiConfigFromEnv(
  env: Record<string, string | undefined>
): WorkersAiConfig | null {
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"]?.trim();
  const apiToken = env["CLOUDFLARE_API_TOKEN"]?.trim();
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface FluxImageResult {
  imageBase64: string;
  model: string;
}

export function createFluxImageClient(deps: {
  accountId: string;
  apiToken: string;
  fetchFn?: FetchFn;
}) {
  const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${deps.accountId}/ai/run/${FLUX_MODEL}`;

  return {
    async generateImage(input: { prompt: string }): Promise<FluxImageResult> {
      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: input.prompt }),
        });
      } catch {
        throw new FluxError("unavailable", "Workers AI request failed before a response was received");
      }
      if (res.status === 429) {
        throw new FluxError("quota", "Workers AI free image quota is reached");
      }
      if (!res.ok) {
        throw new FluxError("unavailable", `Workers AI returned ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as
        | { success?: unknown; result?: { image?: unknown } }
        | null;
      if (!body || body.success !== true) {
        throw new FluxError("unavailable", "Workers AI reported the request did not succeed");
      }
      const image = body.result?.image;
      if (typeof image !== "string" || !image.trim()) {
        throw new FluxError("bad_response", "Workers AI response had no usable image");
      }
      return { imageBase64: image, model: FLUX_MODEL };
    },
  };
}
