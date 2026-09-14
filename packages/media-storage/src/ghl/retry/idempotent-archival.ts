/// <reference types="node" />
import {
  ArchivalLedger,
  ArchivalLedgerError,
  archivalKey,
  archivalRequestHash,
  type ArchivalLedgerRecord,
} from "./ledger.js";
import { boundedRetry, RetryBudgetExhaustedError, type BoundedRetryOptions } from "./bounded-retry.js";
import { isProviderRefusal } from "./errors.js";

/**
 * Idempotent GHL archival orchestration (MMCS task GHL-011).
 *
 * Spec §35.3 (immediate archival): provider generation completes → archive →
 * verify → mark ARCHIVED → only then treat the provider result as safely
 * persisted. "Never regenerate expensive media merely because archival
 * failed. Always persist the original provider task/job ID."
 *
 * `withArchivalIdempotency` wraps ONE archival operation (hosted URL ingest
 * from GHL-005 or binary upload from GHL-006) so that:
 *
 * 1. Retry is bounded with backoff — a flaky network retries at most
 *    `maxAttempts` times, then surfaces the failure.
 * 2. The operation is never re-run after a recorded success — the lost-
 *    success race (attempt succeeded at GHL, response lost) cannot create a
 *    duplicate GHL file: the same key returns the recorded fileId/url.
 * 3. Archival failure NEVER throws a signal that could be interpreted as
 *    "regenerate the media". `ArchivalFailedError` carries the preserved
 *    provider task/job ID and the reason; callers persist both and keep the
 *    generated asset in its ARCHIVING/GENERATED_TEMPORARY state (spec §38)
 *    so archival can resume later. Generation is not this module's concern
 *    and it never requests one.
 * 4. The RESERVE result is acted on (SKR-013). A pre-existing, unresolved
 *    reservation means an earlier attempt's outcome is unknown (it may have
 *    landed at GHL), so the attempt is not re-run blindly: the caller's
 *    provider-side detector must find the file (reuse) or prove it absent
 *    (proceed), and without a detector the call is refused with
 *    `ArchivalReservationHeldError`. A deterministic refusal releases the key
 *    so it can never be reserved forever; an unknown-outcome failure keeps it
 *    and stamps attempts/reason on it.
 *
 * The key is derived from the canonical request: location, destination
 * folder, canonical filename, and content checksum where known. Deterministic
 * filename (spec §35.3) + checksum means the same logical asset always maps
 * to the same key.
 */

export interface ArchivalAttemptRequest {
  /** GHL sub-account/location ID (altId). */
  altId: string;
  /** Destination folder ID inside GHL. */
  parentId: string;
  /** Deterministic canonical filename (spec §35.3). */
  name: string;
  /**
   * Content checksum (sha-256 hex) when known — binds the key to the exact
   * bytes so re-hashing the same source reuses the same key. Omit for hosted
   * ingest before checksum is available; the provider URL is then mixed in.
   */
  checksum?: string;
  /** Provider temporary URL for hosted ingestion (GHL-005 path). */
  fileUrl?: string;
  /** Original provider task/job ID — preserved on failure, never regenerated. */
  providerTaskId?: string;
}

/** The one network attempt an archival caller performs. */
export type ArchivalAttempt<T> = (request: ArchivalAttemptRequest) => Promise<T>;

/** Result of `withArchivalIdempotency`. */
export interface ArchivalOutcome<T> {
  value: T;
  /** True when a previously recorded archival result was reused (no upload). */
  reused: boolean;
  /** Attempts the underlying operation actually made (1 when reused). */
  attempts: number;
  /** The ledger key for this archival request. */
  key: string;
  /**
   * True when the value came from resolving a PRE-EXISTING reservation (an
   * earlier attempt whose outcome was unknown). No upload ran this call.
   */
  resumedFromHeldReservation: boolean;
}

/**
 * Thrown when the key is already reserved by an earlier attempt whose outcome
 * is unknown (crash or connection loss mid-upload) and no provider-side
 * detector is wired to prove whether the file landed (SKR-013).
 *
 * Failing here is the point: re-running the upload on that signal is exactly
 * how one archive run becomes two GHL files. Recovery paths: wire
 * `detectExisting` (a GHL-002 name lookup / manifest checksum lookup), or
 * release the key deliberately once the file is confirmed absent at GHL.
 */
