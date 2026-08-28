/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  FISH_DEFAULT_BASE_URL,
  FISH_TTS_MODELS,
  FishApiError,
  FishClient,
  isRetryableError,
  type FishFetch,
} from "./index.js";
import { resolveFishClientConfig } from "./config.js";

const API_KEY = "test-key-abc123def456ghi789";

/** Build a fetch mock from a scripted queue of Responses (or thrown errors). */
function scriptedFetch(
  script: Array<Response | Error>,
): { fetch: FishFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FishFetch = async (url, init) => {
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

/** Binary-audio response for POST /v1/tts (no JSON envelope, per docs). */
function audioResponse(bytes: number[], headers?: Record<string, string>): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", ...headers },
  });
}

function sseResponse(frames: string[]): Response {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const instantSleep = async () => {};

function makeClient(fetch: FishFetch, extra: Record<string, unknown> = {}) {
  return new FishClient(
    { apiKey: API_KEY, baseUrl: "https://mock.fish.test", sleep: instantSleep, ...extra },
    { fetch },
  );
}

const TTS_OK = { model: "s2.1-pro", text: "Hello there." } as const;

describe("resolveFishClientConfig", () => {
  it("applies documented defaults", () => {
    const cfg = resolveFishClientConfig({ apiKey: " k " });
    expect(cfg.apiKey).toBe("k");
    expect(cfg.baseUrl).toBe(FISH_DEFAULT_BASE_URL);
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.maxRetries).toBe(3);
  });

  it("rejects missing/blank api key", () => {
    expect(() => resolveFishClientConfig({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(() => resolveFishClientConfig({ apiKey: "   " })).toThrow(/apiKey is required/);
  });

  it("rejects invalid numeric options", () => {
    expect(() => resolveFishClientConfig({ apiKey: "k", maxRetries: 0 })).toThrow(/maxRetries/);
    expect(() => resolveFishClientConfig({ apiKey: "k", timeoutMs: -1 })).toThrow(/timeoutMs/);
  });

  it("records s2.1-pro-free as an available model id but does not default to it", () => {
    expect(FISH_TTS_MODELS).toContain("s2.1-pro-free");
    // Model selection is config-driven; the client requires the model per call.
    expect(resolveFishClientConfig({ apiKey: "k" })).not.toHaveProperty("model");
  });
});

describe("FishClient — auth and request shape", () => {
  it("sends Bearer auth + JSON content type on POST /v1/tts", async () => {
    const { fetch, calls } = scriptedFetch([audioResponse([1, 2, 3])]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });

    expect(result.ok).toBe(true);
    if (result.ok) expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://mock.fish.test/v1/tts");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["model"]).toBe("s2.1-pro");
  });

  it("maps camelCase request fields onto the documented snake_case JSON body", async () => {
    const { fetch, calls } = scriptedFetch([audioResponse([0])]);
    const client = makeClient(fetch);
    await client.tts({
      model: "s2.1-pro",
      text: "line one",
      referenceId: "voice-123",
      topP: 0.9,
      prosody: { speed: 1.5, volume: -2, normalizeLoudness: true },
      format: "wav",
      sampleRate: 44100,
      maxNewTokens: 512,
      conditionOnPreviousChunks: false,
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      text: "line one",
      reference_id: "voice-123",
      top_p: 0.9,
      prosody: { speed: 1.5, volume: -2, normalize_loudness: true },
      format: "wav",
      sample_rate: 44100,
      max_new_tokens: 512,
      condition_on_previous_chunks: false,
    });
  });

  it("sends an array reference_id unchanged (S2-family multi-speaker dialogue)", async () => {
    const { fetch, calls } = scriptedFetch([audioResponse([0])]);
    const client = makeClient(fetch);
    await client.tts({
      model: "s2.1-pro",
      text: "<|speaker:0|>Hi<|speaker:1|>Hey",
      referenceId: ["voice-a", "voice-b"],
    });
    expect(JSON.parse(calls[0]!.init.body as string).reference_id).toEqual(["voice-a", "voice-b"]);
  });

  it("does not send a Content-Type header on GET /model", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, { items: [], total: 0 })]);
    const client = makeClient(fetch);
    const result = await client.listModels({ pageSize: 10, pageNumber: 2, language: "en" });
    expect(result.ok).toBe(true);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://mock.fish.test/model?page_size=10&page_number=2&language=en");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("URL-encodes voice model ids on GET /model/{id}", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, { _id: "a b/c" })]);
    const client = makeClient(fetch);
    await client.getModel("a b/c");
    expect(calls[0]!.url).toBe("https://mock.fish.test/model/a%20b%2Fc");
  });

  it("sets Accept text/event-stream on the timestamped stream endpoint", async () => {
    const { fetch, calls } = scriptedFetch([sseResponse([])]);
    const client = makeClient(fetch);
    await client.ttsWithTimestamp({ model: "s2.1-pro", text: "aligned words" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("https://mock.fish.test/v1/tts/stream/with-timestamp");
    expect(headers["Accept"]).toBe("text/event-stream");
  });
});

