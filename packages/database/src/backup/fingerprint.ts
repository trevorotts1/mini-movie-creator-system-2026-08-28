/// <reference types="node" />
import { createHash } from "node:crypto";
import type { SqliteDatabase, SqlOutputValue } from "../connection/index.js";

/**
 * Per-table fingerprint (CORE-015): the row count plus a SHA-256 checksum
 * over the table's full contents. This is the acceptance artifact the
 * restore path is verified against — a restore into an empty database
 * passes only when every table's count AND checksum match the snapshot
 * exactly.
 *
 * Determinism contract:
 * - Rows are read in `rowid` order, so insertion order is preserved and
 *   the checksum is stable across export/restore of identical data.
 * - Each row is hashed as `JSON.stringify(values) + "\n"` with the column
 *   names in declared order — a row with reordered/renamed columns cannot
 *   collide with its source.
 * - Buffers (BLOB columns) serialize through JSON as `{"0":9,...}` shape
 *   on the raw driver; both sides hash the SAME driver representation, so
 *   the comparison is exact for every storage class SQLite STRICT tables
 *   hold (NULL, INTEGER, REAL, TEXT, BLOB).
 * - The `mmcs_migrations` ledger is fingerprinted like any other table:
 *   a restored database must carry the same applied-migration history.
 */

/** One table's verified content signature. */
export interface TableFingerprint {
  /** Table name as declared in the schema. */
  readonly table: string;
  /** Number of rows in the table. */
  readonly count: number;
  /** SHA-256 over the ordered, JSON-serialized row stream. */
  readonly sha256: string;
}

/** All fingerprints for one database, keyed by table name, sorted by name. */
export type DatabaseFingerprint = ReadonlyMap<string, TableFingerprint>;

/** User tables (and MMCS ledger tables) — never SQLite internals. */
const USER_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

/** Quote an identifier defensively — table names come from the catalog. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Canonical, hashable serialization of one raw driver row. Column values
 * are emitted in column-declared order (the driver's own ordering), which
 * is stable between an export database and its restore.
 */
function serializeRow(row: Record<string, SqlOutputValue>): string {
  return `${JSON.stringify(row)}\n`;
}

/**
 * Fingerprint every user table in the database. Exposed for the backup
 * manifest (export side) and the post-restore verification (restore side).
 */
export function fingerprintDatabase(db: SqliteDatabase): DatabaseFingerprint {
  const tables = db.all(USER_TABLES_SQL).map((row) => String(row["name"]));
  const out = new Map<string, TableFingerprint>();
  for (const table of tables) {
    out.set(table, fingerprintTable(db, table));
  }
  return out;
}

/**
 * Fingerprint one table: row count + SHA-256 over the rowid-ordered row
 * stream. A table with zero rows hashes the empty stream.
 */
export function fingerprintTable(db: SqliteDatabase, table: string): TableFingerprint {
  const rows = db.all(`SELECT * FROM ${quoteIdent(table)} ORDER BY rowid`);
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(serializeRow(row));
  }
  return { table, count: rows.length, sha256: hash.digest("hex") };
}

/** One mismatch between two fingerprints of the same table. */
export interface FingerprintMismatch {
  readonly table: string;
  readonly kind: "count" | "checksum" | "missing-in-restore" | "missing-in-source";
  readonly source: TableFingerprint | undefined;
  readonly restored: TableFingerprint | undefined;
}

/**
 * Compare two fingerprints. Returns every mismatch (empty = verified
 * identical). Used by the restore path to prove the acceptance criterion:
 * restore into an empty DB passes full row-count + checksum comparison.
 */
export function compareFingerprints(
  source: DatabaseFingerprint,
  restored: DatabaseFingerprint,
): FingerprintMismatch[] {
  const mismatches: FingerprintMismatch[] = [];
  const names = new Set<string>([...source.keys(), ...restored.keys()]);
  for (const table of [...names].sort()) {
    const a = source.get(table);
    const b = restored.get(table);
    if (a === undefined) {
      mismatches.push({ table, kind: "missing-in-source", source: a, restored: b });
      continue;
    }
    if (b === undefined) {
      mismatches.push({ table, kind: "missing-in-restore", source: a, restored: b });
      continue;
    }
    if (a.count !== b.count) {
      mismatches.push({ table, kind: "count", source: a, restored: b });
      continue;
    }
    if (a.sha256 !== b.sha256) {
      mismatches.push({ table, kind: "checksum", source: a, restored: b });
    }
  }
  return mismatches;
}