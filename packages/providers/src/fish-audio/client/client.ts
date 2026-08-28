/// <reference types="node" />
/**
 * Fish Audio HTTP client — shared transport for the Fish subsystem (FISH-001).
 * Facts verified against the official OpenAPI schema on 2026-08-28
 * (see docs/provider-capabilities/fish.md):
 *   - Base URL: https://api.fish.audio
 *   - Auth: `Authorization: Bearer <FISH_API_KEY>` (BearerAuth security scheme)
 *   - TTS: POST /v1/tts, JSON or msgpack body → binary audio (Content-Type
 *     per requested format: mp3/wav/pcm/opus)
 *   - Model selection: optional `model` HTTP header; documented values
 *     `s1`, `s2-pro`, `s2.1-pro`, `s2.1-pro-free`. If omitted/unrecognized the
 *     server falls back to `s2.1-pro`. MMCS passes the model from config —
 *     `s2.1-pro-free` is recorded but never assumed (fair-use free tier,
 *     no TTFA/DPA guarantees; pricing is config-driven, not hardcoded).
 *   - Errors: JSON body `{message, status}`; documented TTS statuses
 *     401 (no permission), 402 (no payment), 503 (overloaded), plus 429.
 *   - Voice models: GET /model (list), GET /model/{id}.
 *   - Timestamped streaming: POST /v1/tts/stream/with-timestamp (SSE).
 * This module owns ONLY transport concerns: bearer auth, JSON bodies,
 * binary responses, timeouts, bounded retries with backoff, and key-safe
 * errors/logging. Voice profile storage (FISH-002), synthesis jobs and
 * dialogue caching (FISH-003/005), and alignment/captions (FISH-006/007)
 * live in their own packages.
 */
import {
  FishApiError,
  isRetryableError,
  type FishErrorKind,
} from "./errors.js";
import {
  resolveFishClientConfig,
  type FishClientConfig,
  type FishTtsModel,
} from "./config.js";

/**
 * A single Fish Audio TTS request. Field names mirror the documented
 * `TTSRequest` schema (verified 2026-08-28); `reference_id` accepts either a
 * single voice-model ID (string) or an array of IDs for S2-family
 * multi-speaker dialogue. `text` is the only required field server-side.
 */
export interface FishTtsRequest {
  text: string;
  /** Voice model ID(s). String = single speaker; array = S2-family dialogue. */
  referenceId?: string | string[];
  temperature?: number;
  topP?: number;
  /** Speed 0.5–2.0, volume dB. Mapped to the documented `prosody` object. */
  prosody?: { speed?: number; volume?: number; normalizeLoudness?: boolean };
  chunkLength?: number;
  normalize?: boolean;
  format?: "wav" | "pcm" | "mp3" | "opus";
  sampleRate?: number;
  mp3Bitrate?: 64 | 128 | 192;
  latency?: "low" | "normal" | "balanced";
  maxNewTokens?: number;
  repetitionPenalty?: number;
  minChunkLength?: number;
  conditionOnPreviousChunks?: boolean;
  earlyStopThreshold?: number;
}

/**
 * One alignment snapshot from the timestamped stream: word segments in
 * chunk-local seconds plus total audio duration. Replace-on-update semantics:
 * a newer snapshot for the same `chunkSeq` REPLACES the old one (server
 * contract), it is never appended.
 */
export interface FishAlignmentSegment {
  text: string;
  start: number;
  end: number;
}

export interface FishTimestampStreamEvent {
  /** Base64-encoded audio chunk; concatenate in arrival order. */
  audioBase64: string;
  /** Text content described by this event's latest alignment snapshot. */
  content: string;
  alignment: { segments: FishAlignmentSegment[]; audioDuration: number } | null;
  chunkSeq: number;
  /** Absolute start time of this text chunk within the full audio, seconds. */
  chunkAudioOffsetSec: number;
}

/**
 * Minimal typed view of a voice model from GET /model or GET /model/{id}.
 * Unknown fields are preserved by the caller via the raw pass-through.
 */
