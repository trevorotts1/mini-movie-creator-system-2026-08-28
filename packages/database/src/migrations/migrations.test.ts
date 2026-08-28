/// <reference types="node" />
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../connection/index.js";
import { MIGRATIONS, MIGRATIONS_TABLE, migrate, sortMigrations, type Migration } from "./index.js";

let dir: string;
let caseCounter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-mig-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-mig-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshDb(): SqliteDatabase {
  caseCounter += 1;
  return connectSqlite({ path: join(dir, `case-${caseCounter}.db`) });
}

const ALPHA: Migration = {
  id: "0001",
  name: "create things",
  up: "CREATE TABLE things (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;",
  down: "DROP TABLE things;",
};

const BETA: Migration = {
  id: "0002",
  name: "alter things",
  up: "ALTER TABLE things ADD COLUMN note TEXT;",
  down: "ALTER TABLE things DROP COLUMN note;",
};

const GAMMA: Migration = {
  id: "0003",
  name: "seed things",
  up: "INSERT INTO things (label) VALUES ('seeded');",
  // Deliberately no down: data backfills are irreversible.
};

describe("migrate — forward application", () => {
  it("applies all migrations in ascending id order and records the ledger", () => {
    const db = freshDb();
    const result = migrate(db, [GAMMA, ALPHA, BETA]);
    expect(result.applied).toEqual(["0001", "0002", "0003"]);
    expect(result.rolledBack).toEqual([]);

    const ledger = db.all(`SELECT id, name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
    expect(ledger.map((r) => r["id"])).toEqual(["0001", "0002", "0003"]);
    expect(ledger.map((r) => r["name"])).toEqual(["create things", "alter things", "seed things"]);
    const appliedAt = String(db.get(`SELECT applied_at FROM ${MIGRATIONS_TABLE} WHERE id = '0001'`)?.["applied_at"]);
    expect(appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    db.close();
  });

  it("is idempotent: second run applies nothing", () => {
    const db = freshDb();
    migrate(db, [ALPHA, BETA, GAMMA]);
    const second = migrate(db, [ALPHA, BETA, GAMMA]);
    expect(second.applied).toEqual([]);
    expect(db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`)).toHaveLength(3);
    db.close();
  });

  it("resumes a partially migrated DB with exactly the missing migrations", () => {
    const db = freshDb();
    migrate(db, [ALPHA]);
    const resumed = migrate(db, [ALPHA, BETA, GAMMA]);
    expect(resumed.applied).toEqual(["0002", "0003"]);
    expect(db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`)).toHaveLength(3);
    db.close();
  });

  it("creates no product tables for the empty baseline band (000-init)", () => {
    const db = freshDb();
    const result = migrate(db, []);
    expect(result.applied).toEqual([]);
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => String(r["name"]));
    expect(tables).toEqual([MIGRATIONS_TABLE]);
    db.close();
  });

  it("runs each migration's SQL and its ledger insert atomically", () => {
    const db = freshDb();
    migrate(db, [ALPHA]);
    const failing = { id: "0002", name: "fails mid-flight", up: "CREATE TABLE ghost (x); SELECT * FROM missing_table;" };
    expect(() => migrate(db, [failing])).toThrow();
    // Neither the ghost table nor the 0002 ledger row survived the abort.
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'ghost'")).toBeUndefined();
    expect(db.get(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = '0002'`)).toBeUndefined();
    db.close();
  });
});

