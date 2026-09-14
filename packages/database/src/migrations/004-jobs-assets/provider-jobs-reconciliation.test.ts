/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS_TABLE } from "../types.js";
import { migrate } from "../runner.js";
import { jobsAssetsMigrations, providerJobsTableSql } from "./index.js";

/**
 * SKR-006 — one authoritative `provider_jobs` shape.
 *
 * The defect these tests pin down: the Agnes video job store
 * (`packages/providers/src/agnes/video/submit/store.ts`) self-healed a
 * `ref`-keyed 7-column `provider_jobs` with `CREATE TABLE IF NOT EXISTS`,
 * while migration `0401` declared a 20-column, `id`-keyed, STRICT table
 * with a bare `CREATE TABLE`. Migration first → the store threw "no column
 * named ref"; self-heal first → the migration aborted. Both orders must now
 * work, and a shape the migration does not own must fail loudly rather than
 * be accepted because `IF NOT EXISTS` saw a name it recognised.
 *
 * The legacy DDL below is a deliberate COPY of the Agnes store's `TABLE_SQL`
 * — that second copy IS the defect, so the test fixtures it verbatim.
 */
const LEGACY_AGNES_PROVIDER_JOBS_SQL = `
CREATE TABLE IF NOT EXISTS provider_jobs (
  ref TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_task_id TEXT,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const REF = "S01E03:SC04:SH07";
const CREATED_AT = "2026-08-28T10:00:00.000Z";
const UPDATED_AT = "2026-08-28T10:05:00.000Z";

function freshDb(): SqliteDatabase {
  return connectSqlite({ path: ":memory:" });
}

function columns(db: SqliteDatabase, table: string): string[] {
  return db.all(`PRAGMA table_info(${table})`).map((row) => String(row["name"]));
}

function tableSql(db: SqliteDatabase, table: string): string {
  return String(
    db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.["sql"] ?? "",
  );
}

function scalar(db: SqliteDatabase, sql: string): unknown {
  const row = db.get(sql);
  return row === undefined ? undefined : Object.values(row)[0];
}

/** Seed the legacy table exactly as the Agnes store's self-heal would. */
function seedLegacyTable(db: SqliteDatabase, payload: Record<string, unknown>, ref = REF): void {
  db.exec(LEGACY_AGNES_PROVIDER_JOBS_SQL);
  db.prepare(
    `INSERT INTO provider_jobs (ref, provider, provider_task_id, state, payload, created_at, updated_at)
     VALUES (?, 'agnes', ?, ?, ?, ?, ?)`,
  ).run(
    ref,
    typeof payload["providerJobId"] === "string" ? payload["providerJobId"] : null,
    String(payload["state"] ?? "PLANNED"),
    JSON.stringify(payload),
    CREATED_AT,
    UPDATED_AT,
  );
}

const ADOPTABLE_PAYLOAD: Record<string, unknown> = {
  ref: REF,
  state: "SUBMITTED",
  requestHash: "sha256:deadbeef",
  provider: "agnes",
  model: "agnes-video-2.5-flash",
  providerJobId: "agnes-video-100001",
  submitRequest: { mode: "keyframe", seconds: "5", size: "720P" },
  promptCharacterCount: 214,
  estimatedCostUsd: 0.35,
  budgetReservationId: "res-0001",
  submittedAt: "2026-08-28T10:01:00.000Z",
  lastPolledAt: "2026-08-28T10:02:00.000Z",
  resultUrls: ["https://agnes.invalid/dl/1.mp4", "https://agnes.invalid/dl/2.mp4"],
  archivalStatus: "ARCHIVING",
  retryCount: 2,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

describe("0401 — adopting the legacy ref-keyed provider_jobs (self-heal ran first)", () => {
  it("migrates without aborting and copies every legacy row into the canonical shape", () => {
    const db = freshDb();
    seedLegacyTable(db, ADOPTABLE_PAYLOAD);

    const result = migrate(db, jobsAssetsMigrations);
    expect(result.applied).toEqual(["0401", "0402"]);

    const row = db.get("SELECT * FROM provider_jobs WHERE id = ?", REF);
    expect(row).toBeDefined();
    // Identity: the legacy ref is the durable job reference, so it is the id
    // AND the idempotency key (the store's ON CONFLICT(ref) dedupe).
    expect(String(row?.["id"])).toBe(REF);
    expect(String(row?.["idempotency_key"])).toBe(REF);
    expect(String(row?.["request_hash"])).toBe("sha256:deadbeef");
    expect(String(row?.["provider"])).toBe("agnes");
    expect(String(row?.["provider_model"])).toBe("agnes-video-2.5-flash");
    expect(String(row?.["provider_task_id"])).toBe("agnes-video-100001");
    expect(String(row?.["status"])).toBe("SUBMITTED");
    expect(String(row?.["submitted_at"])).toBe("2026-08-28T10:01:00.000Z");
    expect(String(row?.["polled_at"])).toBe("2026-08-28T10:02:00.000Z");
    expect(String(row?.["result_url"])).toBe("https://agnes.invalid/dl/1.mp4");
    // Legacy "ARCHIVING" has no canonical spelling; the canonical
    // "IN_PROGRESS" is the same fact, not a guess.
    expect(String(row?.["archival_status"])).toBe("IN_PROGRESS");
    expect(Number(row?.["retry_count"])).toBe(2);
    expect(Number(row?.["estimated_cost_usd"])).toBeCloseTo(0.35);
    expect(String(row?.["created_at"])).toBe(CREATED_AT);
    expect(String(row?.["updated_at"])).toBe(UPDATED_AT);
    // No legacy byte is dropped: the payload lands verbatim in request_params.
    const payload = JSON.parse(String(row?.["request_params"])) as Record<string, unknown>;
    expect(payload).toEqual(ADOPTABLE_PAYLOAD);

    // The adopted scratch table is gone and the canonical table is STRICT.
    expect(
      db.get("SELECT name FROM sqlite_master WHERE name = 'provider_jobs_legacy_0401'"),
    ).toBeUndefined();
    expect(tableSql(db, "provider_jobs")).toContain("STRICT");
    expect(columns(db, "provider_jobs")).toContain("estimated_cost_usd");
    expect(
      db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_provider_jobs_idempotency'"),
    ).toBeDefined();
    db.close();
  });

  it("is idempotent: the adopted database re-runs cleanly", () => {
    const db = freshDb();
    seedLegacyTable(db, ADOPTABLE_PAYLOAD);
    migrate(db, jobsAssetsMigrations);

    expect(migrate(db, jobsAssetsMigrations).applied).toEqual([]);
    expect(Number(scalar(db, "SELECT COUNT(*) FROM provider_jobs"))).toBe(1);
    db.close();
  });

  it("keeps rows when the self-heal DDL runs AFTER the migration (IF NOT EXISTS is a no-op)", () => {
    const db = freshDb();
    migrate(db, jobsAssetsMigrations);
    db.prepare(
      `INSERT INTO provider_jobs (id, request_hash, provider, provider_model, request_params, created_at, updated_at)
       VALUES (?, 'sha256:1', 'agnes', 'agnes-video-2.5-flash', '{}', ?, ?)`,
    ).run(REF, CREATED_AT, UPDATED_AT);

    db.exec(LEGACY_AGNES_PROVIDER_JOBS_SQL); // the store's constructor, post-migration

    // The store's CREATE TABLE IF NOT EXISTS cannot replace the canonical
    // table; the shape the migration owns survives.
    expect(columns(db, "provider_jobs")).toContain("request_hash");
    expect(columns(db, "provider_jobs")).not.toContain("payload");
    expect(Number(scalar(db, "SELECT COUNT(*) FROM provider_jobs"))).toBe(1);
    db.close();
  });

  it("refuses legacy rows whose state is outside the §18 machine, changing nothing", () => {
    const db = freshDb();
    seedLegacyTable(db, { ...ADOPTABLE_PAYLOAD, state: "ALMOST_DONE" });

    expect(() => migrate(db, jobsAssetsMigrations)).toThrow(/outside the spec §18 machine/);
    // Atomic: the legacy table still holds its row and 0401 is not recorded.
    expect(Number(scalar(db, "SELECT COUNT(*) FROM provider_jobs"))).toBe(1);
    expect(columns(db, "provider_jobs")).toContain("ref");
    expect(
      db.get(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = '0401'`),
    ).toBeUndefined();
    db.close();
  });

  it("refuses a legacy payload that is not valid JSON rather than dropping the audit record", () => {
    const db = freshDb();
    seedLegacyTable(db, ADOPTABLE_PAYLOAD);
    db.exec("UPDATE provider_jobs SET payload = 'not json at all'");

    expect(() => migrate(db, jobsAssetsMigrations)).toThrow(/not valid JSON/);
    expect(columns(db, "provider_jobs")).toContain("ref");
    db.close();
  });

  it("never fabricates money or a state from a legacy payload of the wrong JSON type", () => {
    const db = freshDb();
    seedLegacyTable(db, {
      ref: REF,
      state: "PLANNED",
      requestHash: "sha256:beef",
      provider: "agnes",
      model: "agnes-video-2.5",
      estimatedCostUsd: "0.35", // a string: recorded by a caller, not a number
      retryCount: "3",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    migrate(db, jobsAssetsMigrations);

    const row = db.get("SELECT * FROM provider_jobs WHERE id = ?", REF);
    expect(row?.["estimated_cost_usd"]).toBeNull();
    expect(Number(row?.["retry_count"])).toBe(0);
    expect(String(row?.["archival_status"])).toBe("PENDING");
    expect(String(row?.["provider_model"])).toBe("agnes-video-2.5");
    db.close();
  });

  it("names legacy rows it cannot map instead of coercing a SUBMITTED job", () => {
    const db = freshDb();
    seedLegacyTable(db, { ...ADOPTABLE_PAYLOAD, archivalStatus: "MAYBE_LATER" });

    expect(() => migrate(db, jobsAssetsMigrations)).toThrow(/archival status the canonical enum cannot express/);
    expect(columns(db, "provider_jobs")).toContain("ref");
    db.close();
  });
});

