/// <reference types="node" />
import { gzipSync, gunzipSync } from "node:zlib";
import { backup as sqliteBackup } from "node:sqlite";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { connectSqlite, type SqliteDatabase } from "../connection/index.js";
import { appliedMigrationIds } from "../migrations/index.js";
import {
  fingerprintDatabase,
  type DatabaseFingerprint,
  type TableFingerprint,
} from "./fingerprint.js";

/**
 * MMCS database backup archive (CORE-015, spec §25).
 *
 * Format: ONE `.mmcsbak` file = gzip(deflate) of a JSON envelope whose
 * `snapshotBase64` field is the SQLite snapshot bytes, base64-encoded.
 * The snapshot is produced with `node:sqlite`'s online `backup()` API
 * (the sqlite3 backup protocol), which:
 *   - is safe against a live WAL-mode database (committed WAL content is
 *     included — verified against the connection profile MMCS ships);
 *   - produces a CLEAN standalone database file (journal mode reset), so
 *     restoring is a plain file open with no sidecar `-wal`/`-shm`.
 *
 * Zero dependencies beyond Node built-ins — the database package's
 * no-native-deps contract (spec §25) is preserved.
 *
 * The envelope also carries a manifest: schema version (the highest
 * applied migration id), the full applied-migration id list, per-table
 * row counts + SHA-256 checksums, and the sha256 of the raw snapshot
 * bytes. The restore path re-verifies all of it after materialization —
 * an archive that does not round-trip is rejected, not trusted.
 */

/** Envelope `kind` discriminator — every MMCS backup carries it. */
export const BACKUP_FORMAT = "mmcs-db-backup";
/** Envelope format version. Bump only for wire-format changes. */
export const BACKUP_FORMAT_VERSION = 1;
/** Conventional archive file extension. */
export const BACKUP_EXTENSION = ".mmcsbak";

/** Manifest stored inside every backup archive (metadata, no payload). */
export interface BackupManifest {
  readonly kind: typeof BACKUP_FORMAT;
  readonly formatVersion: number;
  readonly createdAt: string;
  /** Source database path at export time (`":memory:"` stays literal). */
  readonly sourcePath: string;
  /** Highest applied migration id at export time (schema version). */
  readonly schemaVersion: string | null;
  /** All applied migration ids, ascending. */
  readonly migrations: readonly string[];
  /** Per-table fingerprints (row count + sha256), sorted by table name. */
  readonly tables: readonly TableFingerprint[];
  /** sha256 of the raw (uncompressed) SQLite snapshot bytes. */
  readonly snapshotSha256: string;
  /** Raw snapshot byte length. */
  readonly snapshotBytes: number;
}

/** The full archive envelope (manifest + payload). */
export interface BackupEnvelope extends BackupManifest {
  /** Base64 of the raw SQLite snapshot bytes. */
  readonly snapshotBase64: string;
}

/** Result of `exportBackup`. */
export interface BackupExportResult {
  /** Absolute path the archive was written to. */
  readonly archivePath: string;
  /** The manifest stored inside the archive. */
  readonly manifest: BackupManifest;
  /** Compressed archive size in bytes. */
  readonly archiveBytes: number;
}

/** Error thrown for corrupt/rejected archives and restore failures. */
export class BackupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "BackupError";
  }
}

/** Ensure an output path carries the conventional extension. */
export function ensureBackupExtension(path: string): string {
  return extname(path) === BACKUP_EXTENSION ? path : `${path}${BACKUP_EXTENSION}`;
}

/**
 * Read the manifest from an archive file without materializing the
 * snapshot (verification/inspection use).
 */
export function readBackupManifest(archivePath: string): BackupManifest {
  const envelope = parseEnvelope(readFileSync(resolve(archivePath)));
  const { snapshotBase64: _payload, ...manifest } = envelope;
  return manifest;
}

function parseEnvelope(raw: Uint8Array): BackupEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(gunzipSync(raw).toString("utf8"));
  } catch (err) {
    throw new BackupError("archive is not a readable .mmcsbak envelope (gzip+JSON)", { cause: err });
  }
  if (typeof json !== "object" || json === null) {
    throw new BackupError("archive envelope is not an object");
  }
  const env = json as Record<string, unknown>;
  if (env["kind"] !== BACKUP_FORMAT) {
    throw new BackupError(`archive kind is not "${BACKUP_FORMAT}"`);
  }
  if (env["formatVersion"] !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `archive formatVersion ${String(env["formatVersion"])} is not supported (this build reads ${BACKUP_FORMAT_VERSION})`,
    );
  }
  if (typeof env["snapshotBase64"] !== "string") {
    throw new BackupError("archive envelope is missing the snapshot payload");
  }
  return json as BackupEnvelope;
}

/**
 * Export a live MMCS SQLite database to a restorable `.mmcsbak` archive.
 *
 * The snapshot is taken with the sqlite3 online backup protocol through
 * `node:sqlite` (WAL-safe, includes committed transactions, does not
 * block readers). The manifest records per-table fingerprints so the
 * restore can prove fidelity; the snapshot's own sha256 guards against
 * archive corruption.
 *
 * The source database is never modified and never closed.
 */
