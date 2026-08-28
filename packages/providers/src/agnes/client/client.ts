/// <reference types="node" />
/**
 * Agnes HTTP client — the transport shared by every Agnes model adapter
 * (video 2.5 / 2.5-flash, image 2.1-flash). Facts verified against the live
 * official Agnes AI docs on 2026-08-28 (see
 * docs/provider-capabilities/agnes.md):
 *   - Base URL: https://apihub.agnes-ai.com/v1 (OpenAI-compatible)
 *   - Auth: `Authorization: Bearer <AGNES_API_KEY>` header on every request
 *   - Create video task: POST /v1/videos  → 202/200 with the task object
 *   - Query task (async retrieval): GET /agnesapi?video_id=...&model_name=...
 *   - 2xx with the task object means "task accepted", NOT "task completed".
 * This module owns ONLY transport concerns: bearer auth, JSON bodies,
 * timeouts, bounded retries with backoff, and key-safe errors/logging.
 * Task state mapping and polling live in the downstream agnes adapters
 * (AGN-002 video submit / AGN-005 video poll).
 */
import {
  AgnesApiError,
  isRetryableError,
  isRetryableStatus,
  type AgnesErrorKind,
} from "./errors.js";
import {
  resolveAgnesClientConfig,
  AGNES_MAX_RETRY_AFTER_MS,
  type AgnesClientConfig,
  type ResolvedAgnesClientConfig,
} from "./config.js";

/**
 * The Agnes video task object returned by POST /v1/videos and
 * GET /agnesapi (verified 2026-08-28). Unknown fields preserved.
 */
export interface AgnesVideoTask {
  /** Same as task_id. */
  id?: string;
  task_id?: string;
  /** Use for retrieval; returned on create. */
  video_id?: string;
  object?: string;
  model?: string;
  status?: "queued" | "in_progress" | "completed" | "failed";
  progress?: number;
  created_at?: number; // Unix timestamp (seconds)
  completed_at?: number | null;
  seconds?: string;
  size?: string;
  metadata?: { url?: string | null; size_mapping?: unknown } | null;
  error?: { message?: string } | null;
  [key: string]: unknown;
}

/** A successful HTTP result (2xx with a parseable object body). */
export interface AgnesSuccess<T> {
  ok: true;
  status: number;
  data: T;
}

/** A terminal (non-retried) HTTP failure. */
export interface AgnesFailure {
  ok: false;
  error: AgnesApiError;
}

export type AgnesResult<T> = AgnesSuccess<T> | AgnesFailure;

