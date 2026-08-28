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
 */
export const CREATE_COST_RESERVATIONS_SQL = `
CREATE TABLE IF NOT EXISTS cost_reservations (
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

export const CREATE_COST_RESERVATIONS_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_cost_reservations_status ON cost_reservations (status);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_kind ON cost_reservations (kind);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_episode ON cost_reservations (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_reservations_job ON cost_reservations (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_reservations_provider ON cost_reservations (provider, provider_model);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_day ON cost_reservations (created_at);
`.trim();

export const CREATE_COST_QUOTA_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS cost_quota_usage (
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

export const CREATE_COST_QUOTA_USAGE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_cost_quota_usage_lookup
  ON cost_quota_usage (provider, provider_model, period, units_kind);
CREATE INDEX IF NOT EXISTS idx_cost_quota_usage_reservation
  ON cost_quota_usage (reservation_id) WHERE reservation_id IS NOT NULL;
`.trim();

/** Convenience for callers that create the schema themselves (tests, CLI init). */
export function createCostEngineSchema(db: {
  exec(sql: string): void;
}): void {
  db.exec(CREATE_COST_RESERVATIONS_SQL);
  db.exec(CREATE_COST_RESERVATIONS_INDEXES_SQL);
  db.exec(CREATE_COST_QUOTA_USAGE_SQL);
  db.exec(CREATE_COST_QUOTA_USAGE_INDEXES_SQL);
}