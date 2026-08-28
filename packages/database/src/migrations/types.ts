/**
 * One migration: forward SQL, optional reverse SQL, and its identity.
 *
 * `id` is the zero-padded band+sequence identifier (e.g. `"0001"` for the
 * baseline band `000_`). Migration directories inside
 * `packages/database/src/migrations/` follow ownership bands (see
 * ownership.md): CORE-003 owns `000_–009_`, later bands belong to the
 * schema tasks (CORE-004..007). The runner sorts by `id`, so ordering is
 * explicit, never directory-arrival order.
 */
export interface Migration {
  /** Stable, zero-padded, lexicographically sortable identifier. */
  readonly id: string;
  /** Human-readable name for logs and error messages. */
  readonly name: string;
  /** Forward SQL. Applied inside a transaction. */
  readonly up: string;
  /**
   * Reverse SQL. Omit for migrations that are deliberately irreversible
   * (e.g. data backfills); rollback then refuses to reverse them.
   */
  readonly down?: string;
}

/**
 * A row of the schema migrations ledger table (`mmcs_migrations`).
 */
export interface MigrationRecord {
  readonly id: string;
  readonly name: string;
  readonly appliedAt: string;
}

export const MIGRATIONS_TABLE = "mmcs_migrations";

export const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`.trim();