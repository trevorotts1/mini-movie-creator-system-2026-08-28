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
 */

import { requestHash } from "@mmcs/core/idempotency/request-hash.js";

import type { AgnesVideoSubmitInput } from "./request.js";
import { buildAgnesVideoSubmitRequest } from "./request.js";
import { agnesVideoCapability, estimateSpendUsd, validateAgnesVideoSubmit, AgnesVideoValidationError } from "./validate.js";
import type {
  AgnesVideoBudgetGate,
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
      createdAt,
      updatedAt: this.now(),
    };
    await this.store.save(budgetReserved);

    // Budget reservation precedes submission (spec §4/§18).
    let reservation;
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

    const submitting: AgnesVideoJobRecord = {
      ...budgetReserved,
      state: "SUBMITTING",
      updatedAt: this.now(),
    };
    await this.store.save(submitting);

    try {
      const created = await this.client.createVideo(request);
      const submitted: AgnesVideoJobRecord = {
        ...submitting,
        state: "SUBMITTED",
        providerJobId: created.videoId,
        submittedAt: this.now(),
        updatedAt: this.now(),
      };
      // Persist the provider job ID BEFORE any polling (spec §18). This
      // module never polls; AGN-005's poller requires providerJobId, so the
      // invariant holds structurally.
      await this.store.save(submitted);
      this.log.info("agnes video job submitted", {
        taskId: ref,
        providerJobId: created.videoId,
        model,
        mode: request.mode,
        seconds: request.seconds,
        estimatedCostUsd,
      });
      await reservation.release("submitted");
      return submitted;
    } catch (error) {
      await reservation.release("failed");
      const failed: AgnesVideoJobRecord = {
        ...submitting,
        state: "REJECTED",
        retryCount: (submitting.retryCount ?? 0) + 1,
        updatedAt: this.now(),
      };
      await this.store.save(failed);
      this.log.error("agnes video submit failed", {
        taskId: ref,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}