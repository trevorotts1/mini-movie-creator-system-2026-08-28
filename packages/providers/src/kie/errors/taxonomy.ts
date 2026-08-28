/**
 * KIE-009 — unified Kie failure taxonomy.
 *
 * Every Kie failure — HTTP status, transport throw, task-info failure payload,
 * or an unknown thrown value — normalizes to exactly one
 * {@link NormalizedKieFailure} with a classification of `retryable`, `fatal`,
 * or `quota`. Downstream systems (retry policy, cost/quota engine, QC retry
 * policy) branch on `classification`/`retryable`, never on raw error text.
 *
 * Security invariant (runbook §32): nothing that leaves this module — message,
 * detail, or log line — may contain an API key, Authorization header, or
 * credential-shaped token. All strings pass through the redaction layer in
 * `redact.ts` before they are attached to a failure.
 */

/** The three failure classes every Kie failure folds into. */
export type KieFailureClass = "retryable" | "fatal" | "quota";

/** Where a normalized failure was extracted from. */
export type KieFailureSource = "http" | "transport" | "task" | "error" | "unknown";

/**
 * One normalized Kie failure. Every field is safe to log: `message` and
 * `detail` are redacted of credential-shaped content by construction.
 */
export interface NormalizedKieFailure {
  /** Taxonomy class. `quota` failures are budget/pacing, not bugs. */
  classification: KieFailureClass;
  /**
   * True only when retrying the SAME request unchanged can plausibly succeed.
   * Fatal and hard-quota failures are never retryable — this flag exists so
   * callers cannot build unbounded retry loops by accident (runbook §32).
   */
  retryable: boolean;
  /** Stable machine-readable code, e.g. "kie:rate_limited". */
  code: string;
  /** Human-readable, secret-free message. Safe to log and to surface to a user. */
  message: string;
  /** HTTP status when the failure is HTTP-shaped; otherwise undefined. */
  status?: number;
  /** Server-supplied Retry-After (seconds) when present (pacing hint). */
  retryAfterSec?: number;
  /** Which raw shape produced this failure. */
  source: KieFailureSource;
  /** 1-based attempt number, when the caller supplies one. */
  attempt?: number;
  /** Redacted diagnostic context (never the raw unredacted payload). */
  detail?: Record<string, unknown>;
}

/** Error wrapper carrying a {@link NormalizedKieFailure}. */
export class KieNormalizedError extends Error {
  readonly failure: NormalizedKieFailure;

  constructor(failure: NormalizedKieFailure) {
    super(failure.message);
    this.name = "KieNormalizedError";
    this.failure = failure;
  }
}