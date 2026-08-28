/// <reference types="node" />
import { computeBackoffDelayMs, resolveBackoff, type BackoffOptions } from "./backoff.js";
import { classifyFailure, type RetryDecision } from "./errors.js";

/**
 * Bounded retry executor (MMCS task AGN-010).
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
}

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

/**
 * Run `fn` with bounded exponential backoff.
 *
 * - Success → its value immediately (no sleep ever paid).
 * - Retryable failure with budget left → wait, run again.
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
      const value = await fn({
        attempt,
        attemptNumber: attempt + 1,
        maxAttempts: resolved.maxAttempts,
      });
      return { value, attempts: attempt + 1, firstTry: attempt === 0 };
    } catch (err) {
      lastError = err;
      const decision: RetryDecision = classifyFailure(err);
      const vetoed =
        options.shouldRetry?.(err, {
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
      await sleep(computeBackoffDelayMs(attempt, options));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new RetryBudgetExhaustedError(resolved.maxAttempts, lastError);
}