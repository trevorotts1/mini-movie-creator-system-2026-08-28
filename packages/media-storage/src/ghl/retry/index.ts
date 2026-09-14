/**
 * GHL retry/idempotency (MMCS task GHL-011) — public surface.
 *
 * - `boundedRetry` / backoff: bounded retry with exponential backoff
 *   (spec §29 "no unbounded automatic retry loops"), raised to the server's
 *   own `Retry-After` / `X-RateLimit` pacing hint on 429s.
 * - `ArchivalLedger` + `withArchivalIdempotency`: retry never creates a
 *   duplicate GHL file — the lost-success race returns the recorded result
 *   (spec §35.3 / §38), a held reservation is resolved provider-side instead
 *   of being re-uploaded, and a deterministic refusal releases the key
 *   (SKR-013).
 * - `ArchivalFailedError` preserves the provider task/job ID; archival
 *   failure never triggers media regeneration (spec §35.3).
 */
export {
  DEFAULT_BACKOFF,
  computeBackoffDelayMs,
  resolveBackoff,
  totalBoundedDelayMs,
  type BackoffOptions,
} from "./backoff.js";
export {
  GhlNonRetryableError,
  GhlRetryableHttpError,
  classifyFailure,
  isProviderRefusal,
  parseRateLimitHeaders,
  parseRetryAfter,
  readResponseHeader,
  retryableHttpStatus,
  serverRequestedDelayMs,
  type GhlRateLimitSnapshot,
  type GhlResponseHeaders,
  type RetryDecision,
} from "./errors.js";
export {
  ArchivalLedger,
  ArchivalLedgerError,
  archivalKey,
  archivalRequestHash,
  type ArchivalLedgerRecord,
} from "./ledger.js";
export {
  DEFAULT_MAX_RETRY_AFTER_MS,
  RetryBudgetExhaustedError,
  boundedRetry,
  computeRetryDelayMs,
  type BoundedRetryOptions,
  type BoundedRetryResult,
  type RetryContext,
} from "./bounded-retry.js";
export {
  ArchivalFailedError,
  ArchivalReservationHeldError,
  withArchivalIdempotency,
  type ArchivalAttemptRequest,
  type ArchivalIdempotencyOptions,
  type ArchivalOutcome,
} from "./idempotent-archival.js";