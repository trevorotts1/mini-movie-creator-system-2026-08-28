/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, migrate, MIGRATIONS, type SqliteDatabase } from "@mmcs/database";
import { CostLedger } from "./ledger.js";
import { createCostEngineSchema } from "./schema.js";

/**
 * SKR-010 — the $25 cumulative spend gate is only real if the ledger lives
 * in the migrated production database.
 *
 * The defect: `new CostLedger` was constructed only in tests and a scratch
 * temp DB, and its tables came from `createCostEngineSchema` rather than
 * from `MIGRATIONS` — so a production database that was migrated but never
 * handed to the helper had no durable home for accumulated spend, and a
 * restart could reset the gate. These tests drive the ledger over a database
 * created ONLY by the migration registry, then prove the accumulated spend
 * survives a restart of that database.
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-cost-ledger-migrated-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(name: string): SqliteDatabase {
  return connectSqlite({ path: join(dir, name) });
}

function scalar(db: SqliteDatabase, sql: string): unknown {
  const row = db.get(sql);
  return row === undefined ? undefined : Object.values(row)[0];
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => String(row["name"]));
}

describe("cost ledger over a migrated production database", () => {
  it("gets its tables from the migration registry alone (no createCostEngineSchema call)", () => {
    const db = openDb("migrated-only.db");
    migrate(db, MIGRATIONS);

    expect(tableNames(db)).toContain("cost_reservations");
    expect(tableNames(db)).toContain("cost_quota_usage");

    const ledger = new CostLedger(db, { now: () => "2026-08-29T00:00:00.000Z" });
    const decision = ledger.reserve({
      provider: "agnes",
      providerModel: "agnes-video-2.5-flash",
      estimatedUsd: 10,
      jobId: "job-1",
    });
    expect(decision.outcome).toBe("approved");
    if (decision.outcome === "approved") ledger.commit(decision.reservation.id, 10);
    expect(ledger.projectedUsd).toBeCloseTo(10, 10);
    db.close();
  });

  it("keeps accumulated spend and the gate across a restart (fresh connection, re-migrate)", () => {
    const path = join(dir, "restart.db");
    const first = connectSqlite({ path });
    migrate(first, MIGRATIONS);
    const ledger = new CostLedger(first, { now: () => "2026-08-29T00:00:00.000Z" });
    const decision = ledger.reserve({
      provider: "agnes",
      providerModel: "agnes-video-2.5-flash",
      estimatedUsd: 24.99,
      jobId: "job-restart",
    });
    expect(decision.outcome).toBe("approved");
    if (decision.outcome === "approved") ledger.commit(decision.reservation.id, 24.99);
    first.close();

    // RESTART: a brand-new connection over the same database file, migrated
    // again (idempotent) and never handed to createCostEngineSchema.
    const second = connectSqlite({ path });
    expect(migrate(second, MIGRATIONS).applied).toEqual([]);
    const restarted = new CostLedger(second, { now: () => "2026-08-29T01:00:00.000Z" });
    expect(restarted.projectedUsd).toBeCloseTo(24.99, 10);

    // The wall still holds after the restart: another dollar would cross $25.
    const secondDecision = restarted.reserve({
      provider: "agnes",
      providerModel: "agnes-video-2.5-flash",
      estimatedUsd: 1,
      jobId: "job-after-restart",
    });
    expect(secondDecision.outcome).toBe("requires_approval");
    // The declined request reserved nothing: the ledger still holds exactly
    // the one committed row from before the restart.
    expect(restarted.list({ status: "reserved" })).toHaveLength(0);
    expect(restarted.list({ status: "committed" })).toHaveLength(1);
    second.close();
  });

  it("adopts a database whose ledger tables the ad-hoc helper created first", () => {
    const db = openDb("helper-first.db");
    createCostEngineSchema(db);
    db.prepare(
      `INSERT INTO cost_reservations (
         id, provider, provider_model, kind, status, estimated_cents, created_at, updated_at
       ) VALUES ('res-legacy', 'agnes', 'agnes-video-2.5-flash', 'paid', 'reserved', 2499, ?, ?)`,
    ).run("2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");

    const applied = migrate(db, MIGRATIONS).applied;
    expect(applied).toContain("0501");
    expect(applied).toContain("0502");

    const ledger = new CostLedger(db);
    expect(ledger.projectedUsd).toBeCloseTo(24.99, 10);
    // The helper stays idempotent over the migrated schema (callers that ran
    // it after `migrate` must not break).
    createCostEngineSchema(db);
    expect(Number(scalar(db, "SELECT COUNT(*) FROM cost_reservations"))).toBe(1);
    db.close();
  });
});
