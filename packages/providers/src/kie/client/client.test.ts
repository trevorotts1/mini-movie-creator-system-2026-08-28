/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  KIE_DEFAULT_BASE_URL,
  KieClient,
  KieApiError,
  isRetryableError,
  type KieFetch,
} from "./index.js";
import { resolveKieClientConfig } from "./config.js";

const API_KEY = "test-key-abc123def456ghi789";
const ENVELOPE_OK = { code: 200, msg: "success", data: { taskId: "task_1" } };

/** Build a fetch mock from a scripted queue of Responses (or thrown errors). */
function scriptedFetch(
  script: Array<Response | Error>,
): { fetch: KieFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: KieFetch = async (url, init) => {
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

function makeClient(fetch: KieFetch, extra: Record<string, unknown> = {}) {
  return new KieClient(
    { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep, ...extra },
    { fetch },
  );
}

describe("resolveKieClientConfig", () => {
  it("applies documented defaults", () => {
    const cfg = resolveKieClientConfig({ apiKey: " k " });
    expect(cfg.apiKey).toBe("k");
    expect(cfg.baseUrl).toBe(KIE_DEFAULT_BASE_URL);
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.maxRetries).toBe(3);
  });

  it("rejects missing/blank api key", () => {
    expect(() => resolveKieClientConfig({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(() => resolveKieClientConfig({ apiKey: "   " })).toThrow(/apiKey is required/);
  });

  it("rejects invalid numeric options", () => {
    expect(() => resolveKieClientConfig({ apiKey: "k", maxRetries: 0 })).toThrow(/maxRetries/);
    expect(() => resolveKieClientConfig({ apiKey: "k", timeoutMs: -1 })).toThrow(/timeoutMs/);
  });
});

describe("KieClient — auth and envelope", () => {
  it("sends Bearer auth + JSON content type on createTask", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, ENVELOPE_OK)]);
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "bytedance/seedance-2-mini", input: { prompt: "hi there" } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.taskId).toBe("task_1");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://mock.kie.test/api/v1/jobs/createTask");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "bytedance/seedance-2-mini",
      input: { prompt: "hi there" },
    });
  });

  it("recordInfo GETs with taskId query param", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(200, { code: 200, msg: "success", data: { taskId: "task_9", state: "success" } }),
    ]);
    const client = makeClient(fetch);
    const result = await client.recordInfo("task_9");
    expect(result.ok).toBe(true);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://mock.kie.test/api/v1/jobs/recordInfo?taskId=task_9");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("treats envelope code != 200 on HTTP 200 as failure", async () => {
    const { fetch } = scriptedFetch([jsonResponse(200, { code: 402, msg: "insufficient credits", data: null })]);
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.apiCode).toBe(402);
      expect(result.error.kind).toBe("http-error");
      expect(result.error.attempt).toBe(1);
    }
  });

  it("returns bad-response for a 2xx non-JSON body", async () => {
    const fetch: KieFetch = async () => new Response("<html>gateway</html>", { status: 200 });
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("bad-response");
  });

  it("returns bad-response for malformed envelope", async () => {
    const { fetch } = scriptedFetch([jsonResponse(200, { unexpected: true })]);
    const client = makeClient(fetch);
    const result = await client.recordInfo("t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("bad-response");
  });
});

describe("KieClient — HTTP error mapping", () => {
  it("maps 401 to non-retryable http-error", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(401, { code: 401, msg: "You do not have access permissions" }),
    ]);
    const client = makeClient(fetch);
    const result = await client.recordInfo("t");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http-error");
      expect(result.error.status).toBe(401);
      expect(result.error.apiCode).toBe(401);
    }
    expect(calls).toHaveLength(1); // no retry on 401
  });

  it("maps 429 to retryable rate-limited and honors Retry-After", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(429, { code: 429, msg: "too many" }, { "Retry-After": "2" }),
      jsonResponse(200, ENVELOPE_OK),
    ]);
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries 5xx then succeeds", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(200, ENVELOPE_OK),
      jsonResponse(200, ENVELOPE_OK),
    ]);
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and reports the last error", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
    ]);
    const client = makeClient(fetch, { maxRetries: 3 });
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("server-error");
      expect(result.error.attempt).toBe(3);
    }
    expect(calls).toHaveLength(3);
  });
});

