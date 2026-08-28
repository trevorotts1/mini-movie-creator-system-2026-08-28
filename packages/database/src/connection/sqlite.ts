/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Options for opening an MMCS SQLite connection.
 *
 * The driver is Node's built-in `node:sqlite` (`DatabaseSync`), so the
 * database package ships zero native dependencies and the same connection
 * type is available in every MMCS process (CLI, API, workers). When MMCS
 * later migrates to PostgreSQL for the standalone app (spec §25), the
 * repositories in this package are re-implemented against the same
 * `SqliteDatabase` interface, not rewritten.
 */
export interface SqliteConnectOptions {
  /**
   * Database file path, or `":memory:"` for a transient in-memory database.
   * Parent directories of a file path are created if missing.
   */
  readonly path: string;
  /** Enforce foreign key constraints. Default: `true`. */
  readonly foreignKeys?: boolean;
  /** Write-ahead logging for file-backed databases. Default: `true`. */
  readonly wal?: boolean;
  /**
   * Busy timeout in milliseconds: how long SQLite waits on a locked
   * database before raising an error. Default: `5000`.
   */
  readonly busyTimeoutMs?: number;
}

/**
 * Default pragmas applied to every MMCS connection. Exported so tests and
 * operators can assert the connection profile without opening a database.
 */
export const SQLITE_CONNECTION_DEFAULTS = {
  foreignKeys: true,
  wal: true,
  busyTimeoutMs: 5000,
} as const;

/**
 * An open MMCS SQLite connection. Wraps `node:sqlite`'s `DatabaseSync`
 * behind the seam later repositories and the backup/export task
 * (CORE-015) program against, so the driver stays swappable.
 */
export interface SqliteDatabase {
  /** The underlying driver handle. Consumers should prefer the methods below. */
  readonly raw: DatabaseSync;
  /** Path the database was opened from (`":memory:"` for in-memory). */
  readonly path: string;
  /** Whether the connection is currently open. */
  readonly isOpen: boolean;
  /** Whether a transaction is currently active on this connection. */
  readonly inTransaction: boolean;

  /** Run one or more SQL statements; no parameter binding, no results. */
  exec(sql: string): void;
  /** Prepare a statement for parameterized execution. */
  prepare(sql: string): PreparedStatement;
  /** Read a single scalar-ish row or `undefined`. */
  get(sql: string, ...params: SqlValue[]): Record<string, SqlOutputValue> | undefined;
  /** Read all rows. */
  all(sql: string, ...params: SqlValue[]): Record<string, SqlOutputValue>[];
  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction
   * (SQLite savepoint semantics via plain BEGIN; the nested call neither
   * commits nor rolls back the outer one on its own failure).
   */
  transaction<T>(fn: () => T): T;
  /** Close the connection. Idempotent. */
  close(): void;
}

export interface PreparedStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Record<string, SqlOutputValue> | undefined;
  all(...params: SqlValue[]): Record<string, SqlOutputValue>[];
}

/** Values MMCS may bind into SQLite. */
export type SqlValue = null | number | bigint | string | Uint8Array;
/** Values SQLite may return. */
export type SqlOutputValue = null | number | bigint | string | Uint8Array;

/**
 * Open an MMCS SQLite database with the standard connection profile:
 * foreign keys ON, WAL journaling (file-backed only), busy timeout, and a
 * full-sync-safe default. In-memory databases skip WAL (SQLite ignores it
 * there and `journal_mode` reports `memory`).
 */
export function connectSqlite(options: SqliteConnectOptions): SqliteDatabase {
  const { path } = options;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const merged = {
    foreignKeys: options.foreignKeys ?? SQLITE_CONNECTION_DEFAULTS.foreignKeys,
    wal: options.wal ?? SQLITE_CONNECTION_DEFAULTS.wal,
    busyTimeoutMs: options.busyTimeoutMs ?? SQLITE_CONNECTION_DEFAULTS.busyTimeoutMs,
  };

  const raw = new DatabaseSync(path);
  if (merged.busyTimeoutMs > 0) {
    raw.exec(`PRAGMA busy_timeout = ${Math.trunc(merged.busyTimeoutMs)}`);
  }
  if (!merged.foreignKeys) {
    raw.exec("PRAGMA foreign_keys = OFF");
  }
  if (merged.wal && path !== ":memory:") {
    raw.exec("PRAGMA journal_mode = WAL");
    // NORMAL is the standard WAL durability pairing: consistent across
    // application crashes, only vulnerable to OS power loss.
    raw.exec("PRAGMA synchronous = NORMAL");
  }

  return new SqliteDatabaseImpl(raw, path);
}

class SqliteDatabaseImpl implements SqliteDatabase {
  readonly raw: DatabaseSync;
  readonly path: string;

  constructor(raw: DatabaseSync, path: string) {
    this.raw = raw;
    this.path = path;
  }

  get isOpen(): boolean {
    return this.raw.isOpen;
  }

  get inTransaction(): boolean {
    return this.raw.isTransaction;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return this.raw.prepare(sql);
  }

  get(sql: string, ...params: SqlValue[]): Record<string, SqlOutputValue> | undefined {
    return this.raw.prepare(sql).get(...params) as Record<string, SqlOutputValue> | undefined;
  }

  all(sql: string, ...params: SqlValue[]): Record<string, SqlOutputValue>[] {
    return this.raw.prepare(sql).all(...params) as Record<string, SqlOutputValue>[];
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      // Join the outer transaction: BEGIN inside BEGIN is an error in
      // SQLite, and a nested failure must not roll back the caller's work.
      return fn();
    }
    this.raw.exec("BEGIN");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // A rollback can itself fail (e.g. the transaction was already
        // resolved by a statement-level abort); surface the original error.
      }
      throw err;
    }
  }

  close(): void {
    if (this.raw.isOpen) {
      this.raw.close();
    }
  }
}