export interface FishModelEntity {
  _id: string;
  type?: string;
  title?: string;
  description?: string;
  state?: string;
  languages?: string[];
  tags?: string[];
  [key: string]: unknown;
}

/** A successful result. */
export interface FishSuccess<T> {
  ok: true;
  data: T;
}

/** A terminal (non-retried) failure. */
export interface FishFailure {
  ok: false;
  error: FishApiError;
}

export type FishResult<T> = FishSuccess<T> | FishFailure;

/** Injectable HTTP transport — the seam tests mock. Signature mirrors `fetch`. */
export type FishFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Query options for GET /model (voice model listing). */
export interface FishModelQuery {
  pageSize?: number;
  pageNumber?: number;
  title?: string;
  language?: string;
  self?: boolean;
  sortBy?: string;
}

/**
 * HTTP client for the Fish Audio API. One instance per configured key; safe
 * to share across the Fish adapters. Bearer auth from config; per-attempt
 * timeout; bounded retries on network/timeout/429/5xx with exponential
 * backoff; the API key is never written to any error, log line, URL, or
 * thrown message.
 */
export class FishClient {
  private readonly cfg: ReturnType<typeof resolveFishClientConfig>;
  private readonly fetchImpl: FishFetch;
  /** Optional structured logger; receives key-safe fields only. */
  private readonly onRetry?: (info: {
    path: string;
    method: string;
    attempt: number;
    nextBackoffMs: number;
    reason: FishErrorKind;
  }) => void;

  constructor(
    config: FishClientConfig,
    options?: {
      fetch?: FishFetch;
      onRetry?: (info: {
        path: string;
        method: string;
        attempt: number;
        nextBackoffMs: number;
        reason: FishErrorKind;
      }) => void;
    },
  ) {
    this.cfg = resolveFishClientConfig(config);
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.onRetry = options?.onRetry;
  }

  /**
   * Send one request with timeout + bounded retries. Returns the last failure
   * as a `FishFailure` instead of throwing when all attempts fail.
   */
  async request<T>(req: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<FishResult<T>> {
    const url = this.url(req.path, req.query);
    let lastError: FishApiError | undefined;

    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(req, url);
        if (response.ok) {
          return { ok: true, data: (await this.parseBody(response)) as T };
        }
        const error = await this.httpError(response, attempt);
        if (!isRetryableError(error.kind)) {
          return { ok: false, error };
        }
        lastError = error;
      } catch (err) {
        lastError = this.wireError(err, attempt);
        if (!isRetryableError(lastError.kind)) {
          return { ok: false, error: lastError };
        }
      }

      // Back off before the next attempt (not after the final one).
      if (attempt < this.cfg.maxRetries) {
        const backoff = this.backoffFor(attempt, lastError);
        this.onRetry?.({
          path: req.path,
          method: req.method,
          attempt,
          nextBackoffMs: backoff,
          reason: lastError.kind,
        });
        await this.cfg.sleep(backoff);
      }
    }

