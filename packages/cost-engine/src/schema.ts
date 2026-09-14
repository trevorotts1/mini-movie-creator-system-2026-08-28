/**
 * DDL for the cost-engine ledger tables (spec §4, §25).
 *
 * `cost_reservations` is THE single shared ledger every concurrent worker
 * reserves against. Atomicity comes from SQLite: each `reserve` runs inside
 * `BEGIN IMMEDIATE`, which takes the database write lock before reading the
 * cumulative total, so two processes/connections cannot both observe the
 * same pre-reservation balance and double-book (see `ledger.ts`).
 *
 * `cost_quota_usage` tracks included subscription/free allowance SEPARATELY
 * (spec §4: never counted as paid spend) — no reservation gate touches it.
 *
 * Ownership (SKR-010): the authoritative definition lives in
 * `@mmcs/database`'s migration band `050_`, which is what creates and owns
 * these tables in a production database. This module re-exports that same
 * text — there is deliberately no second copy of the DDL here, because two
 * hand-maintained definitions of one table is exactly how `provider_jobs`
 * drifted into two incompatible shapes (SKR-006).
 */
import {
  CREATE_COST_QUOTA_USAGE_INDEXES_SQL,
  CREATE_COST_QUOTA_USAGE_SQL,
  CREATE_COST_RESERVATIONS_INDEXES_SQL,
  CREATE_COST_RESERVATIONS_SQL,
} from "@mmcs/database";

export {
  CREATE_COST_QUOTA_USAGE_INDEXES_SQL,
  CREATE_COST_QUOTA_USAGE_SQL,
  CREATE_COST_RESERVATIONS_INDEXES_SQL,
  CREATE_COST_RESERVATIONS_SQL,
};

/**
 * Create the ledger tables in a database that has not been migrated — a
 * scratch/test database, or a caller that must have the tables before a
 * migration run.
 *
 * This is NOT how production databases get the ledger: `migrate(db,
 * MIGRATIONS)` applies band `050_`, which verifies this same shape and
 * records it in the migration ledger. Calling this helper on a production
 * database creates the tables outside the migration history — the condition
 * SKR-010 removed — so it stays idempotent and leaves any existing
 * (canonical) table untouched rather than adding a second owner.
 */
export function createCostEngineSchema(db: {
  exec(sql: string): void;
}): void {
  db.exec(CREATE_COST_RESERVATIONS_SQL);
  db.exec(CREATE_COST_RESERVATIONS_INDEXES_SQL);
  db.exec(CREATE_COST_QUOTA_USAGE_SQL);
  db.exec(CREATE_COST_QUOTA_USAGE_INDEXES_SQL);
}
