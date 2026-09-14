/// <reference types="node" />
import { computeBackoffDelayMs, resolveBackoff, type BackoffOptions } from "./backoff.js";
import { classifyFailure, serverRequestedDelayMs, type RetryDecision } from "./errors.js";

/**
 * Bounded retry executor (MMCS task GHL-011).
 *
 * Spec §29: "no unbounded automatic retry loops". `boundedRetry` runs `fn`
 * at most `maxAttempts` times, sleeping an exponential-backoff delay between
 * attempts, and stops immediately on failures classified non-retryable.
 * The sleep source is injectable so tests run in zero wall-clock time.
 */

export interface RetryContext {
  /** 0-based attempt number of the attempt that is about to run. */
  attempt: number;
  /** Attempts used so far, including the one about to run. */
  attemptNumber: number;
  maxAttempts: number;
}

export interface BoundedRetryResult<T> {
  value: T;
  /** Number of attempts actually made (1 on first-try success). */
  attempts: number;
  /** True when the first attempt succeeded. */
  firstTry: boolean;
}

export interface BoundedRetryOptions extends BackoffOptions {
  /** Extra predicate to veto a retry for a classified-retryable failure. */
  shouldRetry?: (err: unknown, context: RetryContext) => boolean;
  /** Sleep between attempts. Defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Hard cap on a SERVER-requested wait (`Retry-After`, or the burst window
   * from `X-RateLimit-Remaining: 0` + `X-RateLimit-Interval-Milliseconds`),
   * in milliseconds. Default 60000.
   *
   * GHL's documented burst limit is 100 requests / 10 s, so honouring the
   * server's own pacing hint matters — but spec §29 forbids unbounded waits,
   * and a broken or hostile header must not wedge archival either. The hint
   * therefore wins over the deterministic backoff while still being capped.
   */
  maxRetryAfterMs?: number;
}

/** Default cap on a server-requested retry wait: one minute. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class RetryBudgetExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(
      `bounded retry exhausted after ${attempts} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = "RetryBudgetExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** Resolve the cap on a server-requested wait, ignoring unusable values. */
function resolveMaxRetryAfterMs(options: BoundedRetryOptions): number {
  const value = options.maxRetryAfterMs;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_RETRY_AFTER_MS;
  }
  return value;
}

/**
 * Delay before retry `attempt` for a failure the caller already classified as
 * retryable: the deterministic exponential backoff, raised to the delay the
 * SERVER asked for when the response carried `Retry-After` or a spent burst
 * budget. The server hint is capped at `maxRetryAfterMs`.
 */
export function computeRetryDelayMs(
  attempt: number,
  err: unknown,
  options: BoundedRetryOptions = {},
): number {
  const backoff = computeBackoffDelayMs(attempt, options);
  const serverDelay = serverRequestedDelayMs(err);
  if (serverDelay === undefined) return backoff;
  return Math.min(Math.max(backoff, serverDelay), resolveMaxRetryAfterMs(options));
}

/**
 * Run `fn` with bounded exponential backoff.
 *
 * - Success → its value immediately (no sleep ever paid).
 * - Retryable failure with budget left → wait, run again. The wait is the
 *   backoff raised to the server's own `Retry-After`/burst-window hint.
 * - Retryable failure with budget gone, or non-retryable failure → throw
 *   `RetryBudgetExhaustedError` (wrapping the last error) / rethrow.
 */
export async function boundedRetry<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  options: BoundedRetryOptions = {},
): Promise<BoundedRetryResult<T>> {
  const resolved = resolveBackoff(options);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < resolved.maxAttempts; attempt++) {
    try {
      const value = await fn({ attempt, attemptNumber: attempt + 1, maxAttempts: resolved.maxAttempts });
      return { value, attempts: attempt + 1, firstTry: attempt === 0 };
    } catch (err) {
      lastError = err;
      const decision: RetryDecision = classifyFailure(err);
      const vetoed = options.shouldRetry?.(err, {
        attempt,
        attemptNumber: attempt + 1,
        maxAttempts: resolved.maxAttempts,
      }) === false;
      const hasNext = attempt + 1 < resolved.maxAttempts;
      if (decision === "stop" || vetoed || !hasNext) {
        if (decision === "retry" && !hasNext) {
          throw new RetryBudgetExhaustedError(attempt + 1, err);
        }
        throw err;
      }
      await sleep(computeRetryDelayMs(attempt, err, options));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new RetryBudgetExhaustedError(resolved.maxAttempts, lastError);
}