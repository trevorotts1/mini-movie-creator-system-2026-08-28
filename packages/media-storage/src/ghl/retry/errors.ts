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
 * - HTTP 429 / 5xx (except 501) → retryable, transient server trouble.
 * - 408 request timeout → retryable.
 * - 4xx validation/auth/permission/not-found (400/401/403/404/409/422…) →
 *   NOT retryable: a deterministic failure repeats identically.
 * - 501 Not Implemented → NOT retryable: server-side capability gap.
 * - Caller-classified aborts (non-retryable) → surface immediately.
 */

/** Minimal HTTP-shaped fault the retry policy can retry. */
export class GhlRetryableHttpError extends Error {
  readonly status: number;
  /** Response body excerpt. May echo request data; callers never log secrets. */
  readonly body: string;

  constructor(status: number, body: string) {
    super(`GHL media API transient failure with status ${status}`);
    this.name = "GhlRetryableHttpError";
    this.status = status;
    this.body = body;
  }
}

/** Error type that must never be retried (auth failure, validation, abort). */
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

/**
 * Decide whether one failure should be retried. Pure: same error → same
 * decision. Unknown error shapes are retried only when they look like
 * transport faults (Node `AbortError`/`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`
 * codes); everything else stops.
 */
export function classifyFailure(err: unknown): RetryDecision {
  if (err instanceof GhlNonRetryableError) return "stop";
  if (err instanceof GhlRetryableHttpError) return "retry";
  if (err instanceof Error) {
    const named = err as Error & { code?: unknown };
    if (named.code === "ECONNRESET" || named.code === "ETIMEDOUT" || named.code === "EAI_AGAIN" || named.code === "ECONNREFUSED") {
      return "retry";
    }
    if (err.name === "AbortError") return "retry";
    if (err.name === "TypeError") return "retry"; // fetch(): network-layer failure
  }
  return "stop";
}

/** Build the retryable HTTP error a transport adapter should throw for 429/5xx. */
export function retryableHttpStatus(status: number, body: string): GhlRetryableHttpError | null {
  if (!Number.isInteger(status) || status < 400) return null;
  return RETRYABLE_STATUS.has(status) ? new GhlRetryableHttpError(status, body) : null;
}

