/**
 * Area — Creator Studio AI image route (/api/studio/image, S3) and
 * the Workers AI (FLUX) client. Mirrors studio-ai-route.test.ts:
 * auth and logger mocked, global fetch stubbed, unique user ids per
 * test because the limiter singleton persists across tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "@/app/api/studio/image/route";
import {
  FLUX_MODEL,
  FluxError,
  createFluxImageClient,
  workersAiConfigFromEnv,
} from "@/lib/studio/fluxImage";

const ORIGINAL_ACCOUNT = process.env["CLOUDFLARE_ACCOUNT_ID"];
const ORIGINAL_TOKEN = process.env["CLOUDFLARE_API_TOKEN"];
let userSeq = 0;

function authedUser() {
  userSeq += 1;
  return { id: `studio-image-user-${userSeq}`, email: `u${userSeq}@example.test` };
}

function request(body: unknown) {
  return new Request("http://localhost/api/studio/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setEnv() {
  process.env["CLOUDFLARE_ACCOUNT_ID"] = "acct-test";
  process.env["CLOUDFLARE_API_TOKEN"] = "token-test";
}

function clearEnv() {
  delete process.env["CLOUDFLARE_ACCOUNT_ID"];
  delete process.env["CLOUDFLARE_API_TOKEN"];
}

function cloudflareOk(image = "QUJD") {
  return new Response(JSON.stringify({ success: true, result: { image } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockGetAuthenticatedUser.mockReset();
  clearEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_ACCOUNT === undefined) delete process.env["CLOUDFLARE_ACCOUNT_ID"];
  else process.env["CLOUDFLARE_ACCOUNT_ID"] = ORIGINAL_ACCOUNT;
  if (ORIGINAL_TOKEN === undefined) delete process.env["CLOUDFLARE_API_TOKEN"];
  else process.env["CLOUDFLARE_API_TOKEN"] = ORIGINAL_TOKEN;
});

describe("workersAiConfigFromEnv", () => {
  it("returns null when either name is absent", () => {
    expect(workersAiConfigFromEnv({})).toBeNull();
    expect(workersAiConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a" })).toBeNull();
    expect(workersAiConfigFromEnv({ CLOUDFLARE_API_TOKEN: "t" })).toBeNull();
  });
  it("returns the config when both are present", () => {
    expect(
      workersAiConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" })
    ).toEqual({ accountId: "a", apiToken: "t" });
  });
});

describe("createFluxImageClient", () => {
  it("maps a successful Cloudflare response to imageBase64 + model", async () => {
    const fetchFn = vi.fn(async () => cloudflareOk("RERG"));
    const client = createFluxImageClient({ accountId: "acct", apiToken: "tok", fetchFn: fetchFn as never });
    const result = await client.generateImage({ prompt: "a red kite" });
    expect(result).toEqual({ imageBase64: "RERG", model: FLUX_MODEL });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/black-forest-labs/flux-1-schnell"
    );
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ prompt: "a red kite" });
  });

  it("maps HTTP 429 to a quota FluxError", async () => {
    const client = createFluxImageClient({
      accountId: "acct",
      apiToken: "tok",
      fetchFn: async () => new Response("{}", { status: 429 }),
    });
    await expect(client.generateImage({ prompt: "x" })).rejects.toMatchObject({
      name: "FluxError",
      code: "quota",
    });
  });

  it("maps success:false to an unavailable FluxError", async () => {
    const client = createFluxImageClient({
      accountId: "acct",
      apiToken: "tok",
      fetchFn: async () =>
        new Response(JSON.stringify({ success: false, result: {} }), { status: 200 }),
    });
    const err = await client.generateImage({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FluxError);
    expect((err as FluxError).code).toBe("unavailable");
  });

  it("maps a missing image string to a bad_response FluxError", async () => {
    const client = createFluxImageClient({
      accountId: "acct",
      apiToken: "tok",
      fetchFn: async () =>
        new Response(JSON.stringify({ success: true, result: {} }), { status: 200 }),
    });
    await expect(client.generateImage({ prompt: "x" })).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("POST /api/studio/image", () => {
  it("rejects unauthenticated requests with 401", async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const res = await POST(request({ prompt: "a lighthouse at dawn" }));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with 400", async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await POST(request({ prompt: "ab" }));
    expect(res.status).toBe(400);
  });

  it("returns the typed not_configured response when the env is unset", async () => {
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    const res = await POST(request({ prompt: "a lighthouse at dawn" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: "not_configured", engine: "built-in" });
  });

  it("returns a data URL on a mocked Workers AI success", async () => {
    setEnv();
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal("fetch", vi.fn(async () => cloudflareOk("QUJD")));
    const res = await POST(request({ prompt: "a lighthouse at dawn" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; engine: string; provider: string; model: string; imageDataUrl: string;
    };
    expect(body.ok).toBe(true);
    expect(body.engine).toBe("free-ai");
    expect(body.provider).toBe("workers-ai");
    expect(body.model).toBe(FLUX_MODEL);
    expect(body.imageDataUrl).toBe("data:image/jpeg;base64,QUJD");
  });

  it("returns the typed quota_reached degradation on an upstream 429", async () => {
    setEnv();
    mockGetAuthenticatedUser.mockResolvedValue(authedUser());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    const res = await POST(request({ prompt: "a lighthouse at dawn" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string; engine: string };
    expect(body).toMatchObject({ ok: false, code: "quota_reached", engine: "built-in" });
  });

  it("throttles the 6th rapid request from the same user with 429 rate_limited", async () => {
    setEnv();
    const user = authedUser();
    mockGetAuthenticatedUser.mockResolvedValue(user);
    vi.stubGlobal("fetch", vi.fn(async () => cloudflareOk()));
    let lastStatus = 0;
    let lastBody: { code?: string } = {};
    for (let i = 0; i < 6; i++) {
      const res = await POST(request({ prompt: `image prompt number ${i}` }));
      lastStatus = res.status;
      lastBody = (await res.json()) as { code?: string };
    }
    expect(lastStatus).toBe(429);
    expect(lastBody.code).toBe("rate_limited");
  });
});
