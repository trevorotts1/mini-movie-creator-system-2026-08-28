/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  AGNES_DEFAULT_BASE_URL,
  AgnesClient,
  AgnesApiError,
  isRetryableError,
  isRetryableStatus,
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

describe("AgnesClient — host pinning (spec §29)", () => {
  it("throws (fail-fast) on an absolute URL path that escapes the configured host", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const client = makeClient(fetch);
    // A path bug is a programming error — fail loudly rather than surface as
    // a provider failure that the routing layer would retry elsewhere.
    await expect(
      client.request({ path: "https://evil.example/v1/videos", body: { model: "m" } }),
    ).rejects.toThrow(/configured host/);
    expect(calls).toHaveLength(0); // request never left the client
  });

  it("throws on a protocol-relative path (//evil.example)", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const client = makeClient(fetch);
    await expect(client.request({ path: "//evil.example/v1/videos", body: {} })).rejects.toThrow(
      /configured host/,
    );
    expect(calls).toHaveLength(0);
  });

  it("still allows the documented /agnesapi host-root route", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, TASK_OK)]);
    const client = makeClient(fetch);
    const result = await client.getVideo("video_1", "agnes-video-2.5-flash");
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://mock.agnes.test/agnesapi?video_id=video_1&model_name=agnes-video-2.5-flash");
  });
});

describe("AgnesClient — deadline covers body read (spec §29)", () => {
  it("times out when the server drips the response body", async () => {
    // A Response whose body never completes: fetch resolves fast, json() hangs.
    const never = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          // never close
        },
      }),
      { status: 200 },
    );
    const fetch: AgnesFetch = async () => never;
    const client = new AgnesClient(
      { apiKey: API_KEY, baseUrl: "https://mock.agnes.test/v1", timeoutMs: 50, maxRetries: 1 },
      { fetch },
    );
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
      expect(result.error.message).toContain("timed out");
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }
  }, 5_000);
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

  it("maps 429 on GET to retryable rate-limited and honors Retry-After", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(429, { error: { message: "rate limit" } }, { "Retry-After": "2" }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = makeClient(fetch);
    const result = await client.getVideo("video_1", "agnes-video-2.5-flash");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries 5xx on GET then succeeds", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = makeClient(fetch);
    const result = await client.getVideo("video_1");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries on GET and reports the last error", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(500, { error: { message: "boom" } }),
    ]);
    const client = makeClient(fetch, { maxRetries: 3 });
    const result = await client.getVideo("video_1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("server-error");
      expect(result.error.attempt).toBe(3);
    }
    expect(calls).toHaveLength(3);
  });
});

describe("AgnesClient — POST is never auto-retried on HTTP failure (paid non-idempotent submit)", () => {
  it("does NOT retry a 500 on createVideo (a timed-out 5xx may still have created a task)", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { error: { message: "boom" } }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = makeClient(fetch, { maxRetries: 3 });
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("server-error");
      expect(result.error.attempt).toBe(1);
    }
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a 429 on createVideo", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(429, { error: { message: "rate limit" } }, { "Retry-After": "2" }),
      jsonResponse(200, TASK_OK),
    ]);
    const client = makeClient(fetch, { maxRetries: 3 });
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("rate-limited");
    expect(calls).toHaveLength(1);
  });

  it("still retries wire failures (network/timeout) on createVideo — no response means no task was created", async () => {
    const { fetch, calls } = scriptedFetch([new TypeError("fetch failed"), jsonResponse(200, TASK_OK)]);
    const client = makeClient(fetch, { maxRetries: 3 });
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
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

  it("isRetryableStatus recognizes 429/5xx only", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
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
    await client.getVideo("video_1");
    expect(seen).toEqual([{ reason: "server-error", attempt: 1, path: "/agnesapi" }]);
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
    const result = await client.getVideo("video_1");
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

  it("scrubs SHORT secret-shaped token values echoed by the server", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(422, { error: { message: "invalid api key: sk-agn-1234" } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-agn-1234");
    expect(serialized).toContain("[redacted]");
  });

  it("keeps the phrase but redacts the value in credential-shaped messages", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(401, { error: { message: "invalid apikey abc123" } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("abc123");
    expect(serialized).toContain("[redacted]");
  });

  it("scrubs bare 16+ char mixed-alphanumeric tokens (including echoed URLs — safe direction)", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(422, { error: { message: "token agnesabc123def456ghi is invalid; see https://cdn.agnes-ai.com/video/123.mp4" } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.createVideo({ model: "m" });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("agnesabc123def456ghi");
    expect(serialized).not.toContain("https://cdn.agnes-ai.com/video/123.mp4");
    expect(serialized).toContain("[redacted]");
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
    await client.getVideo("video_1");
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
    await client.getVideo("video_1");
    expect(sleeps).toEqual([5000]);
  });

  it("clamps a huge Retry-After (no unbounded waits) and ignores garbage values", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(429, { error: { message: "slow down" } }, { "Retry-After": "999999" }),
      jsonResponse(429, { error: { message: "slow down" } }, { "Retry-After": "garbage" }),
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
    await client.getVideo("video_1");
    // 999999 clamped to 300s; "garbage" ignored -> falls back to backoff (100 * 2^1).
    expect(sleeps).toEqual([300_000, 200]);
  });
});

describe("AgnesClientConfig — bounded limits (spec §29)", () => {
  it("rejects maxRetries above the hard cap", () => {
    expect(() => resolveAgnesClientConfig({ apiKey: "k", maxRetries: 11 })).toThrow(/maxRetries/);
    expect(() => resolveAgnesClientConfig({ apiKey: "k", maxRetries: 999999 })).toThrow(/maxRetries/);
    expect(resolveAgnesClientConfig({ apiKey: "k", maxRetries: 10 }).maxRetries).toBe(10);
  });

  it("rejects timeoutMs above the hard cap", () => {
    expect(() => resolveAgnesClientConfig({ apiKey: "k", timeoutMs: 300_001 })).toThrow(/timeoutMs/);
    expect(() => resolveAgnesClientConfig({ apiKey: "k", timeoutMs: 999999999 })).toThrow(/timeoutMs/);
    expect(resolveAgnesClientConfig({ apiKey: "k", timeoutMs: 300_000 }).timeoutMs).toBe(300_000);
  });

  it("rejects retryBackoffMs above the hard cap", () => {
    expect(() => resolveAgnesClientConfig({ apiKey: "k", retryBackoffMs: 60_001 })).toThrow(/retryBackoffMs/);
  });

  it("rejects non-http(s) and malformed base URLs", () => {
    expect(() => resolveAgnesClientConfig({ apiKey: "k", baseUrl: "file:///etc/passwd" })).toThrow(/baseUrl/);
    expect(() => resolveAgnesClientConfig({ apiKey: "k", baseUrl: "not a url" })).toThrow(/baseUrl/);
    expect(() => resolveAgnesClientConfig({ apiKey: "k", baseUrl: "ftp://x.example" })).toThrow(/baseUrl/);
  });
});