/** Injectable HTTP transport — the seam tests mock. Signature mirrors `fetch`. */
export type AgnesFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Thrown when the per-attempt deadline expires (fetch or body read). */
class AgnesTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agnes request timed out after ${timeoutMs}ms`);
    this.name = "AgnesTimeoutError";
  }
}

/**
 * One attempt's deadline. Covers the WHOLE request — headers AND body — so a
 * server that accepts fast but drips the body cannot hang the client past
 * timeoutMs (spec §29: bounded timeouts). The AbortSignal is handed to fetch
 * and stays armed until `clear()`; aborting a Response body makes the pending
 * `.json()` reject.
 */
class Deadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private done = false;
  private fired = false;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
      this.onFire?.();
    }, timeoutMs);
    this.signal = this.controller.signal;
  }

  /** True when the deadline fired (as opposed to a caller-initiated clear). */
  get timedOut(): boolean {
    return this.fired;
  }

  /** Read a Response body as JSON; an abort mid-read surfaces as AgnesTimeoutError. */
  async readJson(response: Response): Promise<unknown> {
    // Race the body read against the deadline: real fetch links the signal to
    // the body stream, but mocks may not — the race guarantees the client
    // itself never blocks past timeoutMs regardless of transport behavior.
    const bodyPromise = response.json();
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (this.fired) {
        reject(new AgnesTimeoutError(this.timeoutMs));
        return;
      }
      this.onFire = () => reject(new AgnesTimeoutError(this.timeoutMs));
    });
    try {
      return await Promise.race([bodyPromise, timeoutPromise]);
    } finally {
      this.onFire = undefined;
      // A lost race leaves the body stream open; cancel it so the
      // underlying socket (or mock) is released instead of dangling.
      if (this.fired) void bodyPromise.catch(() => {}).then(() => response.body?.cancel().catch(() => {}));
    }
  }

  /** Fired by the timer; wakes any in-flight readJson race. */
  private onFire?: () => void;

  /** Configured timeout, retained so readJson can name it in the error. */
  private readonly timeoutMs: number;

  /** Stop the timer; harmless if already fired. Idempotent. */
  clear(): void {
    if (!this.done) {
      this.done = true;
      clearTimeout(this.timer);
    }
  }
}

/** A single Agnes HTTP request. */
export interface AgnesRequest {
  /** Method. Default "POST". */
  method?: "GET" | "POST";
  /**
   * Absolute path on the base URL, e.g. "/v1/videos". A path that is not
   * under the configured base URL is used as-is (Agnes routes task
   * retrieval at /agnesapi, one level ABOVE /v1).
   */
  path: string;
  /** Query parameters; appended after `path`. Undefined/null skipped. */
  query?: Record<string, string | undefined>;
  /** JSON-serializable request body (POST only). */
  body?: unknown;
}

/**
 * HTTP client for the Agnes API. One instance per configured key; safe to
 * share across adapters. Bearer auth from config; per-attempt timeout;
 * bounded retries on network/timeout/429/5xx with exponential backoff; the
 * API key is never written to any error, log line, or thrown message.
 */
export class AgnesClient {
  private readonly cfg: ResolvedAgnesClientConfig;
  /** Optional structured logger; receives key-safe fields only. */
  private readonly onRetry?: (info: {
    path: string;
    method: string;
    attempt: number;
    nextBackoffMs: number;
    reason: AgnesErrorKind;
  }) => void;

  constructor(
    config: AgnesClientConfig,
    options?: {
      fetch?: AgnesFetch;
      onRetry?: (info: {
        path: string;
        method: string;
        attempt: number;
        nextBackoffMs: number;
        reason: AgnesErrorKind;
      }) => void;
    },
  ) {
    this.cfg = resolveAgnesClientConfig(config);
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.onRetry = options?.onRetry;
  }

  private readonly fetchImpl: AgnesFetch;

  /** Build the full URL (path + query) for a request, pinned to the configured host. */
  private url(req: AgnesRequest): string {
    // Paths like "/agnesapi" are outside /v1 — join at the host root.
    const baseUrl = new URL(this.cfg.baseUrl);
    const root = new URL("/", baseUrl);
    const target = req.path.startsWith("/") ? root : baseUrl;
    let url: URL;
    try {
      url = new URL(req.path, target);
    } catch {
      throw new Error(`AgnesClient: invalid request path: ${req.path}`);
    }
    // Host pinning (spec §29): an absolute req.path (e.g. "//evil.example/x")
    // would otherwise escape the configured base URL and leak the bearer
    // header to a third-party host.
    if (url.origin !== baseUrl.origin) {
      throw new Error(`AgnesClient: request path must stay on the configured host (got ${url.origin})`);
    }
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  /**
   * Send one request with timeout + bounded retries. Returns the last failure
   * as an `AgnesFailure` instead of throwing when all attempts fail.
   */
  async request<T>(req: AgnesRequest): Promise<AgnesResult<T>> {
    const method = req.method ?? "POST";
    const url = this.url(req);
    let lastError: AgnesApiError | undefined;

    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      const deadline = new Deadline(this.cfg.timeoutMs);
      try {
        const response = await this.fetchWithTimeout(deadline, method, url, req);
        if (response.ok) {
          return await this.parseSuccess<T>(response, attempt, deadline);
        }
        const error = await this.httpError(response, attempt, deadline);
        deadline.clear();
        if (!isRetryableError(error.kind)) {
          return { ok: false, error };
        }
        // Auto-retrying a paid job POST is NOT idempotent — a timed-out 5xx
        // may still have created a video task (paid duplicate generation,
        // runbook §21 provider URL/job idempotency). Retries are limited to
        // GET: the next attempt re-reads state instead of re-creating it.
        // Submit retry policy belongs to AGN-010 (idempotency keys).
        if (method === "POST" && isRetryableStatus(error.status)) {
          return { ok: false, error };
        }
        lastError = error;
      } catch (err) {
        deadline.clear();
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
          method,
          attempt,
          nextBackoffMs: backoff,
          reason: lastError.kind,
        });
        await this.cfg.sleep(backoff);
      }
    }

    return {
      ok: false,
      error: lastError ?? new AgnesApiError({ kind: "network", message: "Agnes request failed", attempt: this.cfg.maxRetries }),
    };
  }

  /** Convenience: POST /v1/videos (create a video generation task). */
  async createVideo(body: Record<string, unknown>): Promise<AgnesResult<AgnesVideoTask>> {
    return this.request<AgnesVideoTask>({ path: "/v1/videos", body });
  }

  /** Convenience: GET /agnesapi?video_id=…&model_name=… (poll task status). */
  async getVideo(videoId: string, modelName?: string): Promise<AgnesResult<AgnesVideoTask>> {
    return this.request<AgnesVideoTask>({
      method: "GET",
      path: "/agnesapi",
      query: { video_id: videoId, ...(modelName !== undefined ? { model_name: modelName } : {}) },
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * One attempt under a shared Deadline: the deadline covers the WHOLE
   * request — headers AND body — so a server that drips bytes cannot hang
   * the client past timeoutMs (spec §29: bounded timeouts). The abort
   * controller is shared with the Response, so body reads abort too.
   */
  private async fetchWithTimeout(
    deadline: Deadline,
    method: string,
    url: string,
    req: AgnesRequest,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
        signal: deadline.signal,
      });
    } catch (err) {
      // Distinguish our deadline abort from other wire failures.
      if (err instanceof Error && err.name === "AbortError" && deadline.timedOut) {
        throw new AgnesTimeoutError(this.cfg.timeoutMs);
      }
      throw err;
    }
  }

  /** Validate the 2xx body: any JSON object is accepted (Agnes has no envelope). */
  private async parseSuccess<T>(response: Response, attempt: number, deadline: Deadline): Promise<AgnesResult<T>> {
    let parsed: unknown;
    try {
      parsed = await deadline.readJson(response);
    } catch (err) {
      // Deadline fired mid-body-read: that is a TIMEOUT, not a bad body.
      if (deadline.timedOut || (err instanceof Error && err.name === "AgnesTimeoutError")) throw err;
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        ok: false,
        error: new AgnesApiError({
          kind: "bad-response",
          message: `Agnes returned HTTP ${response.status} with a non-object body`,
          attempt,
        }),
      };
    }
    return {
      ok: true,
      status: response.status,
      data: parsed as T,
    };
  }

  /** Map a non-2xx HTTP response onto the error taxonomy (body read under deadline). */
  private async httpError(response: Response, attempt: number, deadline: Deadline): Promise<AgnesApiError> {
    const status = response.status;
    const retryAfterRaw = response.headers.get("retry-after");
    let retryAfterSec: number | undefined;
    if (retryAfterRaw !== null) {
      const parsed = Number.parseInt(retryAfterRaw, 10);
      // Bounded: ignore unparsable values, clamp huge ones (spec §29 —
      // no unbounded waits; 5 minutes is already generous for this API).
      retryAfterSec =
        Number.isFinite(parsed) && parsed >= 1
          ? Math.min(parsed, AGNES_MAX_RETRY_AFTER_MS / 1000)
          : undefined;
    }
    const kind: AgnesErrorKind =
      status === 429 ? "rate-limited" : status >= 500 && status <= 599 ? "server-error" : "http-error";

    let apiMsg: string | undefined;
    try {
      const body = (await deadline.readJson(response)) as {
        error?: { message?: string } | string;
        message?: string;
        msg?: string;
      };
      if (body && typeof body === "object") {
        const err = body.error;
        if (typeof err === "object" && err !== null && typeof err.message === "string") apiMsg = err.message;
        else if (typeof err === "string") apiMsg = err;
        else if (typeof body.message === "string") apiMsg = body.message;
        else if (typeof body.msg === "string") apiMsg = body.msg;
      }
    } catch (err) {
      // Deadline fired mid-body-read: that is a TIMEOUT, not a bad body.
      if (deadline.timedOut || (err instanceof Error && err.name === "AgnesTimeoutError")) throw err;
      // Non-JSON error body; status alone is enough (never log the raw body —
      // it can echo request parameters).
    }

    return new AgnesApiError({
      kind,
      message: `Agnes API HTTP ${status}${apiMsg !== undefined ? `: ${apiMsg}` : ""}`,
      status,
      apiMsg,
      retryAfterSec: retryAfterSec ?? undefined,
      attempt,
    });
  }

  /** Map a thrown wire error (network/reset/timeout) onto the taxonomy. */
  private wireError(err: unknown, attempt: number): AgnesApiError {
    if (err instanceof AgnesApiError) return err;
    if (err instanceof Error && err.name === "AgnesTimeoutError") {
      return new AgnesApiError({ kind: "timeout", message: err.message, attempt });
    }
    const detail = err instanceof Error ? err.message : String(err);
    // fetch throws TypeError on network failure; anything else is still a wire failure.
    return new AgnesApiError({ kind: "network", message: `Agnes request failed: ${detail}`, attempt });
  }

  /** Exponential backoff; 429 honors a server Retry-After when sane. */
  private backoffFor(attempt: number, error: AgnesApiError): number {
    // Retry-After is already clamped to 300s at parse time (httpError); this
    // second bound is defense-in-depth against a future taxonomy change.
    if (error.kind === "rate-limited" && error.retryAfterSec !== undefined && error.retryAfterSec > 0) {
      return Math.min(error.retryAfterSec * 1000, AGNES_MAX_RETRY_AFTER_MS);
    }
    return this.cfg.retryBackoffMs * 2 ** (attempt - 1);
  }

  /** Key-safe string form of this client's identity (for logs). */
  describe(): string {
    return `AgnesClient(${this.cfg.baseUrl})`;
  }
}
