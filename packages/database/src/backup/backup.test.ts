/// <reference types="node" />
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../connection/index.js";
import { MIGRATIONS, MIGRATIONS_TABLE, migrate } from "../migrations/index.js";
import {
  BACKUP_EXTENSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  ensureBackupExtension,
  exportBackup,
  readBackupManifest,
  restoreBackup,
} from "./backup.js";
import { compareFingerprints, fingerprintDatabase } from "./fingerprint.js";

/** One scratch dir for the whole suite, removed at the end. */
const CASE_DIR = mkdtempSync(join(tmpdir(), "mmcs-db-backup-"));
let caseCounter = 0;

afterAll(() => {
  rmSync(CASE_DIR, { recursive: true, force: true });
});

/** Unique subdirectory per case. */
function scratch(): string {
  caseCounter += 1;
  const path = join(CASE_DIR, `case-${caseCounter}`);
  rmSync(path, { recursive: true, force: true });
  return path;
}

interface TestDb {
  db: SqliteDatabase;
  path: string;
}

function freshDb(label: string, withData: boolean): TestDb {
  const caseDir = scratch();
  const path = join(caseDir, "source.db");
  const db = connectSqlite({ path });
  migrate(db, MIGRATIONS);
  if (withData) {
    // One row in a representative table from each schema band — exercises
    // STRICT typing, CHECK constraints, nullable columns, and the
    // mmcs_migrations ledger itself.
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO projects (id, name, kind, status, aspect_ratio, created_at, updated_at) VALUES (?, ?, 'standalone', 'active', '16:9', ?, ?)",
    ).run("proj-1", "backup probe", now, now);
    db.prepare(
      "INSERT INTO characters (character_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("char-1", "Probe", now, now);
    db.prepare(
      "INSERT INTO provider_jobs (id, request_hash, provider, provider_model, request_params, created_at, updated_at) VALUES (?, 'hash-1', 'test-provider', 'test-model', '{}', ?, ?)",
    ).run("job-1", now, now);
    db.prepare(
      "INSERT INTO scenes (scene_id, episode_id, sequence_index, created_at, updated_at) VALUES (?, 'ep-1', 1, ?, ?)",
    ).run("scene-1", now, now);
    db.prepare(
      "INSERT INTO assets (asset_id, asset_type, asset_state, created_at) VALUES (?, 'image', 'DRAFT', ?)",
    ).run("asset-1", now);
  }
  return { db, path: caseDir || label };
}

function insertProbeProject(db: SqliteDatabase, id: string, name: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id, name, kind, status, aspect_ratio, created_at, updated_at) VALUES (?, ?, 'standalone', 'active', '16:9', ?, ?)",
  ).run(id, name, now, now);
}