export class ArchivalReservationHeldError extends ArchivalLedgerError {
  readonly key: string;
  readonly heldSince?: string;
  readonly attempts?: number;
  readonly lastFailure?: string;

  constructor(
    key: string,
    context: { heldSince?: string; attempts?: number; lastFailure?: string } = {},
  ) {
    super(
      `archival key ${key} is held by an earlier unresolved attempt` +
        (context.heldSince !== undefined ? ` (reserved ${context.heldSince})` : "") +
        (context.attempts !== undefined ? ` after ${context.attempts} attempt(s)` : "") +
        (context.lastFailure !== undefined ? `: ${context.lastFailure}` : "") +
        "; refusing to upload again without provider-side detection — wire detectExisting, or release the key once the file is confirmed absent at GHL",
    );
    this.name = "ArchivalReservationHeldError";
    this.key = key;
    this.heldSince = context.heldSince;
    this.attempts = context.attempts;
    this.lastFailure = context.lastFailure;
  }
}

/** Thrown when archival could not be completed inside the retry budget. */
export class ArchivalFailedError extends Error {
  readonly key: string;
  /** Original provider task/job ID — persist it; NEVER regenerate on this. */
  readonly providerTaskId?: string;
  override readonly cause: unknown;

  constructor(key: string, providerTaskId: string | undefined, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `GHL archival failed for key ${key}` +
        (providerTaskId ? ` (provider task ${providerTaskId} preserved)` : "") +
        `: ${reason}`,
    );
    this.name = "ArchivalFailedError";
    this.key = key;
    this.providerTaskId = providerTaskId;
    this.cause = cause;
  }
}

export interface ArchivalIdempotencyOptions<T = unknown> extends BoundedRetryOptions {
  /** Scope segment of the ledger key. Default "ghl-archival". */
  scope?: string;
  /**
   * Provider-side dedupe lookup, used when the key is already reserved by an
   * earlier attempt whose outcome is unknown (SKR-013).
   *
   * Return the existing durable result when the file IS at GHL (it is then
   * recorded and reused — no second upload); return null when the lookup
   * proves the file ABSENT (the attempt may proceed). Omit the hook entirely
   * and a held reservation is refused with
   * {@link ArchivalReservationHeldError} instead of silently re-uploading.
   */
  detectExisting?: () => Promise<T | null>;
}

const DEFAULT_SCOPE = "ghl-archival";

function validateRequest(request: ArchivalAttemptRequest): void {
  if (!request || typeof request !== "object") {
    throw new ArchivalLedgerError("archival request is required");
  }
  if (!request.altId || typeof request.altId !== "string") {
    throw new ArchivalLedgerError("archival request altId is required");
  }
  if (!request.parentId || typeof request.parentId !== "string") {
    throw new ArchivalLedgerError("archival request parentId is required");
  }
  if (!request.name || typeof request.name !== "string") {
    throw new ArchivalLedgerError("archival request canonical name is required");
  }
  if (request.fileUrl !== undefined && typeof request.fileUrl !== "string") {
    throw new ArchivalLedgerError("archival request fileUrl must be a string");
  }
  if (request.checksum !== undefined && typeof request.checksum !== "string") {
    throw new ArchivalLedgerError("archival request checksum must be a string");
  }
  if (request.providerTaskId !== undefined && typeof request.providerTaskId !== "string") {
    throw new ArchivalLedgerError("archival request providerTaskId must be a string");
  }
}

/**
 * Archive once. Repeated calls with the same canonical request reuse the
 * recorded result and never re-upload; transient failures retry with
 * bounded backoff; exhaustion throws `ArchivalFailedError` carrying the
 * preserved provider task/job ID.
 *
 * `ledger` must be process-lifetime persistent (same `dir` across restarts)
 * — that persistence is what survives restarts at GENERATED_TEMPORARY.
 */
