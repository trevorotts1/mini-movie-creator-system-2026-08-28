/**
 * KIE budget-gate port (SKR-007).
 *
 * KIE had NO budget gate at all while Agnes had one, so a KIE submit could spend without
 * ever consulting the cumulative ceiling — the architectural half of the money risk SKR-007
 * names. This mirrors `AgnesVideoBudgetGate` deliberately: one shape for both providers
 * means the submit path cannot drift into having a guard on one and not the other.
 *
 * The port is defined here and consumed by `KieClient.createTask`. The production
 * implementation is CORE-009's atomic ledger; tests supply a scripted gate.
 */

/** Payload passed to the gate before a paid submit (spec §4 cumulative atomic reservation). */
export interface KieBudgetReservationRequest {
  /** Stable reference for the job this reservation covers. */
  ref: string;
  provider: "kie";
  /** Provider model id, e.g. "bytedance/seedance-2-mini". */
  model: string;
  /** Estimated paid spend this job may incur, USD. */
  estimatedCostUsd: number;
  currency: "USD";
}

/** A held budget reservation. Release on failure; hold through success. */
export interface KieBudgetReservation {
  readonly id: string;
  /** Release the held amount. "failed" when submission did not land. */
  release(reason: "submitted" | "failed"): Promise<void>;
}

/**
 * Budget gate port (spec §4/§5: reservation precedes submission). The submitter never
 * computes spend authority itself — it asks, and obeys the answer.
 */
export interface KieBudgetGate {
  reserve(request: KieBudgetReservationRequest): Promise<KieBudgetReservation>;
  /**
   * Release a reservation by its persisted id (crash recovery, spec §4). Must be
   * idempotent: releasing an already-released id resolves, never throws.
   */
  releaseById(reservationId: string, reason: "submitted" | "failed"): Promise<void>;
}

/**
 * Raised when the gate refuses a reservation — the ceiling is reached, or the request is
 * otherwise not authorised. Thrown BEFORE any HTTP request is issued, so a refusal can never
 * cost money.
 */
export class KieBudgetRefusedError extends Error {
  readonly ref: string;
  readonly estimatedCostUsd: number;

  constructor(ref: string, estimatedCostUsd: number, reason: string) {
    super(`KIE submit refused by the budget gate: ${reason} (ref=${ref}, estimated=$${estimatedCostUsd.toFixed(2)})`);
    this.name = "KieBudgetRefusedError";
    this.ref = ref;
    this.estimatedCostUsd = estimatedCostUsd;
  }
}
