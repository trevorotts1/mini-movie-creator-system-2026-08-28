/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS } from "../registry.js";
import { migrate } from "../runner.js";
import { MIGRATIONS_TABLE } from "../types.js";
import {
  COST_QUOTA_USAGE_TABLE,
  COST_RESERVATIONS_TABLE,
  CREATE_COST_QUOTA_USAGE_INDEXES_SQL,
  CREATE_COST_QUOTA_USAGE_SQL,
  CREATE_COST_RESERVATIONS_INDEXES_SQL,
  CREATE_COST_RESERVATIONS_SQL,
  costLedgerMigrations,
} from "./index.js";

/**
 * SKR-010 — the $25 cumulative spend ledger must live in the production
 * database, not in tables some helper happened to create.
 *
 * Before band `050_`, `cost_reservations`/`cost_quota_usage` were created by
 * `@mmcs/cost-engine`'s `createCostEngineSchema` and were absent from
 * `MIGRATIONS`: a database that was migrated but never handed to that helper
 * had nowhere durable to record spend, so a restart could reset the gate.
 */

function freshDb(): SqliteDatabase {
  return connectSqlite({ path: ":memory:" });
}

function columns(db: SqliteDatabase, table: string): string[] {
  return db.all(`PRAGMA table_info(${table})`).map((row) => String(row["name"]));
}

function scalar(db: SqliteDatabase, sql: string): unknown {
  const row = db.get(sql);
  return row === undefined ? undefined : Object.values(row)[0];
}

function tableSql(db: SqliteDatabase, table: string): string {
  return String(
    db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.["sql"] ?? "",
  );
}

/** Exactly what `createCostEngineSchema` executes (the pre-band ad-hoc path). */
function createLedgerTablesAdHoc(db: SqliteDatabase): void {
  db.exec(CREATE_COST_RESERVATIONS_SQL);
  db.exec(CREATE_COST_RESERVATIONS_INDEXES_SQL);
  db.exec(CREATE_COST_QUOTA_USAGE_SQL);
  db.exec(CREATE_COST_QUOTA_USAGE_INDEXES_SQL);
}

function insertReservation(db: SqliteDatabase, id: string, estimatedCents: number): void {
  db.prepare(
    `INSERT INTO cost_reservations (
       id, provider, provider_model, kind, status, estimated_cents, created_at, updated_at
     ) VALUES (?, 'agnes', 'agnes-video-2.5-flash', 'paid', 'reserved', ?, ?, ?)`,
  ).run(id, estimatedCents, "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");
}

describe("050_ cost ledger band — shipped in the migration registry", () => {
  it("is part of MIGRATIONS", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids).toContain("0501");
    expect(ids).toContain("0502");
  });

  it("creates both ledger tables, both index sets and the ledger rows on a fresh database", () => {
    const db = freshDb();
    const applied = migrate(db, MIGRATIONS).applied;

    expect(applied).toContain("0501");
    expect(applied).toContain("0502");
    for (const table of [COST_RESERVATIONS_TABLE, COST_QUOTA_USAGE_TABLE]) {
      expect(tableSql(db, table)).toContain("STRICT");
    }
    expect(columns(db, COST_RESERVATIONS_TABLE)).toContain("estimated_cents");
    expect(columns(db, COST_RESERVATIONS_TABLE)).toContain("kind");
    expect(columns(db, COST_QUOTA_USAGE_TABLE)).toContain("units_kind");
    const indexes = db
      .all("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .map((row) => String(row["name"]));
    expect(indexes).toContain("idx_cost_reservations_status");
    expect(indexes).toContain("idx_cost_reservations_day");
    expect(indexes).toContain("idx_cost_quota_usage_lookup");
    expect(
      db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id IN ('0501', '0502')`),
    ).toHaveLength(2);
    db.close();
  });

  it("applies cleanly over tables an ad-hoc createCostEngineSchema already made, keeping spend rows", () => {
    const db = freshDb();
    createLedgerTablesAdHoc(db);
    insertReservation(db, "res-existing", 2499);

    const result = migrate(db, costLedgerMigrations);
    expect(result.applied).toEqual(["0501", "0502"]);
    // The accumulated spend is exactly what it was: the migration adopts the
    // table rather than recreating it.
    expect(Number(scalar(db, "SELECT SUM(estimated_cents) FROM cost_reservations"))).toBe(2499);
    expect(Number(scalar(db, "SELECT COUNT(*) FROM cost_reservations"))).toBe(1);
    // …and the migration is now the recorded owner.
    expect(
      db.all(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).map((row) => String(row["id"])),
    ).toEqual(["0501", "0502"]);

    expect(migrate(db, costLedgerMigrations).applied).toEqual([]);
    db.close();
  });

  it("refuses a drifted ledger table loudly instead of running the gate on it", () => {
    const db = freshDb();
    db.exec("CREATE TABLE cost_reservations (id TEXT PRIMARY KEY, provider TEXT NOT NULL);");

    expect(() => migrate(db, costLedgerMigrations)).toThrow(/does not match the canonical schema/);
    expect(
      db.get(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = '0501'`),
    ).toBeUndefined();
    expect(columns(db, COST_RESERVATIONS_TABLE)).toEqual(["id", "provider"]);
    db.close();
  });

  it("rolls both tables back (down SQL is present for the whole band)", () => {
    const db = freshDb();
    migrate(db, MIGRATIONS);

    const rolled = migrate(db, MIGRATIONS, { rollback: true, rollbackTo: ["0501", "0502"] });
    expect(rolled.rolledBack).toEqual(["0502", "0501"]);
    for (const table of [COST_RESERVATIONS_TABLE, COST_QUOTA_USAGE_TABLE]) {
      expect(db.get("SELECT name FROM sqlite_master WHERE name = ?", table)).toBeUndefined();
    }
    db.close();
  });
});
