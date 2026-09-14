/// <reference types="node" />

/**
 * Retry/error classification for GHL Media Storage calls (MMCS task GHL-011).
 *
 * Not every failure deserves a retry. Spec §35.3: never regenerate expensive
 * media merely because archival failed — and retrying a request that already
 * succeeded server-side would create a duplicate GHL file. So classification
 * is deliberate:
 *
 * - Transport faults (network reset, timeout, DNS) → retryable; the request
 *   plausibly never reached GHL, but callers still wrap the operation in an
 *   idempotency-key guard so a retry after a lost success response reuses
 *   the recorded original result instead of re-uploading.
 * - HTTP 429 / 5xx (except 501) → retryable, transient server trouble. A 429
 *   carries the server's own pacing hints (`Retry-After` and the five
 *   documented `X-RateLimit-*` headers, docs/provider-capabilities/ghl.md:
 *   burst 100 req / 10 s, daily 200,000) so the retry waits what the server
 *   asked for instead of a blind exponential delay.
 * - 408 request timeout → retryable.
 * - 4xx validation/auth/permission/not-found (400/401/403/404/409/422…) →
 *   NOT retryable: a deterministic failure repeats identically.
 * - 501 Not Implemented → NOT retryable: server-side capability gap.
 * - Caller cancellation (`AbortError`) → NOT retryable: retrying a cancelled
 *   call ignores the caller's stop signal and keeps the process alive after
 *   shutdown was requested. A timeout abort (`TimeoutError`, what
 *   `AbortSignal.timeout()` produces) IS retryable — nobody cancelled it.
 */

/** Minimal HTTP-shaped fault the retry policy can retry. */
export class GhlRetryableHttpError extends Error {
  readonly status: number;
  /** Response body excerpt. May echo request data; callers never log secrets. */
  readonly body: string;
  /**
   * Server-requested delay before the next attempt, in ms, from `Retry-After`
   * (delta-seconds or HTTP-date) — undefined when the server sent neither.
   */
  readonly retryAfterMs?: number;
  /** Parsed `X-RateLimit-*` snapshot, when the response carried one. */
  readonly rateLimit?: GhlRateLimitSnapshot;

  constructor(
    status: number,
    body: string,
    hints: { retryAfterMs?: number; rateLimit?: GhlRateLimitSnapshot } = {},
  ) {
    super(`GHL media API transient failure with status ${status}`);
    this.name = "GhlRetryableHttpError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = hints.retryAfterMs;
    this.rateLimit = hints.rateLimit;
  }
}

/**
 * The five documented `X-RateLimit-*` response headers (ghl.md). Parsed
 * numbers only; an absent or non-numeric header stays undefined so callers can
 * tell "not sent" from "sent as zero".
 */
export interface GhlRateLimitSnapshot {
  /** `X-RateLimit-Limit-Daily` — the daily request allowance. */
  readonly limitDaily?: number;
  /** `X-RateLimit-Daily-Remaining` — 0 means the daily quota is spent. */
  readonly dailyRemaining?: number;
  /** `X-RateLimit-Interval-Milliseconds` — the burst window length. */
  readonly intervalMilliseconds?: number;
  /** `X-RateLimit-Max` — requests allowed per burst window. */
  readonly max?: number;
  /** `X-RateLimit-Remaining` — requests left in the current burst window. */
  readonly remaining?: number;
}

/** Header bag a transport can hand over: a fetch `Headers` or a plain record. */
export type GhlResponseHeaders =
  | { get(name: string): string | null }
  | Record<string, string | undefined>;

/**
 * Error type that must never be retried. Transports construct it for
 * deterministic refusals (auth/validation/permission), i.e. cases where the
 * request was rejected and provably created nothing — which is why
 * `withArchivalIdempotency` may release its reservation on this error and
 * leave the key reusable.
 */
export class GhlNonRetryableError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GhlNonRetryableError";
    this.cause = cause;
  }
}

export type RetryDecision = "retry" | "stop";

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** Read one header case-insensitively from either supported header bag. */
export function readResponseHeader(
  headers: GhlResponseHeaders | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(n: string): string | null }).get(name);
    return value === null ? undefined : value;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | undefined>)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse `Retry-After` per RFC 9110: either delta-seconds ("2") or an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns milliseconds to wait, never
 * negative; undefined when absent/unparseable.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = parseNumber(trimmed);
  if (seconds !== undefined) return seconds <= 0 ? 0 : seconds * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Parse the documented `X-RateLimit-*` headers; undefined when none present. */
