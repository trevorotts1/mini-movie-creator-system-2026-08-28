export const MMCS_COST_ENGINE = "@mmcs/cost-engine — atomic $25 cumulative spend reservations (spec §4)";

export {
  createCostEngineSchema,
  CREATE_COST_RESERVATIONS_SQL,
  CREATE_COST_RESERVATIONS_INDEXES_SQL,
  CREATE_COST_QUOTA_USAGE_SQL,
  CREATE_COST_QUOTA_USAGE_INDEXES_SQL,
} from "./schema.js";

export {
  CostEngineError,
  CostLedger,
  type CostLedgerOptions,
} from "./ledger.js";

export {
  DEFAULT_AUTO_SPEND_LIMIT_USD,
  RESERVATION_KINDS,
  RESERVATION_STATUSES,
  isApproved,
  type ProviderUsage,
  type QuotaEntry,
  type QuotaUsage,
  type QuotaUsageInput,
  type Reservation,
  type ReservationDecision,
  type ReservationInput,
  type ReservationKind,
  type ReservationStatus,
  type SpendSummary,
  type UsageMetrics,
} from "./types.js";

export { centsToUsd, usdToCents, MoneyError } from "./money.js";