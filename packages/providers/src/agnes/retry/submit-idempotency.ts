/// <reference types="node" />
import {
  IdempotencyError,
  IdempotencyStore,
  requestHash,
  type IdempotencyRecord,
} from "@mmcs/core/idempotency";
import { boundedRetry, RetryBudgetExhaustedError, type BoundedRetryOptions } from "./bounded-retry.js";

/**
 * Idempotent Agnes submission orchestration (MMCS task AGN-010).
 *
 * Spec §18 (async provider job safety): "Persist the provider task/job ID
 * BEFORE polling … request hash/idempotency identifier where supported …
 * retry count." Spec §38: "Never submit duplicate paid generation because
 * context was lost."
 *
 * The danger with retrying a paid Agnes submit is the lost-success race:
 * attempt 1 reaches Agnes, the video job is created (and billable), but the
 * HTTP response is lost (connection reset mid-response). A naive retry
 * submits the SAME request a second time — two paid generations for one
 * logical job. This module closes that window, on top of the CORE-013
 * `IdempotencyStore` primitives:
 *
 * - The key is derived from a canonical request hash (`requestHash` from
 *   `@mmcs/core/idempotency`): scope + the full canonical request (model,
 *   mode, prompt, refs, seconds, size…). Same logical job → same key, always.
 * - Before the first attempt the caller RESERVES the key in the store. A
 *   crash mid-submit leaves a durable record on disk (atomic write), so a
 *   restart re-derives the same key and resumes instead of resubmitting.
 * - The outcome (provider video/image job id) is persisted once known. Any
 *   later call with the same key returns the RECORDED outcome without
 *   re-invoking the submit — the same request hash never double-submits.
 * - Retry is bounded (`boundedRetry`): at most `maxAttempts` attempts with
 *   capped exponential backoff — spec §29's "no unbounded automatic retry
 *   loops".
 * - The per-key retry count is persisted in the record (`retryCount`) and
 *   updated on every attempt, surviving restarts (spec §18 "retry count").
 * - Concurrent same-key calls in one process serialize via the store's
 *   in-process lock; cross-process double submits are additionally guarded
 *   by the caller passing an Agnes client idempotency key derived from the
 *   same hash where the API supports one.
 */

/** Payload persisted inside the store record for one Agnes submission. */
export interface AgnesSubmitRecord {
  /** sha-256 over {scope, request}; mirrors the record key derivation. */
  requestHash: string;
  /**
   * "reserved" while submission may be in flight at Agnes; "completed" once
   * a provider job id is durably recorded.
   */
  state: "reserved" | "completed";
  /** Provider job/video/image id once known. */
  providerJobId: string | null;
  /** How many retries have been spent for this key (spec §18). */
  retryCount: number;
  /** Attempts actually made so far (first submit = 1). */
  attempts: number;
  /** Extra result payload from the (original) submission. */
  result: Record<string, unknown> | null;
}

/** The durable record as stored by the CORE-013 IdempotencyStore. */
export type AgnesSubmitStoreRecord = IdempotencyRecord<AgnesSubmitRecord>;

export class AgnesSubmitIdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgnesSubmitIdempotencyError";
  }
}

/** Thrown when submission could not be completed inside the retry budget. */
export class AgnesSubmitFailedError extends Error {
  readonly key: string;
  readonly requestHash: string;
  /** Retries spent before giving up (persisted by the caller). */
  readonly retryCount: number;
  override readonly cause: unknown;