export function parseRateLimitHeaders(
  headers: GhlResponseHeaders | undefined,
): GhlRateLimitSnapshot | undefined {
  const limitDaily = parseNumber(readResponseHeader(headers, "X-RateLimit-Limit-Daily"));
  const dailyRemaining = parseNumber(readResponseHeader(headers, "X-RateLimit-Daily-Remaining"));
  const intervalMilliseconds = parseNumber(
    readResponseHeader(headers, "X-RateLimit-Interval-Milliseconds"),
  );
  const max = parseNumber(readResponseHeader(headers, "X-RateLimit-Max"));
  const remaining = parseNumber(readResponseHeader(headers, "X-RateLimit-Remaining"));
  if (
    limitDaily === undefined &&
    dailyRemaining === undefined &&
    intervalMilliseconds === undefined &&
    max === undefined &&
    remaining === undefined
  ) {
    return undefined;
  }
  return { limitDaily, dailyRemaining, intervalMilliseconds, max, remaining };
}

/**
 * Decide whether one failure should be retried. Pure: same error → same
 * decision. Unknown error shapes are retried only when they look like
 * transport faults (Node `ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN` codes and the
 * DOMException `TimeoutError` an `AbortSignal.timeout()` produces); everything
 * else stops — including `AbortError`, which is the caller's cancellation.
 */
export function classifyFailure(err: unknown): RetryDecision {
  if (err instanceof GhlNonRetryableError) return "stop";
  if (err instanceof GhlRetryableHttpError) {
    // A spent DAILY quota will not refill inside any bounded retry window
    // (`X-RateLimit-Daily-Remaining: 0`), so retrying only burns the budget.
    if (err.rateLimit?.dailyRemaining === 0) return "stop";
    return "retry";
  }
  if (err instanceof Error) {
    const named = err as Error & { code?: unknown };
    if (named.code === "ECONNRESET" || named.code === "ETIMEDOUT" || named.code === "EAI_AGAIN" || named.code === "ECONNREFUSED") {
      return "retry";
    }
    // Caller cancellation is final: honour the stop signal, never retry it.
    if (err.name === "AbortError") return "stop";
    // Timeout aborts are not cancellations — the call timed out on its own.
    if (err.name === "TimeoutError") return "retry";
    if (err.name === "TypeError") return "retry"; // fetch(): network-layer failure
  }
  return "stop";
}

/**
 * True when a failure is a deterministic provider refusal — the request was
 * rejected and provably created nothing. Everything else (transport faults,
 * 5xx, unclassified errors) leaves the provider-side outcome UNKNOWN, so a
 * reservation protecting against a duplicate must be KEPT, not released.
 */
export function isProviderRefusal(err: unknown): boolean {
  return err instanceof GhlNonRetryableError;
}

/**
 * The delay the SERVER asked for, in ms: `Retry-After` when present, otherwise
 * the current burst window when the response says the burst budget is spent
 * (`X-RateLimit-Remaining: 0`). Undefined when the server gave no hint.
 */
export function serverRequestedDelayMs(err: unknown): number | undefined {
  if (!(err instanceof GhlRetryableHttpError)) {
    const last = (err as { lastError?: unknown } | null)?.lastError;
    if (last !== undefined && last !== err) return serverRequestedDelayMs(last);
    return undefined;
  }
  if (err.retryAfterMs !== undefined) return err.retryAfterMs;
  const rateLimit = err.rateLimit;
  if (rateLimit?.remaining === 0 && rateLimit.intervalMilliseconds !== undefined) {
    return rateLimit.intervalMilliseconds;
  }
  return undefined;
}

/**
 * Build the retryable HTTP error a transport adapter should throw for 429/5xx.
 * Pass the response headers so a 429 carries the server's pacing hints
 * (`Retry-After` plus `X-RateLimit-*`) instead of being retried blindly.
 */
export function retryableHttpStatus(
  status: number,
  body: string,
  headers?: GhlResponseHeaders,
  nowMs: number = Date.now(),
): GhlRetryableHttpError | null {
  if (!Number.isInteger(status) || status < 400) return null;
  if (!RETRYABLE_STATUS.has(status)) return null;
  const retryAfterMs = parseRetryAfter(readResponseHeader(headers, "Retry-After"), nowMs);
  const rateLimit = parseRateLimitHeaders(headers);
  return new GhlRetryableHttpError(status, body, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
  });
}