function appliedCount(db: SqliteDatabase): number {
  return db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`).length;
}

describe("backup format", () => {
  it("ensureBackupExtension appends .mmcsbak exactly once", () => {
    expect(ensureBackupExtension("/tmp/x")).toBe(`/tmp/x${BACKUP_EXTENSION}`);
    expect(ensureBackupExtension("/tmp/x.mmcsbak")).toBe("/tmp/x.mmcsbak");
  });
});

describe("exportBackup", () => {
  it("produces a .mmcsbak archive with a full manifest", async () => {
    const { db } = freshDb("manifest", true);
    const out = join(scratch(), "weekly");
    const result = await exportBackup(db, { outputPath: out });

    expect(result.archivePath.endsWith(BACKUP_EXTENSION)).toBe(true);
    expect(result.archiveBytes).toBeGreaterThan(0);

    const manifest = readBackupManifest(result.archivePath);
    expect(manifest.kind).toBe(BACKUP_FORMAT);
    expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.schemaVersion).toMatch(/^\d/);
    expect(manifest.migrations.length).toBeGreaterThan(0);
    expect(manifest.tables.map((t) => t.table)).toContain("projects");
    expect(manifest.tables.map((t) => t.table)).toContain(MIGRATIONS_TABLE);
    expect(manifest.snapshotBytes).toBeGreaterThan(0);
    expect(manifest.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    // The source database is untouched and still open.
    expect(db.isOpen).toBe(true);
    db.close();
  });

  it("manifest fingerprints match a live fingerprint of the source", async () => {
    const { db } = freshDb("manifest-agree", true);
    const result = await exportBackup(db, { outputPath: join(scratch(), "a") });
    const manifest = readBackupManifest(result.archivePath);
    const live = fingerprintDatabase(db);
    expect(
      compareFingerprints(new Map(manifest.tables.map((t) => [t.table, t])), live),
    ).toEqual([]);
    db.close();
  });
});

describe("round-trip — export then restore into an empty database", () => {
  it("restores every table with identical row counts and checksums", async () => {
    const { db } = freshDb("roundtrip", true);
    const caseDir = scratch();
    const archive = await exportBackup(db, { outputPath: join(caseDir, "backup") });

    const restorePath = join(caseDir, "restored.db");
    const restored = restoreBackup(archive.archivePath, { databasePath: restorePath });

    expect(restored.verified).toBe(true);
    expect(restored.mismatches).toEqual([]);

    // Acceptance: full row-count + checksum comparison against the SOURCE.
    const sourceFingerprint = fingerprintDatabase(db);
    const mismatches = compareFingerprints(sourceFingerprint, restored.fingerprint);
    expect(mismatches).toEqual([]);

    // The restored DB is a real, openable SQLite file with the data.
    const reopened = connectSqlite({ path: restored.databasePath, wal: false });
    const projects = reopened.all("SELECT * FROM projects ORDER BY rowid");
    expect(projects).toHaveLength(1);
    expect(String(projects[0]?.["name"])).toBe("backup probe");
    expect(reopened.all("SELECT * FROM characters")).toHaveLength(1);
    expect(reopened.all("SELECT * FROM provider_jobs")).toHaveLength(1);
    expect(reopened.all("SELECT * FROM scenes")).toHaveLength(1);
    expect(reopened.all("SELECT * FROM assets")).toHaveLength(1);
    expect(appliedCount(reopened)).toBe(appliedCount(db));
    reopened.close();
    db.close();
  });

  it("round-trips an EMPTY (schema-only) database", async () => {
    const { db } = freshDb("empty", false);
    const caseDir = scratch();
    const archive = await exportBackup(db, { outputPath: join(caseDir, "empty") });
    const restored = restoreBackup(archive.archivePath, {
      databasePath: join(caseDir, "restored.db"),
    });
    expect(restored.verified).toBe(true);
    expect(restored.mismatches).toEqual([]);
    for (const t of restored.manifest.tables) {
      // The migration ledger is data by design (12 applied migrations);
      // every PRODUCT table is empty in a schema-only database.
      if (t.table !== MIGRATIONS_TABLE) {
        expect(t.count).toBe(0);
      }
    }
    expect(restored.manifest.tables.find((t) => t.table === MIGRATIONS_TABLE)?.count).toBe(
      appliedCount(db),
    );
    db.close();
  });

  it("round-trips NULL, INTEGER, REAL, TEXT and BLOB values through a plain table", async () => {
    const caseDir = scratch();
    const db = connectSqlite({ path: join(caseDir, "src.db") });
    db.exec(
      "CREATE TABLE classes (id INTEGER PRIMARY KEY, n INTEGER, r REAL, t TEXT, b BLOB) STRICT;",
    );
    db.prepare("INSERT INTO classes (n, r, t, b) VALUES (?, ?, ?, ?)").run(
      42,
      3.5,
      "text",
      Uint8Array.from([1, 2, 3]),
    );
    db.prepare("INSERT INTO classes (n, r, t, b) VALUES (?, ?, ?, ?)").run(
      null,
      null,
      null,
      null,
    );
    const archive = await exportBackup(db, { outputPath: join(caseDir, "c") });
    const restored = restoreBackup(archive.archivePath, {
      databasePath: join(caseDir, "restored.db"),
    });
    expect(restored.verified).toBe(true);
    expect(compareFingerprints(fingerprintDatabase(db), restored.fingerprint)).toEqual([]);

    const reopened = connectSqlite({ path: restored.databasePath, wal: false });
    const rows = reopened.all(
      "SELECT typeof(n) tn, typeof(r) tr, typeof(t) tt, typeof(b) tb FROM classes ORDER BY id",
    );
    expect(rows.map((r) => `${r["tn"]},${r["tr"]},${r["tt"]},${r["tb"]}`)).toEqual([
      "integer,real,text,blob",
      "null,null,null,null",
    ]);
    reopened.close();
    db.close();
  });

  it("restores are idempotent: same archive restores to an identical database", async () => {
    const { db } = freshDb("idempotent", true);
    const caseDir = scratch();
    const archive = await exportBackup(db, { outputPath: join(caseDir, "b") });
    const one = restoreBackup(archive.archivePath, { databasePath: join(caseDir, "one.db") });
    const two = restoreBackup(archive.archivePath, { databasePath: join(caseDir, "two.db") });
    expect(one.verified).toBe(true);
    expect(two.verified).toBe(true);
    expect(compareFingerprints(one.fingerprint, two.fingerprint)).toEqual([]);
    db.close();
  });
});

describe("restore safety", () => {
  it("refuses to overwrite an existing database without overwrite: true", async () => {
    const { db } = freshDb("no-overwrite", true);
    const caseDir = scratch();
    const archive = await exportBackup(db, { outputPath: join(caseDir, "b") });
    const target = join(caseDir, "existing.db");
    const existing = connectSqlite({ path: target, wal: false });
    existing.close();
    expect(() =>
      restoreBackup(archive.archivePath, { databasePath: target }),
    ).toThrow(BackupError);
    // With overwrite: true it succeeds.
    const restored = restoreBackup(archive.archivePath, {
      databasePath: target,
      overwrite: true,
    });
    expect(restored.verified).toBe(true);
    db.close();
  });

  it("rejects a corrupt archive with BackupError", async () => {
    const { db } = freshDb("corrupt", true);
    const caseDir = scratch();
    const archive = await exportBackup(db, { outputPath: join(caseDir, "b") });
    rmSync(archive.archivePath);
    const bogus = join(caseDir, "bogus.mmcsbak");
    writeFileSync(bogus, Buffer.from("this is not a backup"));
    expect(() =>
      restoreBackup(bogus, { databasePath: join(caseDir, "r.db") }),
    ).toThrow(BackupError);
    db.close();
  });

  it("rejects a tampered payload: flipped snapshot bytes fail the integrity check", async () => {
    const { db } = freshDb("tamper", true);
    const caseDir = scratch();
    const archive = await exportBackup(db, { outputPath: join(caseDir, "b") });
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const envelope = JSON.parse(
      gunzipSync(readArchive(archive.archivePath)).toString("utf8"),
    ) as Record<string, unknown>;
    const snapshot = Buffer.from(String(envelope["snapshotBase64"]), "base64");
    // Flip one bit deep inside the page data.
    snapshot[snapshot.byteLength - 10] = (snapshot[snapshot.byteLength - 10] ?? 0) ^ 0xff;
    envelope["snapshotBase64"] = snapshot.toString("base64");
    writeFileSync(
      join(caseDir, "tampered.mmcsbak"),
      gzipSync(Buffer.from(JSON.stringify(envelope))),
    );
    expect(() =>
      restoreBackup(join(caseDir, "tampered.mmcsbak"), {
        databasePath: join(caseDir, "r.db"),
      }),
    ).toThrow(/integrity check failed/);
    db.close();
  });

  it("rejects an unknown format kind / version with BackupError", async () => {
    const caseDir = scratch();
    mkdirSync(caseDir, { recursive: true });
    const { gzipSync } = await import("node:zlib");
    const envelope = {
      kind: "some-other-backup",
      formatVersion: BACKUP_FORMAT_VERSION,
      snapshotBase64: "",
    };
    writeFileSync(
      join(caseDir, "kind.mmcsbak"),
      gzipSync(Buffer.from(JSON.stringify(envelope))),
    );
    expect(() =>
      restoreBackup(join(caseDir, "kind.mmcsbak"), { databasePath: join(caseDir, "r.db") }),
    ).toThrow(/kind is not/);

    const versioned = {
      kind: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION + 1,
      snapshotBase64: "",
    };
    writeFileSync(
      join(caseDir, "ver.mmcsbak"),
      gzipSync(Buffer.from(JSON.stringify(versioned))),
    );
    expect(() =>
      restoreBackup(join(caseDir, "ver.mmcsbak"), { databasePath: join(caseDir, "r2.db") }),
    ).toThrow(/formatVersion/);
  });
});

describe("export is WAL-safe", () => {
  it("captures committed data from a WAL-mode file database without checkpoint side effects", async () => {
    const caseDir = scratch();
    const db = connectSqlite({ path: join(caseDir, "live.db") });
    migrate(db, MIGRATIONS);
    insertProbeProject(db, "proj-wal", "wal probe");
    // Data sits in the -wal file (NORMAL sync, no checkpoint requested).
    expect(db.get("PRAGMA journal_mode")?.["journal_mode"]).toBe("wal");

    const archive = await exportBackup(db, { outputPath: join(caseDir, "wal") });
    const restored = restoreBackup(archive.archivePath, {
      databasePath: join(caseDir, "restored.db"),
    });
    expect(restored.verified).toBe(true);
    expect(compareFingerprints(fingerprintDatabase(db), restored.fingerprint)).toEqual([]);
    db.close();
  });
});

function readArchive(path: string): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(path) as Buffer;
}