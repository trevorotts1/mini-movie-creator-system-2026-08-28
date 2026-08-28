/**
 * AGN-004 — Agnes video job submitter.
 *
 * Runs the spec §5 pre-request validation chain, takes the spec §4 budget
 * reservation, then submits and persists the job record BEFORE any polling
 * can happen (spec §18 binding invariant).
 *
 * Submit-only by construction: this module holds no retrieve/poll method and
 * imports none, so a submission can never evolve into polling. AGN-005 owns
 * polling and resumes from the persisted `providerJobId` — restart at
 * SUBMITTED polls the existing job, never resubmits, never double-spends.
 *
 * Failure semantics: a chain failure aborts before any durable write. A
 * client failure after the BUDGET_RESERVED save releases the reservation,
 * records REJECTED with the error reason, and rethrows the original error.
 * A STORE failure AFTER the provider accepted the job is different: the
 * provider job already exists, so the hold settles as "submitted" and the
 * typed {@link AgnesVideoSubmitPersistError} surfaces the provider job id
 * for reconciliation — the SUBMITTED save itself retries a bounded 3 times
 * first. Resuming with a stale reservation id releases that hold before
 * re-reserving, and a failed release aborts the resume (never double-hold).
 */

import { requestHash } from "@mmcs/core/idempotency/request-hash.js";

import type { AgnesVideoSubmitInput, AgnesVideoSubmitRequest } from "./request.js";
import { buildAgnesVideoSubmitRequest } from "./request.js";
import { agnesVideoCapability, estimateSpendUsd, validateAgnesVideoSubmit, AgnesVideoValidationError } from "./validate.js";
import type {
  AgnesVideoBudgetGate,
  AgnesVideoBudgetReservation,
  AgnesVideoClient,
  AgnesVideoJobRecord,
  AgnesVideoJobStore,
  AgnesVideoModelId,
  AgnesVideoSubmitterOptions,
} from "./types.js";
import type { Logger } from "@mmcs/core/logging/index.js";
import { createLogger } from "@mmcs/core/logging/index.js";

/** Error thrown when the budget gate declines the reservation (spec §4). */
export class AgnesVideoBudgetDeclinedError extends Error {
  constructor(ref: string, readonly estimatedCostUsd: number) {
    super(
      `budget gate declined reservation for "${ref}" (estimated $${estimatedCostUsd.toFixed(4)} would cross the cumulative AUTO_SPEND_LIMIT_USD without prior approval)`,
    );
    this.name = "AgnesVideoBudgetDeclinedError";
  }
}

/**
 * Thrown when the provider ACCEPTED the job (it returned a video_id) but the
 * SUBMITTED record could not be persisted (spec §18 crash window).
 *
 * Carrying the provider job id lets the caller/operator reconcile the job
 * without resubmitting — calling the submit endpoint again would create a
 * second paid provider job. This is NOT a retryable submit failure.
 */
export class AgnesVideoSubmitPersistError extends Error {
  constructor(
    ref: string,
    readonly providerJobId: string,
    readonly submitRequest: AgnesVideoSubmitRequest,
    options?: { cause?: unknown },
  ) {
    super(
      `provider accepted video_id "${providerJobId}" for "${ref}" but the SUBMITTED record could not be persisted — do NOT resubmit; reconcile via the provider job id`,
      options,
    );
    this.name = "AgnesVideoSubmitPersistError";
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}

/** Scope for the request hash (per-provider idempotency namespace). */
const REQUEST_HASH_SCOPE = "agnes.video.submit.v1";

/**
 * Agnes video job submitter: validate → reserve budget → submit → persist.
 *
 * Order inside {@link submit} (spec §5 tail + §18):
 *   1. resolve capability profile (per model)
 *   2. run the pure validation chain (characters → references → modes →
 *      duration/resolution) — abort before ANY durable write on failure
 *   3. build the exact request payload + sha-256 request hash
 *   4. save the record as BUDGET_RESERVED (request persisted first)
 *   5. reserve budget against the shared ledger (BUDGET_RESERVED, §4/§18)
 *   6. submit via the client port
 *   7. save the record as SUBMITTED with the provider job ID — from this
 *      point any restart resumes via AGN-005 without resubmitting
 */
export class AgnesVideoSubmitter {
  private readonly now: () => string;
  private readonly log: Logger;