export async function withArchivalIdempotency<T>(
  ledger: ArchivalLedger,
  request: ArchivalAttemptRequest,
  attempt: (request: ArchivalAttemptRequest) => Promise<T>,
  options: ArchivalIdempotencyOptions<T> = {},
): Promise<ArchivalOutcome<T>> {
  validateRequest(request);
  const scope = options.scope ?? DEFAULT_SCOPE;
  const key = archivalKey(scope, request);
  const requestHash = archivalRequestHash(scope, request);

  // Existing completed record → reuse. No upload, no retry, no duplicate.
  const existing = await ledger.get<T>(key);
  if (existing && existing.state === "completed") {
    if (existing.serializationError) {
      // The original ran but its outcome is unrepresentable; a silent reuse
      // would hand back null as if real. Surface instead.
      throw new ArchivalLedgerError(
        `recorded archival result for key ${key} is not serializable: ${existing.serializationError}`,
      );
    }
    return {
      value: existing.result as T,
      reused: true,
      attempts: 1,
      key,
      resumedFromHeldReservation: false,
    };
  }

  let attemptsMade = 0;
  let reusedUnderLock = false;
  let reusedFromReservation = false;
  let recorded: T | null = null;
  try {
    // Reserve before the first network attempt: a crash mid-upload leaves a
    // reservation on disk, and a restart re-derives the same key.
    await ledger.runLocked(key, async () => {
      // Re-check under the lock: a same-key caller that queued behind an
      // in-flight archival must observe the fresh completed record instead of
      // uploading again.
      const underLock = await ledger.get<T>(key);
      if (underLock && underLock.state === "completed" && !underLock.serializationError) {
        reusedUnderLock = true;
        recorded = underLock.result as T;
        return;
      }

      // The reserve RESULT is load-bearing (SKR-013): `created: false` means an
      // earlier attempt for this exact canonical request already ran and its
      // outcome is UNKNOWN — the upload may have landed at GHL even though the
      // call failed. Blindly re-running the attempt on that signal is how one
      // archival run becomes two GHL files, so the caller's provider-side
      // detector must resolve it first.
      const reservation = await ledger.reserve<T>(key, scope, requestHash);
      if (!reservation.created) {
        const detected = options.detectExisting;
        if (detected === undefined) {
          throw new ArchivalReservationHeldError(key, {
            heldSince: reservation.record.createdAt,
            ...(reservation.record.attempts !== undefined
              ? { attempts: reservation.record.attempts }
              : {}),
            ...(reservation.record.lastFailure !== undefined
              ? { lastFailure: reservation.record.lastFailure }
              : {}),
          });
        }
        const found = await detected();
        if (found !== null && found !== undefined) {
          await ledger.complete(key, found);
          reusedFromReservation = true;
          recorded = found;
          return;
        }
        // Detection proved the file absent — the attempt below may run.
      }

      const outcome = await boundedRetry(
        (ctx) => {
          attemptsMade = ctx.attemptNumber;
          return attempt(request);
        },
        options,
      );
      recorded = outcome.value;
      await ledger.complete(key, outcome.value);
    });
  } catch (err) {
    if (err instanceof ArchivalLedgerError) throw err;
    const cause = err instanceof RetryBudgetExhaustedError ? err.lastError : err;
    await recordFailure(ledger, key, cause, attemptsMade);
    throw new ArchivalFailedError(key, request.providerTaskId, err);
  }

  const completed = await ledger.get<T>(key);
  if (!completed || completed.state !== "completed") {
    throw new ArchivalFailedError(key, request.providerTaskId, new Error("archival completed without a durable record"));
  }
  if (completed.serializationError) {
    throw new ArchivalLedgerError(
      `recorded archival result for key ${key} is not serializable: ${completed.serializationError}`,
    );
  }
  return {
    value: recorded ?? (completed.result as T),
    reused: reusedUnderLock || reusedFromReservation,
    attempts: reusedUnderLock || reusedFromReservation ? 1 : attemptsMade,
    key,
    resumedFromHeldReservation: reusedFromReservation,
  };
}

/**
 * Book-keep a failed attempt so the key is never a silent dead end (SKR-013).
 *
 * - A deterministic provider REFUSAL (auth/validation) created nothing, so the
 *   reservation is released and the key is reusable — this is the missing
 *   `release()` caller.
 * - Anything else (transport fault, 5xx, unclassified error) leaves the
 *   provider-side outcome unknown: the reservation is KEPT and stamped with the
 *   attempt count and reason, which is what the held-reservation guard reads on
 *   the next call.
 */
async function recordFailure(
  ledger: ArchivalLedger,
  key: string,
  cause: unknown,
  attempts: number,
): Promise<void> {
  try {
    if (isProviderRefusal(cause)) {
      await ledger.release(key);
      return;
    }
    await ledger.fail(key, cause instanceof Error ? cause.message : String(cause), attempts);
  } catch {
    // Ledger bookkeeping must never mask the archival failure itself.
  }
}

export { RetryBudgetExhaustedError, ArchivalLedgerError };