describe("FishClient — response parsing", () => {
  it("parses the documented JSON error shape {message,status}", async () => {
    const { fetch } = scriptedFetch([jsonResponse(402, { message: "no credits", status: 402 })]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http-error");
      expect(result.error.status).toBe(402);
      expect(result.error.apiMsg).toBe("no credits");
      expect(result.error.apiStatus).toBe(402);
    }
  });

  it("parses SSE timestamp events into typed objects", async () => {
    const event = {
      audio_base64: "QUJD",
      content: "words here",
      alignment: {
        audio_duration: 1.2,
        segments: [
          { text: "words", start: 0, end: 0.6 },
          { text: "here", start: 0.6, end: 1.2 },
        ],
      },
      chunk_seq: 0,
      chunk_audio_offset_sec: 0,
    };
    const { fetch } = scriptedFetch([sseResponse([JSON.stringify(event)])]);
    const client = makeClient(fetch);
    const result = await client.ttsWithTimestamp({ model: "s2.1-pro", text: "words here" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.audioBase64).toBe("QUJD");
      expect(result.data[0]!.alignment?.segments).toEqual([
        { text: "words", start: 0, end: 0.6 },
        { text: "here", start: 0.6, end: 1.2 },
      ]);
      expect(result.data[0]!.chunkSeq).toBe(0);
      expect(result.data[0]!.chunkAudioOffsetSec).toBe(0);
    }
  });

  it("skips malformed SSE frames instead of failing the stream", async () => {
    const good = JSON.stringify({
      audio_base64: "WFla",
      content: "ok",
      alignment: null,
      chunk_seq: 1,
      chunk_audio_offset_sec: 1.5,
    });
    const body = "data: not-json\n\n: keepalive comment\n\ndata: \n\ndata: " + good + "\n\n";
    const { fetch } = scriptedFetch([new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })]);
    const client = makeClient(fetch);
    const result = await client.ttsWithTimestamp({ model: "s2.1-pro", text: "ok" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.chunkAudioOffsetSec).toBe(1.5);
      expect(result.data[0]!.alignment).toBeNull();
    }
  });

  it("returns raw bytes for binary (audio) 2xx responses", async () => {
    const { fetch } = scriptedFetch([audioResponse([9, 9, 9, 9])]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeInstanceOf(ArrayBuffer);
      expect(result.data.byteLength).toBe(4);
    }
  });
});

describe("FishClient — HTTP error mapping", () => {
  it("maps 401 to non-retryable http-error", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(401, { message: "unauthorized", status: 401 })]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http-error");
      expect(result.error.status).toBe(401);
      expect(result.error.attempt).toBe(1);
    }
    expect(calls).toHaveLength(1); // no retry on 401
  });

  it("maps 402 (no payment) to non-retryable http-error", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(402, { message: "payment required", status: 402 })]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("http-error");
    expect(calls).toHaveLength(1);
  });

  it("maps 503 to retryable server-error and retries then succeeds", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(503, { message: "overloaded", status: 503 }),
      audioResponse([1]),
    ]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("maps 429 to retryable rate-limited and honors Retry-After", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(429, { message: "slow down" }, { "Retry-After": "2" }),
      audioResponse([1]),
    ]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries 5xx then succeeds", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(500, { message: "boom" }), audioResponse([1])]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and reports the last error", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(500, { message: "boom" }),
      jsonResponse(500, { message: "boom" }),
      jsonResponse(500, { message: "boom" }),
    ]);
    const client = makeClient(fetch, { maxRetries: 3 });
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("server-error");
      expect(result.error.attempt).toBe(3);
    }
    expect(calls).toHaveLength(3);
  });
});