describe("migrate — rollback", () => {
  it("rolls back applied migrations in descending order", () => {
    const db = freshDb();
    migrate(db, [ALPHA, BETA]);
    const result = migrate(db, [ALPHA, BETA], { rollback: true });
    expect(result.rolledBack).toEqual(["0002", "0001"]);
    expect(db.get(`SELECT COUNT(*) AS c FROM ${MIGRATIONS_TABLE}`)?.["c"]).toBe(0);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'things'")).toBeUndefined();
    db.close();
  });

  it("refuses to roll back when any target lacks down SQL (pre-flight, nothing reversed)", () => {
    const db = freshDb();
    migrate(db, [ALPHA, BETA, GAMMA]);
    // GAMMA (0003) has no down: pre-flight aborts before BETA is reversed.
    expect(() => migrate(db, [ALPHA, BETA], { rollback: true })).toThrow(/0003.*no down migration/);
    // Ledger untouched by the aborted attempt.
    expect(db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`).map((r) => r["id"])).toEqual(["0001", "0002", "0003"]);
    const columns = db.all("PRAGMA table_info(things)").map((r) => String(r["name"]));
    expect(columns).toEqual(["id", "label", "note"]);
    db.close();
  });

  it("rolls back a listed subset via rollbackTo", () => {
    const db = freshDb();
    migrate(db, [ALPHA, BETA, GAMMA]);
    const result = migrate(db, [ALPHA, BETA, GAMMA], { rollback: true, rollbackTo: ["0002"] });
    expect(result.rolledBack).toEqual(["0002"]);
    expect(db.get(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = '0002'`)).toBeUndefined();
    expect(db.get(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = '0001'`)).toBeDefined();
    const columns = db.all("PRAGMA table_info(things)").map((r) => String(r["name"]));
    expect(columns).toEqual(["id", "label"]);
    db.close();
  });

  it("down → up round-trips cleanly (rollback then re-apply)", () => {
    const db = freshDb();
    migrate(db, [ALPHA, BETA]);
    migrate(db, [ALPHA, BETA], { rollback: true });
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'things'")).toBeUndefined();
    const reapply = migrate(db, [ALPHA, BETA, GAMMA]);
    expect(reapply.applied).toEqual(["0001", "0002", "0003"]);
    expect(db.all("SELECT note FROM things")).toHaveLength(1);
    db.close();
  });

  it("rollback on a never-migrated DB is a no-op", () => {
    const db = freshDb();
    const result = migrate(db, [ALPHA], { rollback: true });
    expect(result).toEqual({ applied: [], rolledBack: [] });
    db.close();
  });

  it("rejects rollbackTo ids that are not known migrations", () => {
    const db = freshDb();
    migrate(db, [ALPHA]);
    expect(() => migrate(db, [ALPHA], { rollback: true, rollbackTo: ["9999"] })).toThrow(/9999/);
    db.close();
  });
});

describe("migration ordering and identity", () => {
  it("sorts lexicographically by id regardless of input order", () => {
    const shuffled = sortMigrations([GAMMA, ALPHA, BETA]);
    expect(shuffled.map((m) => m.id)).toEqual(["0001", "0002", "0003"]);
  });

  it("rejects duplicate migration ids loudly", () => {
    expect(() => sortMigrations([ALPHA, { ...ALPHA, name: "dup" }])).toThrow(/duplicate migration id "0001"/);
  });

  it("orders band ids so later bands always follow the baseline band", () => {
    const bands: Migration[] = [
      { id: "0410", name: "band 040", up: "SELECT 1;" },
      { id: "0100", name: "band 010", up: "SELECT 1;" },
      { id: "0000", name: "baseline", up: "SELECT 1;" },
      { id: "0300", name: "band 030", up: "SELECT 1;" },
    ];
    expect(sortMigrations(bands).map((m) => m.id)).toEqual(["0000", "0100", "0300", "0410"]);
  });
});

describe("shipped MIGRATIONS registry", () => {
  it("applies twice cleanly and idempotently on a temp file DB", () => {
    const db = freshDb();
    const first = migrate(db, MIGRATIONS);
    expect(first.applied).toEqual([...first.applied].sort());
    expect(migrate(db, MIGRATIONS).applied).toEqual([]);
    expect(db.all(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).map((r) => String(r["id"]))).toEqual(first.applied);
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => String(r["name"]));
    expect(tables).toContain(MIGRATIONS_TABLE);
    db.close();
  });
});
