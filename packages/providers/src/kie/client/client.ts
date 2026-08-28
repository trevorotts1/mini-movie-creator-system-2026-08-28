/// <reference types="node" />
/**
 * Kie HTTP client — the transport shared by every Kie model adapter
 * (Seedance, Wan). Facts verified against docs.kie.ai on 2026-08-28
 * (see docs/provider-capabilities/kie.md):
 *   - Base URL: https://api.kie.ai
 *   - Auth: `Authorization: Bearer <KIE_API_KEY>` header on every request
 *   - Create: POST /api/v1/jobs/createTask  → {code, msg, data:{taskId}}
 *   - Query:  GET  /api/v1/jobs/recordInfo?taskId=... → {code, msg, data:{state,...}}
 *   - HTTP 200 on createTask means "task created", NOT "task completed".
 *   - 200-envelope `code` 200 = success; other codes are API errors.
 * This module owns ONLY transport concerns: bearer auth, JSON envelopes,
 * timeouts, bounded retries with backoff, and key-safe errors/logging.
 * Task state mapping and polling live in packages/providers/src/kie/task/.
 */
import {
  KieApiError,
  isRetryableError,
  type KieErrorKind,
} from "./errors.js";
import {
  resolveKieClientConfig,
  type KieClientConfig,
  type ResolvedKieClientConfig,
} from "./config.js";

/**
 * The Kie JSON envelope (verified 2026-08-28). Every /api/v1 response uses it;
 * `code` mirrors the HTTP status semantics (200 = OK).
 */
export interface KieEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

/** Response of POST /api/v1/jobs/createTask. */
export interface KieCreateTaskData {
  taskId: string;
}

/** Minimal typed view of GET /api/v1/jobs/recordInfo `data`. Raw pass-through
 * for the fields the task layer (KIE-002) maps; unknown fields preserved. */
export interface KieRecordInfoData {
  taskId?: string;
  model?: string;
  state?: string;
  param?: string;
  resultJson?: string | null;
  failCode?: string | null;
  failMsg?: string | null;
  costTime?: number;
  createTime?: number;
  updateTime?: number;
  completeTime?: number;
  creditsConsumed?: number;
  [key: string]: unknown;
}

/** A successful HTTP+envelope result. */
export interface KieSuccess<T> {
  ok: true;
  code: number;
  msg: string;
  data: T;
}

/** A terminal (non-retried) HTTP failure. */
export interface KieFailure {
  ok: false;
  error: KieApiError;
}

export type KieResult<T> = KieSuccess<T> | KieFailure;

/** Injectable HTTP transport — the seam tests mock. Signature mirrors `fetch`. */
export type KieFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A single Kie HTTP request. */
export interface KieRequest {
  /** Method. Default "POST". */
  method?: "GET" | "POST";
  /** Absolute path on the base URL, e.g. "/api/v1/jobs/createTask". */
  path: string;
  /** Query parameters; appended after `path`. Undefined/null skipped. */
  query?: Record<string, string | undefined>;
  /** JSON-serializable request body (POST only). */
  body?: unknown;
}

const REDACTED = "[REDACTED]";

/**
 * HTTP client for the Kie API. One instance per configured key; safe to share
 * across adapters. Bearer auth from config; per-attempt timeout; bounded
 * retries on network/timeout/429/5xx with exponential backoff; the API key is
 * never written to any error, log line, or thrown message.
 */
export class KieClient {
  private readonly cfg: ResolvedKieClientConfig;
  /** Optional structured logger; receives key-safe fields only. */
  private readonly onRetry?: (info: {
    path: string;
    method: string;
    attempt: number;
    nextBackoffMs: number;
    reason: KieErrorKind;
  }) => void;

  constructor(
    config: KieClientConfig,
    options?: {
      fetch?: KieFetch;
      onRetry?: (info: {
        path: string;
        method: string;
        attempt: number;
        nextBackoffMs: number;
        reason: KieErrorKind;
      }) => void;
    },
  ) {
    this.cfg = resolveKieClientConfig(config);
    this.fetchImpl = options?.fetch ?? globalThis.fetch;
    this.onRetry = options?.onRetry;
  }

  private readonly fetchImpl: KieFetch;