export async function exportBackup(
  db: SqliteDatabase,
  options: { readonly outputPath: string },
): Promise<BackupExportResult> {
  const archivePath = ensureBackupExtension(resolve(options.outputPath));
  const snapshotPath = `${archivePath}.snap-${process.pid}-${Date.now()}`;
  // The backup API writes a file: its parent must exist first.
  mkdirSync(dirname(archivePath), { recursive: true });
  await sqliteBackup(db.raw, snapshotPath);
  try {
    const snapshot = readFileSync(snapshotPath);
    const fingerprint = fingerprintDatabase(db);
    const tables = [...fingerprint.values()].sort((a, b) => (a.table < b.table ? -1 : 1));
    const migrations = appliedMigrationIds(db);
    const manifest: BackupManifest = {
      kind: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      sourcePath: db.path,
      schemaVersion: migrations.at(-1) ?? null,
      migrations,
      tables,
      snapshotSha256: createHash("sha256").update(snapshot).digest("hex"),
      snapshotBytes: snapshot.byteLength,
    };
    const envelope: BackupEnvelope = {
      ...manifest,
      snapshotBase64: Buffer.from(snapshot).toString("base64"),
    };
    const payload = gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"));
    mkdirSync(dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, payload);
    return {
      archivePath,
      manifest,
      archiveBytes: payload.byteLength,
    };
  } finally {
    try {
      unlinkSync(snapshotPath);
    } catch {
      // best-effort cleanup; the archive itself is already consistent
    }
  }
}

/** Result of `restoreBackup`. */
export interface BackupRestoreResult {
  /** Absolute path of the materialized (restored) database file. */
  readonly databasePath: string;
  /** The manifest read from the archive. */
  readonly manifest: BackupManifest;
  /** Post-restore fingerprint of the materialized database. */
  readonly fingerprint: DatabaseFingerprint;
  /** True when row counts AND checksums match the manifest exactly. */
  readonly verified: boolean;
  /** Any mismatches found during verification (empty when verified). */
  readonly mismatches: readonly string[];
}

/**
 * Restore a `.mmcsbak` archive into an EMPTY database file.
 *
 * The materialized database is a clean standalone SQLite file (journal
 * mode reset by the backup protocol), so opening it is a plain file open.
 * After materialization the restore re-verifies:
 *   1. the snapshot's sha256 + size against the manifest (payload integrity);
 *   2. the applied-migration ledger matches the manifest;
 *   3. full row-count + checksum comparison for every table (the
 *      acceptance criterion).
 *
 * Refuses to overwrite an existing database file unless
 * `options.overwrite` is set — a restore is always an explicit act.
 */
export function restoreBackup(
  archivePath: string,
  options: { readonly databasePath: string; readonly overwrite?: boolean },
): BackupRestoreResult {
  const target = resolve(options.databasePath);
  const envelope = parseEnvelope(readFileSync(resolve(archivePath)));
  const snapshot = Buffer.from(envelope.snapshotBase64, "base64");

  const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
  if (snapshotSha256 !== envelope.snapshotSha256) {
    throw new BackupError(
      `snapshot integrity check failed: archive manifest sha256 ${envelope.snapshotSha256}, payload ${snapshotSha256}`,
    );
  }
  if (snapshot.byteLength !== envelope.snapshotBytes) {
    throw new BackupError(
      `snapshot size mismatch: manifest ${envelope.snapshotBytes}, payload ${snapshot.byteLength}`,
    );
  }

  mkdirSync(dirname(target), { recursive: true });
  if (!options.overwrite) {
    if (existsSafe(target)) {
      throw new BackupError(
        `refusing to overwrite existing database file: ${target} (pass overwrite: true)`,
      );
    }
  }
  writeFileSync(target, snapshot);

  const db = connectSqlite({ path: target, wal: false });
  try {
    const mismatches: string[] = [];

    const applied = appliedMigrationIds(db);
    const manifestMigrations = [...envelope.migrations].sort();
    if (applied.join(",") !== manifestMigrations.join(",")) {
      mismatches.push(
        `migration ledger mismatch: manifest [${manifestMigrations.join(", ")}], restored [${applied.join(", ")}]`,
      );
    }

    const fingerprint = fingerprintDatabase(db);
    const manifestByTable = new Map(envelope.tables.map((t) => [t.table, t]));
    const names = new Set<string>([...manifestByTable.keys(), ...fingerprint.keys()]);
    for (const table of [...names].sort()) {
      const m = manifestByTable.get(table);
      const r = fingerprint.get(table);
      if (m === undefined) {
        mismatches.push(`table "${table}" exists in restored database but not in manifest`);
        continue;
      }
      if (r === undefined) {
        mismatches.push(`table "${table}" is missing from the restored database`);
        continue;
      }
      if (m.count !== r.count) {
        mismatches.push(`table "${table}" row count mismatch: manifest ${m.count}, restored ${r.count}`);
        continue;
      }
      if (m.sha256 !== r.sha256) {
        mismatches.push(`table "${table}" checksum mismatch after restore`);
      }
    }

    return {
      databasePath: target,
      manifest: envelope,
      fingerprint,
      verified: mismatches.length === 0,
      mismatches,
    };
  } finally {
    db.close();
  }
}

function existsSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}