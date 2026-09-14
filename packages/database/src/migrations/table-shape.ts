import type { SqliteDatabase } from "../connection/index.js";
import { MigrationError } from "./runner.js";

/**
 * Table-shape helpers for migrations that are not the first to touch a
 * table.
 *
 * WHY these exist: SQLite has no conditional DDL. `CREATE TABLE` is a bare
 * name collision, `ALTER TABLE` has no `IF EXISTS`, and a SQL string cannot
 * branch — so a migration that has to ADOPT a table somebody else already
 * created (SKR-006: the Agnes store self-healing a `ref`-keyed
 * `provider_jobs`), or that has to refuse a drifted one (SKR-010: the cost
 * ledger's ad-hoc `createCostEngineSchema` tables), is not expressible in
 * `up` SQL alone. Bands call these from {@link Migration.beforeUp}; `up`
 * then applies idempotently.
 *
 * The guard is deliberately NOT "the table exists, therefore accept it":
 * that is how one table ends up with two DDLs and two shapes. `CREATE TABLE
 * IF NOT EXISTS` may only no-op on a shape the band has verified.
 */

/** Token a band's DDL template carries where the table name belongs. */
const TABLE_TOKEN = "%TABLE%";

/** Resolve a `%TABLE%`-templated DDL to one concrete table name. */
export function tableDdlFor(ddlTemplate: string, table: string): string {
  return ddlTemplate.replace(TABLE_TOKEN, table);
}

/**
 * Declared column names of `table`, or `undefined` when the table does not
 * exist. Uses the `pragma_table_info` table-valued function because
 * `PRAGMA` itself cannot take a bound parameter — and a table name must
 * never be interpolated from data.
 */
export function tableColumns(db: SqliteDatabase, table: string): Set<string> | undefined {
  const rows = db.all("SELECT name FROM pragma_table_info(?)", table);
  return rows.length === 0 ? undefined : new Set(rows.map((row) => String(row["name"])));
}

/**
 * Column names declared by the `%TABLE%`-templated `ddlTemplate`, read back
 * from SQLite itself: the DDL is created under the scratch name
 * `probeTable` and introspected, so the expected list can never drift from
 * the schema it guards. (SKR-006 was exactly two hand-maintained DDLs
 * disagreeing; a third hand-maintained column list would be the same bug
 * again.)
 *
 * `ddlTemplate` must declare ONLY the table — no indexes, so a probe cannot
 * create index names the real table owns.
 */
export function declaredColumns(db: SqliteDatabase, ddlTemplate: string, probeTable: string): Set<string> {
  db.exec(`DROP TABLE IF EXISTS ${probeTable}`);
  db.exec(tableDdlFor(ddlTemplate, probeTable));
  const columns = tableColumns(db, probeTable);
  db.exec(`DROP TABLE IF EXISTS ${probeTable}`);
  return columns ?? new Set<string>();
}

/**
 * Assert that an existing table carries every column the canonical DDL
 * declares.
 *
 * Extra columns are tolerated — a later band may add columns to an existing
 * table with `ALTER TABLE` — but a MISSING column is refused rather than
 * papered over, because the migration cannot repair it and every caller
 * would go on to fail at query time (for the money ledger, possibly after
 * reserving spend).
 */
export function assertCanonicalColumns(args: {
  readonly migrationId: string;
  readonly table: string;
  readonly columns: ReadonlySet<string>;
  readonly canonical: ReadonlySet<string>;
}): void {
  const missing = [...args.canonical].filter((column) => !args.columns.has(column));
  if (missing.length > 0) {
    throw new MigrationError(
      args.migrationId,
      `existing table ${args.table} does not match the canonical schema this migration owns ` +
        `(missing column(s): ${missing.join(", ")}) — refusing to accept a drifted shape; ` +
        `reconcile or drop the table (after exporting its rows) before re-running`,
    );
  }
}
