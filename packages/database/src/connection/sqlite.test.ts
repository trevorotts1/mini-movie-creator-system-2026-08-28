/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, SQLITE_CONNECTION_DEFAULTS, type SqliteDatabase } from "./index.js";
import { migrate, MIGRATIONS_TABLE } from "../migrations/index.js";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-conn-"));
  dbPath = join(dir, "nested", "sub", "mmcs.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("connectSqlite", () => {
  it("opens a temp file DB, creating missing parent directories", () => {
    const db = connectSqlite({ path: dbPath });
    expect(db.isOpen).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  it("applies the default connection profile: WAL, foreign keys ON, busy timeout", () => {
    const db = connectSqlite({ path: dbPath });
    expect(db.get("PRAGMA journal_mode")?.["journal_mode"]).toBe("wal");
    expect(db.get("PRAGMA foreign_keys")?.["foreign_keys"]).toBe(1);
    expect(db.get("PRAGMA busy_timeout")?.["timeout"]).toBe(SQLITE_CONNECTION_DEFAULTS.busyTimeoutMs);
    db.close();
  });

  it("honors explicit option overrides", () => {
    const alt = join(dir, "alt.db");
    const db = connectSqlite({ path: alt, wal: false, busyTimeoutMs: 250, foreignKeys: false });
    expect(db.get("PRAGMA journal_mode")?.["journal_mode"]).not.toBe("wal");
    expect(db.get("PRAGMA busy_timeout")?.["timeout"]).toBe(250);
    expect(db.get("PRAGMA foreign_keys")?.["foreign_keys"]).toBe(0);
    db.close();
  });

  it("executes multi-statement SQL and returns typed rows", () => {
    const db = connectSqlite({ path: dbPath });
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO probe (label) VALUES ('a'), ('b');");
    const rows = db.all("SELECT id, label FROM probe ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["label"]).toBe("a");
    expect(rows[1]?.["id"]).toBe(2);
    expect(db.get("SELECT label FROM probe WHERE id = ?", 2)?.["label"]).toBe("b");
    db.close();
  });

  it("closes idempotently and reports isOpen false after close", () => {
    const db = connectSqlite({ path: dbPath });
    db.close();
    expect(db.isOpen).toBe(false);
    expect(() => db.close()).not.toThrow();
  });
});

describe("SqliteDatabase.transaction", () => {
  let db: SqliteDatabase;

  beforeAll(() => {
    db = connectSqlite({ path: dbPath });
    db.exec(`CREATE TABLE IF NOT EXISTS counter (n INTEGER NOT NULL) STRICT;`);
    db.exec("DELETE FROM counter");
  });

  afterAll(() => {
    db.close();
  });

  it("commits when the callback succeeds", () => {
    db.transaction(() => {
      db.exec("INSERT INTO counter (n) VALUES (1)");
      db.exec("INSERT INTO counter (n) VALUES (2)");
    });
    expect(db.get("SELECT COUNT(*) AS c FROM counter")?.["c"]).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it("rolls back every statement when the callback throws", () => {
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO counter (n) VALUES (3)");
        db.exec("INSERT INTO counter (n) VALUES (4)");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.get("SELECT COUNT(*) AS c FROM counter")?.["c"]).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it("joins an outer transaction: inner statements commit only with the outer one", () => {
    db.transaction(() => {
      db.exec("INSERT INTO counter (n) VALUES (10)");
      expect(() =>
        db.transaction(() => {
          db.exec("INSERT INTO counter (n) VALUES (11)");
          throw new Error("inner failure");
        }),
      ).toThrow("inner failure");
      // Outer transaction still live; inner failure neither committed nor
      // rolled back anything — both rows land when the outer call commits.
      expect(db.inTransaction).toBe(true);
    });
    expect(db.get("SELECT COUNT(*) AS c FROM counter")?.["c"]).toBe(4);
  });

  it("leaves no transaction open when the nested call throws inside an outer rollback path", () => {
    expect(() =>
      db.transaction(() => {
        throw new Error("outer boom");
      }),
    ).toThrow("outer boom");
    expect(db.inTransaction).toBe(false);
  });

  it("keeps migration SQL + ledger insert atomic (transaction integration)", () => {
    migrate(db, []); // creates the ledger table
    const broken = [
      { id: "9001", name: "broken", up: "CREATE TABLE doomed (x); DROP TABLE definitely_missing;", down: undefined },
    ];
    expect(() => migrate(db, broken)).toThrow();
    // Ledger untouched: the whole per-migration transaction aborted.
    expect(db.get(`SELECT COUNT(*) AS c FROM ${MIGRATIONS_TABLE}`)?.["c"]).toBe(0);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'doomed'")).toBeUndefined();
  });
});

describe("persistence across reopen", () => {
  it("sees committed data from a second connection after close/reopen", () => {
    const first = connectSqlite({ path: dbPath });
    first.exec("CREATE TABLE IF NOT EXISTS durable (v TEXT); DELETE FROM durable;");
    first.exec("INSERT INTO durable (v) VALUES ('persisted')");
    first.close();

    const second = connectSqlite({ path: dbPath });
    expect(second.get("SELECT v FROM durable")?.["v"]).toBe("persisted");
    // WAL sidecar files exist while the DB is open with WAL enabled.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    second.close();
    expect(readFileSync(dbPath).byteLength).toBeGreaterThan(0);
  });
});