  /** Build the full URL (path + query) for a request. */
  private url(req: KieRequest): string {
    const base = this.cfg.baseUrl;
    const url = new URL(req.path, base.endsWith("/") ? base : base + "/");
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
   * as a `KieFailure` instead of throwing when all attempts fail.
   */
  async request<T>(req: KieRequest): Promise<KieResult<T>> {
    const method = req.method ?? "POST";
    const url = this.url(req);
    let lastError: KieApiError | undefined;

    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(method, url, req);
        if (response.ok) {
          return await this.parseSuccess<T>(response, attempt);
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
      error: lastError ?? new KieApiError({ kind: "network", message: "Kie request failed", attempt: this.cfg.maxRetries }),
    };
  }

  /** Convenience: POST /api/v1/jobs/createTask. */
  async createTask(body: {
    model: string;
    input: Record<string, unknown>;
    callBackUrl?: string;
  }): Promise<KieResult<KieCreateTaskData>> {
    return this.request<KieCreateTaskData>({ path: "/api/v1/jobs/createTask", body });
  }

  /** Convenience: GET /api/v1/jobs/recordInfo?taskId=… */
  async recordInfo(taskId: string): Promise<KieResult<KieRecordInfoData>> {
    return this.request<KieRecordInfoData>({
      method: "GET",
      path: "/api/v1/jobs/recordInfo",
      query: { taskId },
    });
  }

  // ---------------------------------------------------------------- internals

  private async fetchWithTimeout(method: string, url: string, req: KieRequest): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // Distinguish our deadline abort from other wire failures.
      if (err instanceof Error && err.name === "AbortError") {
        const timeout = new Error(`Kie request timed out after ${this.cfg.timeoutMs}ms`);
        timeout.name = "KieTimeoutError";
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Validate the 2xx body against the documented envelope. */
  private async parseSuccess<T>(response: Response, attempt: number): Promise<KieResult<T>> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        ok: false,
        error: new KieApiError({
          kind: "bad-response",
          message: `Kie returned HTTP ${response.status} with a non-object body`,
          attempt,
        }),
      };
    }
    const envelope = parsed as Partial<KieEnvelope<T>>;
    if (typeof envelope.code !== "number" || typeof envelope.msg !== "string") {
      return {
        ok: false,
        error: new KieApiError({
          kind: "bad-response",
          message: `Kie returned HTTP ${response.status} with a malformed envelope (missing code/msg)`,
          attempt,
        }),
      };
    }
    if (envelope.code !== 200) {
      // HTTP 2xx but envelope-level failure (rare; treat as terminal).
      return {
        ok: false,
        error: new KieApiError({
          kind: "http-error",
          message: `Kie envelope code ${envelope.code} on HTTP ${response.status}`,
          status: response.status,
          apiCode: envelope.code,
          apiMsg: envelope.msg,
          attempt,
        }),
      };
    }
    return {
      ok: true,
      code: envelope.code,
      msg: envelope.msg,
      data: envelope.data as T,
    };
  }

  /** Map a non-2xx HTTP response onto the error taxonomy. */
  private async httpError(response: Response, attempt: number): Promise<KieApiError> {
    const status = response.status;
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfterSec = retryAfterRaw !== null ? Number.parseInt(retryAfterRaw, 10) : undefined;
    const kind: KieErrorKind =
      status === 429 ? "rate-limited" : status >= 500 && status <= 599 ? "server-error" : "http-error";

    let apiCode: number | undefined;
    let apiMsg: string | undefined;
    try {
      const body = (await response.json()) as Partial<KieEnvelope>;
      if (body && typeof body === "object") {
        if (typeof body.code === "number") apiCode = body.code;
        if (typeof body.msg === "string") apiMsg = body.msg;
      }
    } catch {
      // Non-JSON error body; status alone is enough (never log the raw body —
      // it can echo request parameters).
    }

    return new KieApiError({
      kind,
      message: `Kie API HTTP ${status}${apiCode !== undefined ? ` (code ${apiCode})` : ""}`,
      status,
      apiCode,
      apiMsg,
      retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
      attempt,
    });
  }

  /** Map a thrown wire error (network/reset/timeout) onto the taxonomy. */
  private wireError(err: unknown, attempt: number): KieApiError {
    if (err instanceof KieApiError) return err;
    if (err instanceof Error && err.name === "KieTimeoutError") {
      return new KieApiError({ kind: "timeout", message: err.message, attempt });
    }
    const detail = err instanceof Error ? err.message : String(err);
    // fetch throws TypeError on network failure; anything else is still a wire failure.
    return new KieApiError({ kind: "network", message: `Kie request failed: ${detail}`, attempt });
  }

  /** Exponential backoff; 429 honors a server Retry-After when sane. */
  private backoffFor(attempt: number, error: KieApiError): number {
    if (error.kind === "rate-limited" && error.retryAfterSec !== undefined && error.retryAfterSec > 0) {
      return Math.min(error.retryAfterSec * 1000, 30_000);
    }
    return this.cfg.retryBackoffMs * 2 ** (attempt - 1);
  }

  /** Key-safe string form of this client's identity (for logs). */
  describe(): string {
    return `KieClient(${this.cfg.baseUrl})`;
  }
}