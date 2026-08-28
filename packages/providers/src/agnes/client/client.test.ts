/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  AGNES_DEFAULT_BASE_URL,
  AgnesClient,
  AgnesApiError,
  isRetryableError,
  type AgnesFetch,
} from "./index.js";
import { resolveAgnesClientConfig } from "./config.js";

const API_KEY = "test-key-abc123def456ghi789";
const TASK_OK = {
  id: "task_1",
  task_id: "task_1",
  video_id: "video_1",
  object: "video",
  model: "agnes-video-2.5-flash",
  status: "queued",
  progress: 0,
  created_at: 1770000000,
};

/** Build a fetch mock from a scripted queue of Responses (or thrown errors). */
function scriptedFetch(
  script: Array<Response | Error>,
): { fetch: AgnesFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: AgnesFetch = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (next instanceof Response) return next;
    throw next ?? new Error("script exhausted");
  };
  return { fetch, calls };
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const instantSleep = async () => {};

function makeClient(fetch: AgnesFetch, extra: Record<string, unknown> = {}) {
  return new AgnesClient(
    { apiKey: API_KEY, baseUrl: "https://mock.agnes.test/v1", sleep: instantSleep, ...extra },
    { fetch },
  );
}

describe("resolveAgnesClientConfig", () => {
  it("applies documented defaults", () => {
    const cfg = resolveAgnesClientConfig({ apiKey: " k " });
    expect(cfg.apiKey).toBe("k");
    expect(cfg.baseUrl).toBe(AGNES_DEFAULT_BASE_URL);
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.maxRetries).toBe(3);
  });

  it("rejects missing/blank api key", () => {
    expect(() => resolveAgnesClientConfig({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(() => resolveAgnesClientConfig({ apiKey: "   " })).toThrow(/apiKey is required/);
  });

  it("rejects invalid numeric options", () => {
    expect(() => resolveAgnesClientConfig({ apiKey: "k", maxRetries: 0 })).toThrow(/maxRetries/);
    expect(() => resolveAgnesClientConfig({ apiKey: "k", timeoutMs: -1 })).toThrow(/timeoutMs/);
  });
});

describe("AgnesClient — auth and body", () => {
  it("sends Bearer auth + JSON content type on createVideo", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, TASK_OK)]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "agnes-video-2.5-flash", prompt: "a wave", mode: "text" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.video_id).toBe("video_1");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://mock.agnes.test/v1/videos");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: "a wave",
      mode: "text",
    });
  });

  it("getVideo GETs /agnesapi (host-root, above /v1) with video_id + model_name", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(200, { ...TASK_OK, status: "completed", metadata: { url: "https://cdn/x.mp4" } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.getVideo("video_1", "agnes-video-2.5-flash");
    expect(result.ok).toBe(true);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://mock.agnes.test/agnesapi?video_id=video_1&model_name=agnes-video-2.5-flash");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("getVideo omits model_name when undefined (bare video_id, mode text)", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, { ...TASK_OK, status: "failed" })]);
    const client = makeClient(fetch);
    const result = await client.getVideo("video_1");
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://mock.agnes.test/agnesapi?video_id=video_1");
  });

  it("returns bad-response for a 2xx non-object body", async () => {
    const fetch: AgnesFetch = async () => new Response("<html>gateway</html>", { status: 200 });
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("bad-response");
  });
});

describe("AgnesClient — HTTP error mapping", () => {
  it("maps 401 to non-retryable http-error", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(401, { error: { message: "Invalid API key" } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http-error");
      expect(result.error.status).toBe(401);
      expect(result.error.apiMsg).toBe("Invalid API key");
    }
    expect(calls).toHaveLength(1); // no retry on 401
  });

  it("maps 404 (unknown video_id) to non-retryable http-error", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(404, { error: { message: "video not found" } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.getVideo("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("http-error");
    expect(calls).toHaveLength(1);
  });

  it("maps 429 to retryable rate-limited and honors Retry-After", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(429, { error: { message: "rate limit" } }, { "Retry-After": "2" }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries 5xx then succeeds", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and reports the last error", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
    ]);
    const client = makeClient(fetch, { maxRetries: 3 });
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("server-error");
      expect(result.error.attempt).toBe(3);
    }
    expect(calls).toHaveLength(3);
  });
});

describe("AgnesClient — timeout and network", () => {
  it("classifies fetch AbortError as timeout and retries", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const { fetch, calls } = scriptedFetch([abort, jsonResponse(200, TASK_OK)]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("classifies TypeError as network failure and retries", async () => {
    const { fetch, calls } = scriptedFetch([new TypeError("fetch failed"), jsonResponse(200, TASK_OK)]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("never retries a non-retryable kind (exercises isRetryableError)", () => {
    expect(isRetryableError("network")).toBe(true);
    expect(isRetryableError("timeout")).toBe(true);
    expect(isRetryableError("rate-limited")).toBe(true);
    expect(isRetryableError("server-error")).toBe(true);
    expect(isRetryableError("http-error")).toBe(false);
    expect(isRetryableError("bad-response")).toBe(false);
  });

  it("notifies onRetry with key-safe fields", async () => {
    const { fetch } = scriptedFetch([jsonResponse(500, { error: { message: "boom" } }), jsonResponse(200, TASK_OK)]);
    const seen: Array<{ reason: string; attempt: number; path: string }> = [];
    const client = new AgnesClient(
      { apiKey: API_KEY, baseUrl: "https://mock.agnes.test/v1", sleep: instantSleep },
      {
        fetch,
        onRetry: (info) => seen.push({ reason: info.reason, attempt: info.attempt, path: info.path }),
      },
    );
    await client.createVideo({ model: "m" });
    expect(seen).toEqual([{ reason: "server-error", attempt: 1, path: "/v1/videos" }]);
    // The retry callback must never receive the key or Authorization header.
    expect(JSON.stringify(seen)).not.toContain(API_KEY);
    expect(JSON.stringify(seen)).not.toContain("Bearer");
  });
});

describe("AgnesClient — key never leaks", () => {
  it("error messages never contain the API key", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
    ]);
    const client = makeClient(fetch, { maxRetries: 6 });
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(API_KEY);
    if (!result.ok) expect(result.error.message).not.toContain(API_KEY);
    expect(isRetryableError((result as { error: AgnesApiError }).error.kind)).toBe(true);
  });

  it("thrown errors never contain the API key (network class)", async () => {
    const { fetch } = scriptedFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const client = makeClient(fetch, { maxRetries: 2 });
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("server-supplied secret-shaped msg text is scrubbed from errors", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(422, { error: { message: `bad request key=${API_KEY} invalid` } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("request URL never embeds the key (auth is header-only)", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, TASK_OK)]);
    const client = makeClient(fetch);
    await client.getVideo("video_5");
    expect(calls[0]!.url).not.toContain(API_KEY);
  });
});

describe("AgnesClient — backoff behavior", () => {
  it("uses exponential backoff between attempts", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = new AgnesClient(
      {
        apiKey: API_KEY,
        baseUrl: "https://mock.agnes.test/v1",
        retryBackoffMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      { fetch },
    );
    await client.createVideo({ model: "m" });
    expect(sleeps).toEqual([100, 200]);
  });

  it("honors Retry-After on 429 (capped)", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(429, { error: { message: "slow down" } }, { "Retry-After": "5" }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = new AgnesClient(
      {
        apiKey: API_KEY,
        baseUrl: "https://mock.agnes.test/v1",
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      { fetch },
    );
    await client.createVideo({ model: "m" });
    expect(sleeps).toEqual([5000]);
  });
});