describe("KieClient — timeout and network", () => {
  it("classifies fetch AbortError as timeout and retries", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const { fetch, calls } = scriptedFetch([abort, jsonResponse(200, ENVELOPE_OK)]);
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("classifies TypeError as network failure and retries", async () => {
    const { fetch, calls } = scriptedFetch([new TypeError("fetch failed"), jsonResponse(200, ENVELOPE_OK)]);
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "m", input: {} });
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
    const { fetch } = scriptedFetch([jsonResponse(500, { code: 500, msg: "boom" }), jsonResponse(200, ENVELOPE_OK)]);
    const seen: Array<{ reason: string; attempt: number; path: string }> = [];
    const client = new KieClient(
      { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep },
      {
        fetch,
        onRetry: (info) => seen.push({ reason: info.reason, attempt: info.attempt, path: info.path }),
      },
    );
    await client.createTask({ model: "m", input: {} });
    expect(seen).toEqual([{ reason: "server-error", attempt: 1, path: "/api/v1/jobs/createTask" }]);
    // The retry callback must never receive the key or Authorization header.
    expect(JSON.stringify(seen)).not.toContain(API_KEY);
    expect(JSON.stringify(seen)).not.toContain("Bearer");
  });
});

describe("KieClient — key never leaks", () => {
  it("error messages never contain the API key", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
    ]);
    const client = makeClient(fetch, { maxRetries: 6 });
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(API_KEY);
    if (!result.ok) expect(result.error.message).not.toContain(API_KEY);
    expect(isRetryableError((result as { error: KieApiError }).error.kind)).toBe(true);
  });

  it("thrown errors never contain the API key (network class)", async () => {
    const { fetch } = scriptedFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const client = makeClient(fetch, { maxRetries: 2 });
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("server-supplied secret-shaped msg text is scrubbed from errors", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(422, { code: 422, msg: `bad request key=${API_KEY} invalid` }),
    ]);
    const client = makeClient(fetch);
    const result = await client.createTask({ model: "m", input: {} });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("request URL never embeds the key (auth is header-only)", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, ENVELOPE_OK)]);
    const client = makeClient(fetch);
    await client.recordInfo("task_5");
    expect(calls[0]!.url).not.toContain(API_KEY);
  });

  it("rejects an absolute-URL path that would leave the base origin (no key exfiltration)", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const client = makeClient(fetch);
    // Fail fast on caller misuse (same contract as config validation); fetch
    // must never fire, so the Authorization header never leaves the origin.
    await expect(
      client.request({ path: "https://evil.example/api/v1/jobs/createTask", body: {} }),
    ).rejects.toThrow(/base origin/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a protocol-relative path that would leave the base origin", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const client = makeClient(fetch);
    await expect(
      client.request({ path: "//evil.example/api/v1/jobs/createTask", body: {} }),
    ).rejects.toThrow(/base origin/);
    expect(calls).toHaveLength(0);
  });
});

describe("KieClient — backoff behavior", () => {
  it("uses exponential backoff between attempts", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(200, ENVELOPE_OK),
    ]);
    const client = new KieClient(
      {
        apiKey: API_KEY,
        baseUrl: "https://mock.kie.test",
        retryBackoffMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      { fetch },
    );
    await client.createTask({ model: "m", input: {} });
    expect(sleeps).toEqual([100, 200]);
  });

  it("honors Retry-After on 429 (capped)", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(429, { code: 429, msg: "slow down" }, { "Retry-After": "5" }),
      jsonResponse(200, ENVELOPE_OK),
    ]);
    const client = new KieClient(
      {
        apiKey: API_KEY,
        baseUrl: "https://mock.kie.test",
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      { fetch },
    );
    await client.createTask({ model: "m", input: {} });
    expect(sleeps).toEqual([5000]);
  });

  it("caps exponential backoff at 30s even for huge configured backoff", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(500, { code: 500, msg: "boom" }),
      jsonResponse(200, ENVELOPE_OK),
    ]);
    const client = new KieClient(
      {
        apiKey: API_KEY,
        baseUrl: "https://mock.kie.test",
        retryBackoffMs: 20_000, // 20s → 40s uncapped; must clamp to 30s
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      { fetch },
    );
    await client.createTask({ model: "m", input: {} });
    expect(sleeps).toEqual([20_000, 30_000]);
  });
});