  constructor(
    private readonly client: AgnesVideoClient,
    private readonly store: AgnesVideoJobStore,
    private readonly budgetGate: AgnesVideoBudgetGate,
    options: AgnesVideoSubmitterOptions = {},
  ) {
    this.now = options.now ?? defaultNow;
    this.log = options.logger ?? createLogger({ context: { agent: "agnes-video-submit" } });
  }

  /**
   * Submit one Agnes video job. Idempotent on request hash: a record already
   * carrying a `providerJobId` (any state from SUBMITTED onward) is returned
   * untouched — the submit endpoint is never called twice for the same
   * persisted job (spec §18: restart at SUBMITTED never resubmits).
   *
   * A record without a providerJobId (PLANNED/BUDGET_RESERVED/SUBMITTING —
   * e.g. a crash between saves) re-enters the pipeline at the reservation
   * stage with the SAME ref and request hash, converging on one provider job.
   */
  async submit(
    ref: string,
    input: AgnesVideoSubmitInput,
  ): Promise<AgnesVideoJobRecord> {
    const existing = await this.store.load(ref);
    if (existing?.providerJobId !== undefined) {
      // Already submitted (SUBMITTED/GENERATING/...): never resubmit.
      return existing;
    }

    // Crash between budgetGate.reserve and the SUBMITTED save leaves a held
    // reservation id on the record. Release it before re-reserving so a
    // resume can never double-hold (spec §4 cumulative atomic reservation).
    // A FAILED release aborts the resume: re-reserving now would hold twice
    // and overwrite the stale hold's only durable trace (spec §4 atomic
    // reservation). The id stays on the record; the next resume retries the
    // release first.
    if (existing?.budgetReservationId !== undefined) {
      try {
        await this.releaseById(existing.budgetReservationId, "failed");
      } catch (error) {
        this.log.error("failed to release stale budget reservation on resume", {
          taskId: ref,
          reservationId: existing.budgetReservationId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const model: AgnesVideoModelId = input.model ?? "agnes-video-2.5-flash";
    const capability = agnesVideoCapability(model);

    // Pre-request validation chain (spec §5) — pure, before any durable write.
    const validation = validateAgnesVideoSubmit(input, capability);
    if (!validation.ok) {
      throw new AgnesVideoValidationError(validation.issues);
    }

    const request = buildAgnesVideoSubmitRequest({ ...input, model });
    const hash = requestHash(REQUEST_HASH_SCOPE, request);
    const estimatedCostUsd = estimateSpendUsd(input, capability);
    const createdAt = existing?.createdAt ?? this.now();

    // Persist the SUBMIT REQUEST before submission (spec §18: request params
    // on the durable record; task/job ID lands on the SUBMITTED save).
    const budgetReserved: AgnesVideoJobRecord = {
      ...(existing ?? {}),
      ref,
      state: "BUDGET_RESERVED",
      requestHash: hash,
      provider: "agnes",
      model,
      submitRequest: request,
      promptCharacterCount: validation.promptCharacterCount,
      estimatedCostUsd,
      archivalStatus: "PENDING",
      retryCount: existing?.retryCount ?? 0,
      budgetReservationId: undefined,
      createdAt,
      updatedAt: this.now(),
    };
    await this.store.save(budgetReserved);

    // Budget reservation precedes submission (spec §4/§18).
    let reservation: AgnesVideoBudgetReservation;
    try {
      reservation = await this.budgetGate.reserve({
        ref,
        provider: "agnes",
        model,
        estimatedCostUsd,
        currency: "USD",
      });
    } catch (error) {
      const rejected: AgnesVideoJobRecord = {
        ...budgetReserved,
        state: "REJECTED",
        updatedAt: this.now(),
      };
      await this.store.save(rejected);
      throw error;
    }

    // Persist the held reservation id IMMEDIATELY (spec §4): a crash between
    // reserve and SUBMITTED now leaves a releasable trace on the record, so
    // a resume releases this exact hold instead of stranding it and taking
    // a second one.
    const reserved: AgnesVideoJobRecord = {
      ...budgetReserved,
      state: "BUDGET_RESERVED",
      budgetReservationId: reservation.id,
      updatedAt: this.now(),
    };
    try {
      await this.store.save(reserved);
    } catch (error) {
      // The id never became durable: release the hold directly so it cannot
      // strand (the record carries no trace a resume could use).
      await reservation.release("failed");
      throw error;
    }

    const submitting: AgnesVideoJobRecord = {
      ...reserved,
      state: "SUBMITTING",
      updatedAt: this.now(),
    };
    try {
      await this.store.save(submitting);
    } catch (error) {
      // Cannot persist SUBMITTING: abort without touching the provider. The
      // reservation id IS durable (previous save); release it now — the gate
      // contract makes releaseById idempotent, so the caller's retry stays
      // safe if this release also races a resume.
      try {
        await this.releaseById(reservation.id, "failed");
      } catch (releaseError) {
        this.log.error("failed to release budget reservation on store failure", {
          taskId: ref,
          reservationId: reservation.id,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
      throw error;
    }

    try {
      const created = await this.client.createVideo(request);
      const submitted: AgnesVideoJobRecord = {
        ...submitting,
        state: "SUBMITTED",
        providerJobId: created.videoId,
        submittedAt: this.now(),
        budgetReservationId: undefined,
        updatedAt: this.now(),
      };
      // Persist the provider job ID BEFORE any polling (spec §18). This
      // module never polls; AGN-005's poller requires providerJobId, so the
      // invariant holds structurally.
      try {
        await this.saveSubmittedWithRetry(submitted);
      } catch (error) {
        // The provider ACCEPTED the job — it returned a video_id — so this is
        // NOT a submit failure: recording REJECTED or releasing the hold as
        // "failed" would invite a resubmit and a second paid provider job
        // (spec §18: never double-spend). Settle the hold as submitted
        // (best-effort) and surface the durable provider job id via a typed
        // error so the caller can reconcile without resubmitting.
        try {
          await reservation.release("submitted");
        } catch (releaseError) {
          this.log.error("failed to release budget reservation after submit", {
            taskId: ref,
            reservationId: reservation.id,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        }
        this.log.error("failed to persist SUBMITTED record after provider accepted", {
          taskId: ref,
          providerJobId: created.videoId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new AgnesVideoSubmitPersistError(ref, created.videoId, request, {
          cause: error,
        });
      }
      this.log.info("agnes video job submitted", {
        taskId: ref,
        providerJobId: created.videoId,
        model,
        mode: request.mode,
        seconds: request.seconds,
        estimatedCostUsd,
      });
      try {
        await reservation.release("submitted");
      } catch (error) {
        // Job is already submitted and persisted; a failed release must not
        // masquerade as a failed submit. The held amount stays visible to
        // CORE-009's ledger reconciliation.
        this.log.error("failed to release budget reservation after submit", {
          taskId: ref,
          reservationId: reservation.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return submitted;
    } catch (error) {
      if (error instanceof AgnesVideoSubmitPersistError) {
        // Already handled (hold settled best-effort, typed error carries the
        // provider job id). Never convert it to REJECTED or release "failed".
        throw error;
      }
      // Persist REJECTED FIRST, then release: a store failure must not mask
      // the provider error, and the durable record carries the retry count.
      const failed: AgnesVideoJobRecord = {
        ...submitting,
        state: "REJECTED",
        retryCount: (submitting.retryCount ?? 0) + 1,
        budgetReservationId: undefined,
        updatedAt: this.now(),
      };
      try {
        await this.store.save(failed);
      } catch (storeError) {
        this.log.error("failed to persist REJECTED record", {
          taskId: ref,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
      }
      try {
        await reservation.release("failed");
      } catch (releaseError) {
        this.log.error("failed to release budget reservation on submit failure", {
          taskId: ref,
          reservationId: reservation.id,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
      this.log.error("agnes video submit failed", {
        taskId: ref,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Release a persisted reservation id; idempotent (spec §4). */
  private async releaseById(
    reservationId: string,
    reason: "submitted" | "failed",
  ): Promise<void> {
    await this.budgetGate.releaseById(reservationId, reason);
  }

  /**
   * Persist the SUBMITTED record with a small bounded retry. Transient store
   * failures (e.g. SQLite SQLITE_BUSY) are the one crash-window defect a
   * retry actually repairs; a provider-accepted job must not lose its
   * durable record to one bad save. Bounded (3 attempts, no backoff sleep —
   * synchronous store), never unbounded (spec: no unbounded retry loops).
   */
  private async saveSubmittedWithRetry(
    submitted: AgnesVideoJobRecord,
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.store.save(submitted);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}