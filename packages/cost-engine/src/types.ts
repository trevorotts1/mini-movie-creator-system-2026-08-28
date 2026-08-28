/**
 * Cost/quota reservations domain types (spec §4, §32 "Spend").
 *
 * All monetary amounts cross the public API as USD numbers; the ledger
 * stores integer cents so the $25.00 boundary is exact (no float drift
 * around 24.99 + 0.01). See `money.ts` for the conversion.
 */

/** Default cumulative paid-spend gate in USD (spec §4 `AUTO_SPEND_LIMIT_USD = 25.00`). */
export const DEFAULT_AUTO_SPEND_LIMIT_USD = 25;

/**
 * How a reservation spends:
 * - `paid` counts against the cumulative $25 gate.
 * - `included` is subscription/free allowance — tracked for reporting but
 *   NEVER counted as paid spend (spec §4).
 */
export const RESERVATION_KINDS = ["paid", "included"] as const;
export type ReservationKind = (typeof RESERVATION_KINDS)[number];

export const RESERVATION_STATUSES = ["reserved", "committed", "released"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Per-request usage metrics tracked per provider/model (spec §4 field list). */
export interface UsageMetrics {
  requestedSeconds?: number;
  generatedSeconds?: number;
  acceptedSeconds?: number;
  rejectedSeconds?: number;
  retries?: number;
}

/** Input for `CostLedger.reserve` — the derived cost is stated BEFORE spending. */
export interface ReservationInput extends UsageMetrics {
  provider: string;
  providerModel: string;
  /** Projected cost of the request in USD; compared against the cumulative gate. */
  estimatedUsd: number;
  /** Defaults to `paid`. */
  kind?: ReservationKind;
  /** Soft reference to the provider job (spec §18 `BUDGET_RESERVED` owner). */
  jobId?: string;
  /** Optional episode scope for per-episode rollups. */
  episodeId?: string;
  /**
   * Skip the gate — used only AFTER explicit operator approval of a request
   * that would reach/exceed the limit. The approval note is persisted.
   */
  force?: boolean;
  approvalNote?: string;
}

/** A durable budget reservation row (the `BUDGET_RESERVED` side of spec §18). */
export interface Reservation {
  readonly id: string;
  readonly jobId?: string;
  readonly episodeId?: string;
  readonly provider: string;
  readonly providerModel: string;
  readonly kind: ReservationKind;
  readonly status: ReservationStatus;
  readonly estimatedUsd: number;
  readonly actualUsd?: number;
  readonly requestedSeconds?: number;
  readonly generatedSeconds?: number;
  readonly acceptedSeconds?: number;
  readonly rejectedSeconds?: number;
  readonly retries?: number;
  /** Set when a reservation crossed the gate via explicit approval. */
  readonly approvedAt?: string;
  readonly approvalNote?: string;
  readonly releaseReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Result of a reservation attempt: proceed, or stop for approval (spec §4). */
export type ReservationDecision =
  | {
      outcome: "approved";
      reservation: Reservation;
      /** Cumulative projected paid spend AFTER this reservation (USD). */
      projectedUsd: number;
      limitUsd: number;
    }
  | {
      outcome: "requires_approval";
      /** Human-readable reason, e.g. which boundary was crossed. */
      reason: string;
      /** Cumulative projected paid spend the request would reach (USD). */
      projectedUsd: number;
      requestUsd: number;
      limitUsd: number;
      /** Never set on a stop — nothing was reserved. */
      reservation: undefined;
    };

export function isApproved(decision: ReservationDecision): decision is Extract<ReservationDecision, { outcome: "approved" }> {
  return decision.outcome === "approved";
}

/** Cumulative paid-spend rollup (spec §4: episode + daily + provider views). */
export interface SpendSummary {
  limitUsd: number;
  /** Open reservations + committed actuals (committed falls back to estimate). */
  projectedTotalUsd: number;
  /** Sum of `estimatedUsd` over status `reserved`. */
  openReservedUsd: number;
  /** Sum of committed actual costs (where reported). */
  committedActualUsd: number;
  byEpisode: Array<{ episodeId: string; projectedUsd: number }>;
  byDay: Array<{ day: string; projectedUsd: number }>;
  byProvider: Array<{ provider: string; projectedUsd: number }>;
}

/** Per provider/model usage aggregation (spec §4 tracking fields). */
export interface ProviderUsage {
  provider: string;
  providerModel: string;
  requestedSeconds: number;
  generatedSeconds: number;
  acceptedSeconds: number;
  rejectedSeconds: number;
  retries: number;
  /** Sum of estimates over all non-released reservations (paid only). */
  estimatedUsd: number;
  /** Sum of committed actual costs (paid only). */
  actualUsd: number;
}

/** Input for recording included-quota consumption (tracked separately, spec §4). */
export interface QuotaUsageInput {
  provider: string;
  providerModel: string;
  /** Allowance period key, e.g. `2026-08-28` or a billing-period id. */
  period: string;
  /** What the units measure: `seconds`, `requests`, `images`, ... */
  unitsKind: string;
  units: number;
  reservationId?: string;
  note?: string;
}

export interface QuotaEntry {
  readonly id: string;
  readonly provider: string;
  readonly providerModel: string;
  readonly period: string;
  readonly unitsKind: string;
  readonly units: number;
  readonly reservationId?: string;
  readonly note?: string;
  readonly createdAt: string;
}

export interface QuotaUsage {
  provider: string;
  providerModel: string;
  period: string;
  unitsKind: string;
  unitsUsed: number;
}