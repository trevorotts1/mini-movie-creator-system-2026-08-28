/// <reference types="node" />

/**
 * Bounded exponential backoff (MMCS task AGN-010).
 *
 * Spec §29 hardening: "no unbounded automatic retry loops". Every retry
 * policy built here carries a hard cap on total attempts and a hard cap on
 * any single wait, so a flaky Agnes endpoint can never wedge a video job.
 *
 * Delays are deterministic by default (pure exponential growth capped at
 * `maxDelayMs`). A jitter source can be injected for production spread;
 * tests inject nothing so behavior stays reproducible.
 */

export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds. Default 250. */
  baseDelayMs?: number;
  /** Hard cap on any single wait, in milliseconds. Default 8000. */
  maxDelayMs?: number;
  /**
   * TOTAL attempts including the first, so `maxAttempts: 4` means one initial
   * call plus at most 3 retries. Default 4. Must be >= 1.
   */
  maxAttempts?: number;
  /**
   * Optional jitter: given the deterministic delay, return the actual delay.
   * Injected in production (e.g. multiply by 0.5–1.0); omitted in tests.
   */
  jitter?: (deterministicDelayMs: number) => number;
}

export const DEFAULT_BACKOFF: Required<
  Pick<BackoffOptions, "baseDelayMs" | "maxDelayMs" | "maxAttempts">
> = {
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxAttempts: 4,
};

/** Resolve full options, clamping unsafe values to safe defaults. */
export function resolveBackoff(options: BackoffOptions = {}): Required<BackoffOptions> {
  const baseDelayMs = finitePositive(options.baseDelayMs, DEFAULT_BACKOFF.baseDelayMs);
  const maxDelayMs = finitePositive(options.maxDelayMs, DEFAULT_BACKOFF.maxDelayMs);
  const maxAttempts = Math.max(
    1,
    Math.floor(finitePositive(options.maxAttempts, DEFAULT_BACKOFF.maxAttempts)),
  );
  return {
    baseDelayMs,
    maxDelayMs,
    maxAttempts,
    jitter: options.jitter ?? ((d: number) => d),
  };
}

function finitePositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/**
 * Deterministic delay before retry `attempt` (0-based: the first retry is
 * attempt 0). Grows exponentially from `baseDelayMs`, capped at `maxDelayMs`.
 */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const resolved = resolveBackoff(options);
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const raw = resolved.baseDelayMs * Math.pow(2, safeAttempt);
  const capped = Math.min(Number.isFinite(raw) ? raw : resolved.maxDelayMs, resolved.maxDelayMs);
  if (!resolved.jitter) return capped;
  // The hard cap survives jitter: clamp the jittered value back under
  // maxDelayMs so a misbehaving jitter fn cannot unbound a wait.
  const j = resolved.jitter(capped);
  if (!Number.isFinite(j) || j <= 0) return capped;
  return Math.min(j, resolved.maxDelayMs);
}

/** Total wall-clock wait across a full bounded retry run (informational). */
export function totalBoundedDelayMs(options: BackoffOptions = {}): number {
  const resolved = resolveBackoff(options);
  let total = 0;
  for (let attempt = 0; attempt < resolved.maxAttempts - 1; attempt++) {
    total += computeBackoffDelayMs(attempt, options);
  }
  return total;
}