/// <reference types="node" />

/**
 * Retry/error classification for Agnes AI calls (MMCS task AGN-010).
 *
 * Not every failure deserves a retry. Agnes video/image generation is PAID
 * spend (spec §4 gates, §29 no unbounded retry). Classification is
 * deliberate, mirroring GHL-011's policy for the same failure classes:
 *
 * - Transport faults (network reset, timeout, DNS) → retryable; the request
 *   plausibly never reached Agnes, but callers still wrap the submission in
 *   an idempotency-key guard (see `submit-idempotency.ts`) so a retry after
 *   a lost success response reuses the recorded job instead of re-submitting
 *   a second paid generation.
 * - HTTP 429 / 5xx (except 501) → retryable, transient server trouble.
 * - 408 request timeout → retryable.
 * - 4xx validation/auth/permission/not-found (400/401/403/404/409/422…) →
 *   NOT retryable: a deterministic failure repeats identically (e.g. Flash's
 *   fixed `size: "720P"`, mode exclusivity, images-length caps — all
 *   documented HTTP 400s in docs/provider-capabilities/agnes.md).
 * - 501 Not Implemented → NOT retryable: server-side capability gap.
 * - Caller-classified aborts (non-retryable) → surface immediately.
 */

/** Minimal HTTP-shaped fault the retry policy can retry. */
export class AgnesRetryableHttpError extends Error {
  readonly status: number;
  /** Response body excerpt. May echo request data; callers never log secrets. */
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Agnes API transient failure with status ${status}`);
    this.name = "AgnesRetryableHttpError";
    this.status = status;
    this.body = body;
  }
}

/** Error type that must never be retried (auth failure, validation, abort). */
export class AgnesNonRetryableError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AgnesNonRetryableError";
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
  if (err instanceof AgnesNonRetryableError) return "stop";
  if (err instanceof AgnesRetryableHttpError) return "retry";
  if (err instanceof Error) {
    const named = err as Error & { code?: unknown };
    if (
      named.code === "ECONNRESET" ||
      named.code === "ETIMEDOUT" ||
      named.code === "EAI_AGAIN" ||
      named.code === "ECONNREFUSED"
    ) {
      return "retry";
    }
    if (err.name === "AbortError") return "retry";
    if (err.name === "TypeError") return "retry"; // fetch(): network-layer failure
  }
  return "stop";
}

/** Build the retryable HTTP error a transport adapter should throw for 429/5xx. */
export function retryableHttpStatus(status: number, body: string): AgnesRetryableHttpError | null {
  if (!Number.isInteger(status) || status < 400) return null;
  return RETRYABLE_STATUS.has(status) ? new AgnesRetryableHttpError(status, body) : null;
}