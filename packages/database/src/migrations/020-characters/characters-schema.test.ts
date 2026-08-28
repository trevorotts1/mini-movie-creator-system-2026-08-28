/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, MIGRATIONS_TABLE, migrate } from "../index.js";

/**
 * Schema-introspection tests for band `020_` (CORE-005): the migration
 * registry applies the character/location/appearance band and every spec §9
 * durable-GHL-linkage column exists at the SQL level.
 */
describe("020-characters band", () => {
  let dir: string;
  let db: SqliteDatabase;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mmcs-db-band020-"));
    db = connectSqlite({ path: join(dir, "band.db") });
    migrate(db, MIGRATIONS);
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function columnsOf(table: string): string[] {
    return db.all(`PRAGMA table_info(${table})`).map((r) => String(r["name"]));
  }

  it("applies band 0201–0204 once and records the ledger", () => {
    const ledger = db.all(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).map((r) => String(r["id"]));
    expect(ledger).toEqual(["0201", "0202", "0203", "0204"]);
    // Idempotent second run.
    expect(migrate(db, MIGRATIONS).applied).toEqual([]);
  });

  it("creates all CORE-005 tables", () => {
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((r) => String(r["name"]));
    for (const table of [
      "characters",
      "character_identity_versions",
      "character_identity_assets",
      "character_appearance_versions",
      "locations",
      "location_assets",
      "props",
      "prop_assets",
    ]) {
      expect(tables).toContain(table);
    }
  });

  it("characters table carries the stable-ID key and lifecycle columns", () => {
    const columns = columnsOf("characters");
    for (const column of ["character_id", "display_name", "state", "voice_profile_id", "created_at", "updated_at"]) {
      expect(columns).toContain(column);
    }
  });

  it("identity + appearance versions carry immutable-history tables with GHL linkage on assets (spec §9)", () => {
    for (const column of ["ghl_file_id", "ghl_folder_id", "ghl_url", "sha256"]) {
      expect(columnsOf("character_identity_assets")).toContain(column);
      expect(columnsOf("location_assets")).toContain(column);
      expect(columnsOf("prop_assets")).toContain(column);
    }
    const appearanceColumns = columnsOf("character_appearance_versions");
    for (const column of [
      "character_id",
      "version_label",
      "hair_version",
      "wardrobe_version",
      "base_identity_version_id",
      "effective_episode",
      "effective_time",
      "state",
    ]) {
      expect(appearanceColumns).toContain(column);
    }
    // Immutability triggers exist.
    const triggers = db
      .all("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .map((r) => String(r["name"]));
    expect(triggers).toContain("character_identity_versions_no_update");
    expect(triggers).toContain("character_identity_versions_no_delete");
    expect(triggers).toContain("character_appearance_versions_no_update");
    expect(triggers).toContain("character_appearance_versions_no_delete");
  });

  it("locations carry approved angle kinds and day/night states", () => {
    const angleColumns = columnsOf("location_assets");
    expect(angleColumns).toContain("angle_kind");
    expect(angleColumns).toContain("time_of_day");
  });

  it("rollback of band 020_ drops every table and trigger cleanly", () => {
    const scratch = connectSqlite({ path: join(dir, "rollback.db") });
    migrate(scratch, MIGRATIONS);
    migrate(scratch, MIGRATIONS, { rollback: true });
    const leftovers = scratch
      .all("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index') AND name NOT LIKE 'sqlite_%'")
      .map((r) => String(r["name"]));
    expect(leftovers).toEqual([MIGRATIONS_TABLE]);
    scratch.close();
  });
});