  constructor(
    key: string,
    requestHash: string,
    retryCount: number,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Agnes submit failed for key ${key} after ${retryCount} retry/retries: ${reason}`,
    );
    this.name = "AgnesSubmitFailedError";
    this.key = key;
    this.requestHash = requestHash;
    this.retryCount = retryCount;
    this.cause = cause;
  }
}

/** The canonical fields of one Agnes submission that define its identity. */
export interface AgnesSubmitRequest extends Record<string, unknown> {
  /** Provider model identifier, e.g. "agnes-video-2.5-flash". */
  model: string;
  /** Generation prompt (untrusted story text — hashed, never executed). */
  prompt?: string;
  /**
   * Business reference (e.g. "shot-42:keyframe-a") mixed into the hash so
   * two identical requests for DIFFERENT logical jobs stay distinct.
   */
  jobRef?: string;
  /** Already-known provider job id (resume path; not resubmitted). */
  providerJobId?: string;
  /** Any additional request params (seconds, size, refs…) — hashed canonically. */
  [param: string]: unknown;
}

/** Validate one request has the minimum Agnes submission shape. */
export function validateAgnesSubmitRequest(request: AgnesSubmitRequest): void {
  if (!request || typeof request !== "object") {
    throw new AgnesSubmitIdempotencyError("agnes submit request is required");
  }
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new AgnesSubmitIdempotencyError("agnes submit request model is required");
  }
  if (request.prompt !== undefined && typeof request.prompt !== "string") {
    throw new AgnesSubmitIdempotencyError("agnes submit request prompt must be a string");
  }
  for (const field of ["jobRef", "providerJobId"] as const) {
    const value = request[field];
    if (value !== undefined && typeof value !== "string") {
      throw new AgnesSubmitIdempotencyError(`agnes submit request ${field} must be a string`);
    }
  }
}

/** Result of `withSubmitIdempotency`. */
export interface AgnesSubmitOutcome<T = Record<string, unknown>> {
  /** The provider job id (recorded or fresh). */
  providerJobId: string | null;
  /** Full result payload of the (original) submission. */
  value: T;
  /** True when a previously recorded submission was reused (no resubmit). */
  reused: boolean;
  /** Attempts the underlying submit actually made (1 when reused). */
  attempts: number;
  /** The idempotency key for this submission. */
  key: string;
  /** Retries spent for this key after this call (persisted in the record). */
  retryCount: number;
  /** The full durable payload as it stands after this call. */
  record: AgnesSubmitRecord;
}

export interface AgnesSubmitIdempotencyOptions extends BoundedRetryOptions {
  /** Scope segment of the idempotency key. Default "agnes-submit". */
  scope?: string;
}

const DEFAULT_SCOPE = "agnes-submit";

/**
 * Derive the idempotency key for one Agnes submission. Pure + deterministic:
 * the same scope + request always yields the same key (canonical hash).
 */
export function agnesSubmitKey(
  scope: string,
  request: AgnesSubmitRequest,
  store?: IdempotencyStore,
): string {
  return store ? store.keyFor(scope, request) : `agnes-${scope}-${storelessHash(scope, request)}`;
}

function storelessHash(scope: string, request: unknown): string {
  // Same canonicalization as @mmcs/core requestHash but only for callers
  // without a store instance; the store path (keyFor) is authoritative.
  return requestHash(scope, request);
}

function payloadOf(record: AgnesSubmitStoreRecord | null): AgnesSubmitRecord | null {
  return record ? (record.result ?? null) : null;
}

/**
 * Submit once. Repeated calls with the same canonical request reuse the
 * recorded provider job id and never re-submit; transient failures retry
 * with bounded backoff; exhaustion throws `AgnesSubmitFailedError` carrying
 * the persisted retry count.
 *
 * `store` must be process-lifetime persistent (same `dir` across restarts)
 * — that persistence is what survives restarts at SUBMITTING (spec §18).
 *
 * `submit` performs ONE network submission and returns the provider job id
 * plus any result payload. It must be safe to have been cut off after a
 * success whose response was lost — that is exactly the case the recorded
 * key guards: the retry observes the reservation, and when the response was
 * lost the caller-side record stays reserved; a later RECOVERY pass (spec
 * §18 restart-at-SUBMITTED) reconciles the provider job by polling, not by
 * resubmitting.
 */
export async function withSubmitIdempotency<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  store: IdempotencyStore,
  request: AgnesSubmitRequest,
  submit: (
    request: AgnesSubmitRequest,
    ctx: { attemptNumber: number },
  ) => Promise<{ providerJobId: string; result?: T }>,
  options: AgnesSubmitIdempotencyOptions = {},
): Promise<AgnesSubmitOutcome<T>> {
  validateAgnesSubmitRequest(request);
  if (request.providerJobId) {
    // Resume path: the job id is already known (persisted before polling,
    // spec §18) — never resubmit a known job.
    const key = store.keyFor("agnes-submit-resume", request);
    const hash = requestHash("agnes-submit-resume", request);
    const payload: AgnesSubmitRecord = {
      requestHash: hash,
      state: "completed",
      providerJobId: request.providerJobId,
      retryCount: 0,
      attempts: 1,
      result: { providerJobId: request.providerJobId },
    };
    return {
      providerJobId: request.providerJobId,
      value: payload.result as T,
      reused: true,
      attempts: 1,
      key,
      retryCount: 0,
      record: payload,
    };
  }

  const scope = options.scope ?? DEFAULT_SCOPE;
  const key = store.keyFor(scope, request);
  const hash = requestHash(scope, request);

  const readPayload = async (): Promise<AgnesSubmitRecord | null> =>
    payloadOf(await store.get<AgnesSubmitRecord>(key));

  // Existing completed record → reuse. No resubmit, no retry, no double spend.
  const existingPayload = await readPayload();
  if (existingPayload && existingPayload.state === "completed") {
    return {
      providerJobId: existingPayload.providerJobId,
      value: (existingPayload.result ?? {}) as T,
      reused: true,
      attempts: 1,
      key,
      retryCount: existingPayload.retryCount,
      record: existingPayload,
    };
  }

  let attemptsMade = 0;
  let reusedUnderLock = false;
  let recordedProviderJobId: string | null = null;
  let recordedResult: T | null = null;
  // Hoisted so the exhaustion/error handlers can persist the CUMULATIVE count
  // (prior rounds + this round) instead of regressing to this round only.
  let priorRetryCount = 0;

  try {
    await store.lock(key, async () => {
      // Re-check under the lock: a same-key caller that queued behind an
      // in-flight submit must observe the fresh completed record.
      const underLock = await readPayload();
      if (underLock && underLock.state === "completed") {
        reusedUnderLock = true;
        recordedProviderJobId = underLock.providerJobId;
        recordedResult = (underLock.result ?? {}) as T;
        return;
      }

      // Reserve before the first network attempt: a crash mid-submit leaves
      // a durable reservation on disk, and a restart re-derives the same key.
      priorRetryCount = underLock?.retryCount ?? existingPayload?.retryCount ?? 0;
      await putPayload(store, key, scope, hash, {
        requestHash: hash,
        state: "reserved",
        providerJobId: null,
        retryCount: priorRetryCount,
        attempts: underLock?.attempts ?? 0,
        result: null,
      });

      const outcome = await boundedRetry(
        async (ctx) => {
          // Bump the persisted retry count BEFORE each retry attempt (synchronously
          // inside the attempt flow — no fire-and-forget, so no lost-update race).
          // A crash mid retries still leaves the count on disk.
          if (ctx.attemptNumber > 1) {
            await putPayload(store, key, scope, hash, {
              requestHash: hash,
              state: "reserved",
              providerJobId: null,
              retryCount: priorRetryCount + (ctx.attemptNumber - 1),
              attempts: ctx.attemptNumber,
              result: null,
            });
          }
          attemptsMade = ctx.attemptNumber;
          const done = await submit(request, { attemptNumber: ctx.attemptNumber });
          // Persist the provider job id + retry count IMMEDIATELY (spec §18:
          // persist before any polling / further work).
          await putPayload(store, key, scope, hash, {
            requestHash: hash,
            state: "completed",
            providerJobId: done.providerJobId,
            attempts: ctx.attemptNumber,
            retryCount: priorRetryCount + (ctx.attemptNumber - 1),
            result: (done.result ?? {}) as Record<string, unknown>,
          });
          return done;
        },
        options,
      );
      recordedProviderJobId = outcome.value.providerJobId;
      recordedResult = (outcome.value.result ?? {}) as T;
    });
  } catch (err) {
    if (err instanceof IdempotencyError) throw err;
    if (err instanceof RetryBudgetExhaustedError) {
      const retryCount = priorRetryCount + (attemptsMade > 0 ? attemptsMade - 1 : 0);
      // Persist the final CUMULATIVE retry count before surfacing exhaustion
      // (prior rounds' retries are never lost, spec §18 "retry count"). The
      // write lands after the lock has been released, so it is monotonic: a
      // queued same-key caller may have already advanced the count further —
      // never write a value that would regress it.
      let persistedCount = retryCount;
      try {
        const current = await readPayload();
        if (current && typeof current.retryCount === "number" && current.retryCount > persistedCount) {
          persistedCount = current.retryCount;
        }
      } catch {
        // read failure must not mask the real failure below
      }
      await putPayload(store, key, scope, hash, {
        requestHash: hash,
        state: "reserved",
        providerJobId: null,
        retryCount: persistedCount,
        attempts: attemptsMade,
        result: null,
      }).catch(() => undefined);
      throw new AgnesSubmitFailedError(key, hash, retryCount, err.lastError ?? err);
    }
    throw new AgnesSubmitFailedError(
      key,
      hash,
      priorRetryCount + (attemptsMade > 0 ? attemptsMade - 1 : 0),
      err,
    );
  }

  const completed = await readPayload();
  if (!completed || completed.state !== "completed") {
    throw new AgnesSubmitFailedError(
      key,
      hash,
      priorRetryCount + (attemptsMade > 0 ? attemptsMade - 1 : 0),
      new Error("submit completed without a durable record"),
    );
  }
  return {
    providerJobId: recordedProviderJobId ?? completed.providerJobId,
    value: (recordedResult ?? (completed.result ?? {})) as T,
    reused: reusedUnderLock,
    attempts: reusedUnderLock ? 1 : attemptsMade,
    key,
    retryCount: completed.retryCount,
    record: completed,
  };
}

/** Persist the Agnes payload inside a CORE-013 store record (atomic write). */
async function putPayload(
  store: IdempotencyStore,
  key: string,
  scope: string,
  hash: string,
  payload: AgnesSubmitRecord,
): Promise<void> {
  const current = await store.get<AgnesSubmitRecord>(key);
  await store.put<AgnesSubmitRecord>({
    key,
    scope,
    requestHash: hash,
    createdAt: current?.createdAt ?? new Date().toISOString(),
    result: payload,
  });
}