describe("FishClient — timeout and network", () => {
  it("classifies fetch AbortError as timeout and retries", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const { fetch, calls } = scriptedFetch([abort, audioResponse([1])]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("classifies TypeError as network failure and retries", async () => {
    const { fetch, calls } = scriptedFetch([new TypeError("fetch failed"), audioResponse([1])]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
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
    const { fetch } = scriptedFetch([jsonResponse(500, { message: "boom" }), audioResponse([1])]);
    const seen: Array<{ reason: string; attempt: number; path: string }> = [];
    const client = new FishClient(
      { apiKey: API_KEY, baseUrl: "https://mock.fish.test", sleep: instantSleep },
      {
        fetch,
        onRetry: (info) => seen.push({ reason: info.reason, attempt: info.attempt, path: info.path }),
      },
    );
    await client.tts({ ...TTS_OK });
    expect(seen).toEqual([{ reason: "server-error", attempt: 1, path: "/v1/tts" }]);
    // The retry callback must never receive the key or Authorization header.
    expect(JSON.stringify(seen)).not.toContain(API_KEY);
    expect(JSON.stringify(seen)).not.toContain("Bearer");
  });
});

describe("FishClient — key never leaks", () => {
  it("error messages never contain the API key", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(500, { message: "boom" }),
      jsonResponse(500, { message: "boom" }),
      jsonResponse(500, { message: "boom" }),
      jsonResponse(500, { message: "boom" }),
    ]);
    const client = makeClient(fetch, { maxRetries: 4 });
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(API_KEY);
    if (!result.ok) expect(result.error.message).not.toContain(API_KEY);
    expect(isRetryableError((result as { error: FishApiError }).error.kind)).toBe(true);
  });

  it("thrown errors never contain the API key (network class)", async () => {
    const { fetch } = scriptedFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const client = makeClient(fetch, { maxRetries: 2 });
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("server-supplied secret-shaped message text is scrubbed from errors", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(422, { message: `bad request key=${API_KEY} invalid`, status: 422 }),
    ]);
    const client = makeClient(fetch);
    const result = await client.tts({ ...TTS_OK });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("request URL never embeds the key (auth is header-only)", async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, { items: [], total: 0 })]);
    const client = makeClient(fetch);
    await client.listModels();
    expect(calls[0]!.url).not.toContain(API_KEY);
  });

  it("describe() never exposes the key", () => {
    const { fetch } = scriptedFetch([]);
    const client = makeClient(fetch);
    expect(client.describe()).toBe("FishClient(https://mock.fish.test)");
    expect(client.describe()).not.toContain(API_KEY);
  });
});

describe("FishClient — backoff behavior", () => {
  it("uses exponential backoff between attempts", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(500, { message: "boom" }),
      jsonResponse(500, { message: "boom" }),
      audioResponse([1]),
    ]);
    const client = new FishClient(
      {
        apiKey: API_KEY,
        baseUrl: "https://mock.fish.test",
        retryBackoffMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      { fetch },
    );
    await client.tts({ ...TTS_OK });
    expect(sleeps).toEqual([100, 200]);
  });

  it("honors Retry-After on 429 (capped)", async () => {
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      jsonResponse(429, { message: "slow down" }, { "Retry-After": "5" }),
      audioResponse([1]),
    ]);
    const client = new FishClient(
      {
        apiKey: API_KEY,
        baseUrl: "https://mock.fish.test",
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      { fetch },
    );
    await client.tts({ ...TTS_OK });
    expect(sleeps).toEqual([5000]);
  });
});