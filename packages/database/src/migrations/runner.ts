import { CREATE_MIGRATIONS_TABLE_SQL, MIGRATIONS_TABLE, type Migration, type MigrationRecord } from "./types.js";
import type { SqliteDatabase } from "../connection/index.js";

export interface MigrateOptions {
  /**
   * Reverse already-applied migrations that are not present in `migrations`
   * (or explicitly listed). Default: `false` (forward-only).
   */
  readonly rollback?: boolean;
  /** Restrict rollback to these migration ids. Ignored when rolling forward. */
  readonly rollbackTo?: string[];
}

export interface MigrateResult {
  /** Ids applied in this call, in application order. */
  readonly applied: string[];
  /** Ids rolled back in this call, in reverse application order. */
  readonly rolledBack: string[];
}

export class MigrationError extends Error {
  readonly migrationId: string;

  constructor(migrationId: string, message: string, options?: { cause?: unknown }) {
    super(`migration ${migrationId}: ${message}`, options === undefined ? undefined : { cause: options.cause });
    this.name = "MigrationError";
    this.migrationId = migrationId;
  }
}

/** Sort migrations by id; duplicate ids are a build-time contract breach. */
export function sortMigrations(migrations: readonly Migration[]): Migration[] {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id "${migration.id}" (${migration.name})`);
    }
    seen.add(migration.id);
  }
  return [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Apply (or roll back) migrations idempotently.
 *
 * Forward: the ledger table is created first; every migration not yet
 * recorded runs inside a single transaction (its SQL plus its ledger
 * insert commit or abort together), in ascending id order. Running twice
 * is a no-op the second time.
 *
 * Rollback: already-applied migrations missing from `migrations` (or
 * matched by `rollbackTo`) are reversed in descending id order, each in
 * its own transaction; a migration without `down` SQL aborts the rollback.
 */
export function migrate(db: SqliteDatabase, migrations: readonly Migration[], options: MigrateOptions = {}): MigrateResult {
  const ordered = sortMigrations(migrations);

  if (options.rollback === true) {
    return rollbackMigrations(db, ordered, options.rollbackTo);
  }

  db.exec(CREATE_MIGRATIONS_TABLE_SQL);
  const appliedIds = new Set(db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`).map((row) => String(row["id"])));
  const applied: string[] = [];

  for (const migration of ordered) {
    if (appliedIds.has(migration.id)) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration.up);
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, name, applied_at) VALUES (?, ?, ?)`).run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    applied.push(migration.id);
  }

  return { applied, rolledBack: [] };
}

function rollbackMigrations(
  db: SqliteDatabase,
  ordered: readonly Migration[],
  rollbackTo: readonly string[] | undefined,
): MigrateResult {
  const tableExists = db
    .get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATIONS_TABLE);
  if (tableExists === undefined) {
    return { applied: [], rolledBack: [] };
  }

  const knownById = new Map(ordered.map((migration) => [migration.id, migration]));
  const targetIds =
    rollbackTo === undefined
      ? undefined
      : new Set(
          rollbackTo.flatMap((id) => {
            if (!knownById.has(id)) {
              throw new Error(`rollbackTo references unknown migration id "${id}"`);
            }
            return [id];
          }),
        );

  const appliedIds = db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`).map((row) => String(row["id"]));
  const toReverse = appliedIds
    .filter((id) => (targetIds !== undefined ? targetIds.has(id) : true))
    .sort()
    .reverse();

  // Pre-flight every target before executing any: a rollback must never
  // leave the schema half-reversed because one migration lacked down SQL.
  // Applied migrations absent from the supplied list have no known down
  // SQL either, so a full rollback requires the full migration list.
  for (const id of toReverse) {
    const migration = knownById.get(id);
    if (migration === undefined || migration.down === undefined) {
      throw new Error(
        `migration ${id} has no down migration in the supplied migration list and cannot be rolled back`,
      );
    }
  }

  const rolledBack: string[] = [];
  for (const id of toReverse) {
    const migration = knownById.get(id);
    if (migration === undefined || migration.down === undefined) {
      continue; // unreachable after pre-flight; narrows the type
    }
    db.transaction(() => {
      db.exec(migration.down as string);
      db.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`).run(id);
    });
    rolledBack.push(id);
  }

  return { applied: [], rolledBack };
}

/** Ids currently recorded as applied, ascending. */
export function appliedMigrationIds(db: SqliteDatabase): string[] {
  const tableExists = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATIONS_TABLE);
  if (tableExists === undefined) {
    return [];
  }
  return db.all(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).map((row) => String(row["id"]));
}