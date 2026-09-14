import type { SqliteDatabase } from "../../connection/index.js";
import { assertCanonicalColumns, declaredColumns, tableColumns } from "../table-shape.js";
import type { Migration } from "../types.js";

/**
 * Band `050_` (CORE-009): the spend ledger's durable tables (spec §4).
 *
 * WHY this band exists (SKR-010): `cost_reservations` and `cost_quota_usage`
 * used to be created ad hoc by `@mmcs/cost-engine`'s `createCostEngineSchema`.
 * Tables that exist only because a helper happened to run are tables no
 * migration owns: nothing recorded them, a fresh install only got them if the
 * caller called the helper, and the $25 cumulative spend gate had no schema
 * guarantee underneath it. This band makes the migration registry the owner;
 * `createCostEngineSchema` still exists for scratch/test databases and
 * executes the SAME DDL text exported here, so there is exactly one
 * definition of the ledger shape (two DDLs is how the provider_jobs tables
 * drifted apart — SKR-006).
 *
 * `cost_reservations` is THE single shared ledger every concurrent worker
 * reserves against. Atomicity comes from SQLite: each `reserve` runs inside
 * `BEGIN IMMEDIATE`, which takes the database write lock before reading the
 * cumulative total, so two processes/connections cannot both observe the
 * same pre-reservation balance and double-book (see cost-engine `ledger.ts`).
 *
 * `cost_quota_usage` tracks included subscription/free allowance SEPARATELY
 * (spec §4: never counted as paid spend) — no reservation gate touches it.
 */

/** Table names and the scratch name used to read canonical columns back. */
export const COST_RESERVATIONS_TABLE = "cost_reservations";
export const COST_QUOTA_USAGE_TABLE = "cost_quota_usage";
const SHAPE_PROBE_TABLE = "__mmcs_shape_probe_0500";

/**
 * `%TABLE%`-templated DDL so the shape guard can introspect the exact
 * declaration the migration applies.
 */
const COST_RESERVATIONS_DDL_TEMPLATE = `
CREATE TABLE IF NOT EXISTS %TABLE% (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  episode_id TEXT,
  provider TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('paid', 'included')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  estimated_cents INTEGER NOT NULL CHECK (estimated_cents >= 0),
  actual_cents INTEGER CHECK (actual_cents IS NULL OR actual_cents >= 0),
  requested_seconds REAL,
  generated_seconds REAL,
  accepted_seconds REAL,
  rejected_seconds REAL,
  retries INTEGER,
  approved_at TEXT,
  approval_note TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`.trim();

const COST_QUOTA_USAGE_DDL_TEMPLATE = `
CREATE TABLE IF NOT EXISTS %TABLE% (
  id TEXT PRIMARY KEY,
  reservation_id TEXT,
  provider TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  period TEXT NOT NULL,
  units_kind TEXT NOT NULL,
  units REAL NOT NULL CHECK (units >= 0),
  note TEXT,
  created_at TEXT NOT NULL
) STRICT;
`.trim();

/** Canonical DDL for `cost_reservations` (the text `createCostEngineSchema` execs). */
export const CREATE_COST_RESERVATIONS_SQL = COST_RESERVATIONS_DDL_TEMPLATE.replace(
  "%TABLE%",
  COST_RESERVATIONS_TABLE,
);

/** Canonical DDL for `cost_quota_usage` (the text `createCostEngineSchema` execs). */
export const CREATE_COST_QUOTA_USAGE_SQL = COST_QUOTA_USAGE_DDL_TEMPLATE.replace(
  "%TABLE%",
  COST_QUOTA_USAGE_TABLE,
);

/**
 * Ledger indexes. `IF NOT EXISTS` is safe here because the shape guard has
 * already verified the table: databases whose tables were created by
 * `createCostEngineSchema` legitimately arrive with these indexes already
 * present. `idx_cost_reservations_day` serves the per-day spend rollup.
 */
export const CREATE_COST_RESERVATIONS_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_cost_reservations_status ON cost_reservations (status);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_kind ON cost_reservations (kind);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_episode ON cost_reservations (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_reservations_job ON cost_reservations (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_reservations_provider ON cost_reservations (provider, provider_model);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_day ON cost_reservations (created_at);
`.trim();

export const CREATE_COST_QUOTA_USAGE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_cost_quota_usage_lookup
  ON cost_quota_usage (provider, provider_model, period, units_kind);
CREATE INDEX IF NOT EXISTS idx_cost_quota_usage_reservation
  ON cost_quota_usage (reservation_id) WHERE reservation_id IS NOT NULL;
`.trim();

/**
 * Accept an already-existing ledger table only when it carries every
 * canonical column.
 *
 * Production databases created before this band ran `createCostEngineSchema`
 * themselves, so `up`'s `CREATE TABLE IF NOT EXISTS` MUST tolerate their
 * tables (a bare `CREATE TABLE` would abort on every one of them — the exact
 * SKR-006 failure mode). But tolerating them silently is how a drifted
 * ledger survives: a table missing `kind` or `estimated_cents` would break
 * the gate at reserve time, i.e. on the money path. So the shape is verified
 * here and the migration refuses anything else.
 */
function verifyExistingLedgerTable(
  db: SqliteDatabase,
  migrationId: string,
  table: string,
  ddlTemplate: string,
): void {
  const columns = tableColumns(db, table);
  if (columns === undefined) {
    return; // absent: `up` creates it
  }
  assertCanonicalColumns({
    migrationId,
    table,
    columns,
    canonical: declaredColumns(db, ddlTemplate, SHAPE_PROBE_TABLE),
  });
}

export const costLedgerMigrations: readonly Migration[] = [
  {
    id: "0501",
    name: "create cost_reservations",
    beforeUp: (db) =>
      verifyExistingLedgerTable(db, "0501", COST_RESERVATIONS_TABLE, COST_RESERVATIONS_DDL_TEMPLATE),
    up: `${CREATE_COST_RESERVATIONS_SQL}

${CREATE_COST_RESERVATIONS_INDEXES_SQL}`,
    down: `
DROP INDEX IF EXISTS idx_cost_reservations_day;
DROP INDEX IF EXISTS idx_cost_reservations_provider;
DROP INDEX IF EXISTS idx_cost_reservations_job;
DROP INDEX IF EXISTS idx_cost_reservations_episode;
DROP INDEX IF EXISTS idx_cost_reservations_kind;
DROP INDEX IF EXISTS idx_cost_reservations_status;
DROP TABLE cost_reservations;
`.trim(),
  },
  {
    id: "0502",
    name: "create cost_quota_usage",
    beforeUp: (db) =>
      verifyExistingLedgerTable(db, "0502", COST_QUOTA_USAGE_TABLE, COST_QUOTA_USAGE_DDL_TEMPLATE),
    up: `${CREATE_COST_QUOTA_USAGE_SQL}

${CREATE_COST_QUOTA_USAGE_INDEXES_SQL}`,
    down: `
DROP INDEX IF EXISTS idx_cost_quota_usage_reservation;
DROP INDEX IF EXISTS idx_cost_quota_usage_lookup;
DROP TABLE cost_quota_usage;
`.trim(),
  },
];