    return {
      ok: false,
      error:
        lastError ??
        new FishApiError({
          kind: "network",
          message: "Fish Audio request failed",
          attempt: this.cfg.maxRetries,
        }),
    };
  }

  /**
   * POST /v1/tts — synthesize speech. The requested TTS model travels in the
   * `model` HTTP header (server contract); `request.model` is REQUIRED from
   * config. Returns raw audio bytes in the requested format.
   */
  async tts(request: FishTtsRequest & { model: FishTtsModel }): Promise<FishResult<ArrayBuffer>> {
    return this.request<ArrayBuffer>({
      method: "POST",
      path: "/v1/tts",
      headers: { model: request.model },
      body: this.ttsBody(request),
    });
  }

  /**
   * POST /v1/tts/stream/with-timestamp — streaming synthesis with word
   * alignment. Consumes the full Server-Sent Events stream and returns the
   * events (audio chunks base64 + cumulative alignment snapshots); callers
   * (FISH-006/007) own concatenation and snapshot bucketing.
   */
  async ttsWithTimestamp(
    request: FishTtsRequest & { model: FishTtsModel },
  ): Promise<FishResult<FishTimestampStreamEvent[]>> {
    return this.request<FishTimestampStreamEvent[]>({
      method: "POST",
      path: "/v1/tts/stream/with-timestamp",
      headers: { model: request.model, Accept: "text/event-stream" },
      body: this.ttsBody(request),
    });
  }

  /** GET /model — list voice models (Fish community + custom voices). */
  async listModels(query: FishModelQuery = {}): Promise<FishResult<FishModelEntity[]>> {
    return this.request<FishModelEntity[]>({
      method: "GET",
      path: "/model",
      query: {
        page_size: query.pageSize,
        page_number: query.pageNumber,
        title: query.title,
        language: query.language,
        self: query.self,
        sort_by: query.sortBy,
      },
    });
  }

  /** GET /model/{id} — fetch one voice model. */
  async getModel(id: string): Promise<FishResult<FishModelEntity>> {
    return this.request<FishModelEntity>({ method: "GET", path: `/model/${encodeURIComponent(id)}` });
  }

  // ---------------------------------------------------------------- internals

  /** Map the typed request onto the documented JSON body (camelCase → snake). */
  private ttsBody(request: FishTtsRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { text: request.text };
    if (request.referenceId !== undefined) body.reference_id = request.referenceId;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.prosody !== undefined) {
      const prosody: Record<string, unknown> = {};
      if (request.prosody.speed !== undefined) prosody.speed = request.prosody.speed;
      if (request.prosody.volume !== undefined) prosody.volume = request.prosody.volume;
      if (request.prosody.normalizeLoudness !== undefined) {
        prosody.normalize_loudness = request.prosody.normalizeLoudness;
      }
      body.prosody = prosody;
    }
    if (request.chunkLength !== undefined) body.chunk_length = request.chunkLength;
    if (request.normalize !== undefined) body.normalize = request.normalize;
    if (request.format !== undefined) body.format = request.format;
    if (request.sampleRate !== undefined) body.sample_rate = request.sampleRate;
    if (request.mp3Bitrate !== undefined) body.mp3_bitrate = request.mp3Bitrate;
    if (request.latency !== undefined) body.latency = request.latency;
    if (request.maxNewTokens !== undefined) body.max_new_tokens = request.maxNewTokens;
    if (request.repetitionPenalty !== undefined) body.repetition_penalty = request.repetitionPenalty;
    if (request.minChunkLength !== undefined) body.min_chunk_length = request.minChunkLength;
    if (request.conditionOnPreviousChunks !== undefined) {
      body.condition_on_previous_chunks = request.conditionOnPreviousChunks;
    }
    if (request.earlyStopThreshold !== undefined) body.early_stop_threshold = request.earlyStopThreshold;
    return body;
  }

  private url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const base = this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/";
    const url = new URL(path.replace(/^\//, ""), base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async fetchWithTimeout(
    req: { method: "GET" | "POST"; headers?: Record<string, string>; body?: unknown },
    url: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          ...(req.method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...req.headers,
        },
        ...(req.method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // Distinguish our deadline abort from other wire failures.
      if (err instanceof Error && err.name === "AbortError") {
        const timeout = new Error(`Fish Audio request timed out after ${this.cfg.timeoutMs}ms`);
        timeout.name = "FishTimeoutError";
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse a 2xx body: JSON when the content type says JSON, otherwise raw
   * bytes (POST /v1/tts returns binary audio in the requested format).
   */
  private async parseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    if (contentType.startsWith("text/event-stream")) {
      const text = await response.text();
      return this.parseSseEvents(text);
    }
    return response.arrayBuffer();
  }

  /**
   * Parse the documented SSE format of /v1/tts/stream/with-timestamp:
   * `data: {json}\n\n` frames, each a TTSTimestampStreamEvent. Unknown frames
   * (comments, keepalives) are skipped.
   */
  private parseSseEvents(text: string): FishTimestampStreamEvent[] {
    const events: FishTimestampStreamEvent[] = [];
    for (const frame of text.split("\n\n")) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        try {
          // Raw SSE frames use the documented snake_case wire names.
          const parsed = JSON.parse(payload) as {
            audio_base64?: unknown;
            content?: unknown;
            alignment?: { segments?: { text?: unknown; start?: unknown; end?: unknown }[]; audio_duration?: unknown } | null;
            chunk_seq?: unknown;
            chunk_audio_offset_sec?: unknown;
          };
          if (typeof parsed.audio_base64 === "string") {
            const align = parsed.alignment;
            const segments =
              align && Array.isArray(align.segments)
                ? align.segments.filter(
                    (s): s is { text: string; start: number; end: number } =>
                      typeof s?.text === "string" && typeof s?.start === "number" && typeof s?.end === "number",
                  )
                : [];
            events.push({
              audioBase64: parsed.audio_base64,
              content: typeof parsed.content === "string" ? parsed.content : "",
              alignment:
                align && Array.isArray(align.segments)
                  ? { audioDuration: typeof align.audio_duration === "number" ? align.audio_duration : 0, segments }
                  : null,
              chunkSeq: typeof parsed.chunk_seq === "number" ? parsed.chunk_seq : 0,
              chunkAudioOffsetSec:
                typeof parsed.chunk_audio_offset_sec === "number" ? parsed.chunk_audio_offset_sec : 0,
            });
          }
        } catch {
          // Malformed event frame: skip it rather than fail the whole stream.
        }
      }
    }
    return events;
  }

  /** Map a non-2xx HTTP response onto the error taxonomy. */
  private async httpError(response: Response, attempt: number): Promise<FishApiError> {
    const status = response.status;
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfterSec = retryAfterRaw !== null ? Number.parseInt(retryAfterRaw, 10) : undefined;
    const kind: FishErrorKind =
      status === 429 ? "rate-limited" : status >= 500 && status <= 599 ? "server-error" : "http-error";

    let apiMsg: string | undefined;
    let apiStatus: number | undefined;
    try {
      // Documented error body: {"message": "...", "status": <int>}.
      const body = (await response.json()) as { message?: unknown; status?: unknown };
      if (body && typeof body === "object") {
        if (typeof body.message === "string") apiMsg = body.message;
        if (typeof body.status === "number") apiStatus = body.status;
      }
    } catch {
      // Non-JSON error body; status alone is enough (never log the raw body —
      // it can echo request text).
    }

    return new FishApiError({
      kind,
      message: `Fish Audio API HTTP ${status}`,
      status,
      apiMsg,
      apiStatus,
      retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
      attempt,
    });
  }

  /** Map a thrown wire error (network/reset/timeout) onto the taxonomy. */
  private wireError(err: unknown, attempt: number): FishApiError {
    if (err instanceof FishApiError) return err;
    if (err instanceof Error && err.name === "FishTimeoutError") {
      return new FishApiError({ kind: "timeout", message: err.message, attempt });
    }
    const detail = err instanceof Error ? err.message : String(err);
    // fetch throws TypeError on network failure; anything else is still a wire failure.
    return new FishApiError({ kind: "network", message: `Fish Audio request failed: ${detail}`, attempt });
  }

  /** Exponential backoff; 429 honors a server Retry-After when sane. */
  private backoffFor(attempt: number, error: FishApiError): number {
    if (error.kind === "rate-limited" && error.retryAfterSec !== undefined && error.retryAfterSec > 0) {
      return Math.min(error.retryAfterSec * 1000, 30_000);
    }
    return this.cfg.retryBackoffMs * 2 ** (attempt - 1);
  }

  /** Key-safe string form of this client's identity (for logs). */
  describe(): string {
    return `FishClient(${this.cfg.baseUrl})`;
  }
}