describe("0401 — existing tables the migration did not create", () => {
  it("accepts a canonical table that exists without a ledger row", () => {
    const db = freshDb();
    db.exec(providerJobsTableSql());
    db.prepare(
      `INSERT INTO provider_jobs (id, request_hash, provider, provider_model, request_params, created_at, updated_at)
       VALUES ('job-existing', 'sha256:1', 'kie', 'seedance-2-mini', '{}', ?, ?)`,
    ).run(CREATED_AT, UPDATED_AT);

    expect(migrate(db, jobsAssetsMigrations).applied).toEqual(["0401", "0402"]);
    expect(Number(scalar(db, "SELECT COUNT(*) FROM provider_jobs"))).toBe(1);
    expect(columns(db, "provider_jobs")).toContain("request_hash");
    db.close();
  });

  it("refuses a drifted table loudly and records nothing", () => {
    const db = freshDb();
    db.exec("CREATE TABLE provider_jobs (id TEXT PRIMARY KEY, whatever TEXT);");

    expect(() => migrate(db, jobsAssetsMigrations)).toThrow(/does not match the canonical schema/);
    expect(db.get(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = '0401'`)).toBeUndefined();
    expect(columns(db, "provider_jobs")).toEqual(["id", "whatever"]);
    db.close();
  });

  it("refuses a table carrying both the canonical id and the legacy ref key", () => {
    const db = freshDb();
    db.exec("CREATE TABLE provider_jobs (id TEXT PRIMARY KEY, ref TEXT);");

    expect(() => migrate(db, jobsAssetsMigrations)).toThrow(/ambiguous identity/);
    expect(columns(db, "provider_jobs")).toEqual(["id", "ref"]);
    db.close();
  });

  it("refuses a half-legacy table (ref key but missing legacy columns) with a named column", () => {
    const db = freshDb();
    db.exec("CREATE TABLE provider_jobs (ref TEXT PRIMARY KEY, provider TEXT NOT NULL);");

    expect(() => migrate(db, jobsAssetsMigrations)).toThrow(/missing column\(s\): provider_task_id/);
    expect(columns(db, "provider_jobs")).toEqual(["ref", "provider"]);
    db.close();
  });

  it("rolls 0401 back cleanly after an adoption (indexes and table dropped)", () => {
    const db = freshDb();
    seedLegacyTable(db, ADOPTABLE_PAYLOAD);
    migrate(db, jobsAssetsMigrations);

    const rolled = migrate(db, jobsAssetsMigrations, { rollback: true, rollbackTo: ["0401"] });
    expect(rolled.rolledBack).toEqual(["0401"]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'provider_jobs'")).toBeUndefined();
    expect(
      db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_provider_jobs_status'"),
    ).toBeUndefined();
    db.close();
  });
});
