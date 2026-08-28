/**
 * GHL retry/idempotency (MMCS task GHL-011) — public surface.
 *
 * - `boundedRetry` / backoff: bounded retry with exponential backoff
 *   (spec §29 "no unbounded automatic retry loops").
 * - `ArchivalLedger` + `withArchivalIdempotency`: retry never creates a
 *   duplicate GHL file — the lost-success race returns the recorded result
 *   (spec §35.3 / §38).
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
  retryableHttpStatus,
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
  RetryBudgetExhaustedError,
  boundedRetry,
  type BoundedRetryOptions,
  type BoundedRetryResult,
  type RetryContext,
} from "./bounded-retry.js";
export {
  ArchivalFailedError,
  withArchivalIdempotency,
  type ArchivalAttemptRequest,
  type ArchivalIdempotencyOptions,
  type ArchivalOutcome,
} from "./idempotent-archival.js";